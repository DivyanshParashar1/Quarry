import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { emailDraftSchema } from '@jobforge/plugin-sdk';
import { fakeGmail } from '@jobforge/plugin-sdk/testing';
import {
  claimAction,
  getContact,
  getReviewItem,
  getThread,
  listContacts,
  listReviewItems,
  recordEmailBounce,
  recordPosting,
  setContactHints,
  setInferredEmail,
  sql,
  upsertCompany,
  upsertContact,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import actor from '@jobforge/actor-gmail-outreach';
import tracker from '@jobforge/tracker-gmail';
import enricher from '@jobforge/enricher-contacts-pattern';
import { enrichContacts } from './contacts-runner.js';
import { createDnsResolver } from './capabilities.js';
import { normalizePosting } from './normalize.js';
import {
  approveReviewItem,
  draftDueFollowups,
  draftOutreach,
  editDraft,
  OutreachError,
  pollTracker,
  rejectReviewItem,
  runSendTick,
  type OutreachDeps,
} from './outreach.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();
const DAY = 86_400_000;

describe.skipIf(!adminUrl)('outreach engine (postgres)', () => {
  let t: TestDb;
  let deps: OutreachDeps;
  let clock = new Date('2026-10-05T09:00:00Z');
  const gmail = fakeGmail('asha@gmail.com');
  const ids: Record<string, string> = {};
  const provider = createFakeProvider((req) => {
    const first = /^(\S+)/.exec(req.prompt.split('\n')[1] ?? '')?.[1] ?? 'there';
    return /follow-up #/.test(req.prompt)
      ? { subject: 'x', body: `Hi ${first}, a quick nudge on my note below in case it got buried. Happy to keep it to 15 minutes.`, fact_ids: [], confidence: 0.9 }
      : {
          subject: 'Payments ledger role',
          body: `Hi ${first},\n\nI saw the Backend Engineer opening on your payments team. I built a Go ledger service handling 2M transactions a day. Would a 15-minute chat this week work?`,
          fact_ids: ['exp-ledger'],
          confidence: 0.9,
        };
  });

  const config = parseAppConfig({
    outreach: { dailyCap: 3, perCompanyPerWeek: 2, spacingMinutes: [5, 5] },
    plugins: { 'actor-gmail-outreach': { senderName: 'Asha Rao', signature: 'Asha' } },
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    for (const p of [actor, tracker, enricher]) registry.register(p, config.plugins[p.manifest.id] ?? {});
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      gmail,
      dns: createDnsResolver({ resolver: { resolveMx: async (d: string) => (d === 'acme.com' ? [{ exchange: 'aspmx.l.google.com', priority: 1 }] : []) } }),
      policy: config.outreach,
      now: () => clock,
      random: () => 0.5,
    };
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' });
    ids.company = companyId;
    const raw = {
      externalId: 'j1',
      url: 'https://x.example/j1',
      applyUrl: null,
      title: 'Backend Engineer',
      locations: ['Bengaluru'],
      remotePolicy: null,
      department: null,
      descriptionHtml: '<p>Payments ledger in Go</p>',
      postedAt: null,
      payload: {},
    };
    ids.job = (
      await recordPosting(
        t.db,
        { ...normalizePosting(raw, 'Acme'), companyId },
        { sourcePlugin: 'source-test', companySourceId: null, externalId: 'j1', url: raw.url, payload: {} },
        new Date(),
      )
    ).jobId;
    ids.jane = (await upsertContact(t.db, { companyId, name: 'Jane Doe', role: 'Engineering Manager', email: 'jdoe@acme.com' })).contact.id;
    ids.raj = (await upsertContact(t.db, { companyId, name: 'Raj Patel', role: 'Staff Engineer' })).contact.id;
    ids.sam = (await upsertContact(t.db, { companyId, name: 'Sam Lee', role: 'Recruiter', email: 'sam@acme.com' })).contact.id;
    await loadProfileData(
      t.db,
      [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day', metrics: {}, tags: [] }],
      preferencesSchema.parse({ roles: ['Backend Engineer'] }),
    );
  });
  afterAll(async () => t?.drop());

  it('enriches the contact without an address from the known one', async () => {
    const [s] = await enrichContacts(deps);
    expect(s).toMatchObject({ company: 'Acme', emailDomain: 'acme.com', pattern: '{f}{last}', emailsSet: 1 });
    expect((await getContact(t.db, ids.raj!))!).toMatchObject({ email: 'rpatel@acme.com', emailSource: 'pattern:{f}{last}' });
    expect((await getContact(t.db, ids.jane!))!.emailSource).toBe('manual');
  });

  it('drafts into the review queue (no side effects) and refuses duplicates', async () => {
    const item = await draftOutreach(deps, { contactId: ids.raj!, jobId: ids.job! });
    ids.rajItem = item.id;
    expect(item).toMatchObject({ status: 'pending', kind: 'outreach', companyId: ids.company, jobId: ids.job });
    const draft = emailDraftSchema.parse(item.draft);
    expect(draft).toMatchObject({ to: 'rpatel@acme.com', subject: 'Payments ledger role', factIds: ['exp-ledger'] });
    expect(draft.body).toMatch(/^Hi Raj,/);
    expect(draft.body.endsWith('\n\nAsha')).toBe(true);
    expect(gmail.messages).toHaveLength(0);
    await expect(draftOutreach(deps, { contactId: ids.raj! })).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('edits only pending drafts and validates edits', async () => {
    const edited = await editDraft(t.db, ids.rajItem!, { subject: 'Your payments ledger team' });
    expect((edited.draft as { subject: string }).subject).toBe('Your payments ledger team');
    expect((edited.originalDraft as { subject: string }).subject).toBe('Payments ledger role');
    await expect(editDraft(t.db, ids.rajItem!, { to: 'not-an-email' })).rejects.toThrow();
    await expect(editDraft(t.db, ids.rajItem!, { bcc: 'x@y.z' })).rejects.toThrow(/Unrecognized key/);
  });

  it('dry run shows what would be sent and keeps the item approved', async () => {
    await approveReviewItem(t.db, deps.policy, ids.rajItem!);
    await expect(editDraft(t.db, ids.rajItem!, { subject: 'late' })).rejects.toMatchObject({ code: 'invalid_state' });
    const r = await runSendTick(deps);
    expect(r.mode).toBe('dry_run');
    expect(r.outcomes).toMatchObject([{ ok: true, to: 'rpatel@acme.com', result: { dryRun: true } }]);
    expect(gmail.messages).toHaveLength(0);
    expect((await getReviewItem(t.db, ids.rajItem!))!.status).toBe('approved');
  });

  it('live: sends once, records the thread, then waits for the spacing window', async () => {
    deps.dryRun = false;
    const r = await runSendTick(deps);
    expect(r.outcomes).toMatchObject([{ ok: true, result: { dryRun: false, deduplicated: false } }]);
    expect(gmail.sent()).toHaveLength(1);
    expect(gmail.sent()[0]!.headers.subject).toBe('Your payments ledger team');
    const item = (await getReviewItem(t.db, ids.rajItem!))!;
    expect(item.status).toBe('executed');
    const [thread] = await t.db.execute<{ id: string; state: string; next: string; mids: string[] }>(
      sql`select id, state, next_followup_at as next, message_ids as mids from outreach_threads`,
    );
    expect(thread!.state).toBe('sent');
    expect(new Date(thread!.next).getTime()).toBe(clock.getTime() + 5 * DAY);
    ids.rajThread = thread!.id;

    // A second approved email must wait for the randomized gap.
    const jane = await draftOutreach(deps, { contactId: ids.jane!, jobId: ids.job! });
    ids.janeItem = jane.id;
    await approveReviewItem(t.db, deps.policy, jane.id);
    const waiting = await runSendTick(deps);
    expect(waiting.waitingUntil?.getTime()).toBe(clock.getTime() + 5 * 60_000);
    expect(gmail.sent()).toHaveLength(1);
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect((await runSendTick(deps)).outcomes[0]!.ok).toBe(true);
    expect(gmail.sent()).toHaveLength(2);
  });

  it('enforces 2 people per company per week unless explicitly overridden', async () => {
    const sam = await draftOutreach(deps, { contactId: ids.sam! });
    ids.samItem = sam.id;
    await expect(approveReviewItem(t.db, deps.policy, sam.id)).rejects.toMatchObject({ code: 'company_cap' });
    const ok = await approveReviewItem(t.db, deps.policy, sam.id, { overrideCompanyCap: true });
    expect(ok.overrideCompanyCap).toBe(true);
  });

  it('a retry after a crash never sends twice', async () => {
    clock = new Date(clock.getTime() + 6 * 60_000);
    // Crash after Gmail accepted the message but before the DB recorded it:
    // the action row is still "started" and the message is already in Sent.
    const item = (await getReviewItem(t.db, ids.samItem!))!;
    const draft = emailDraftSchema.parse(item.draft);
    const { action } = await claimAction(t.db, { reviewItemId: item.id, pluginId: item.pluginId, idempotencyKey: `send:${item.id}`, dryRun: false });
    expect(action.status).toBe('started');
    await actor.execute(
      { config: config.plugins['actor-gmail-outreach'] as never, http: undefined as never, log: silentLogger, signal: new AbortController().signal, dryRun: false, gmail },
      { reviewItemId: item.id, draft } as never,
      `send:${item.id}`,
    );
    expect(gmail.sent()).toHaveLength(3);

    const r = await runSendTick(deps);
    expect(r.outcomes[0]).toMatchObject({ ok: true, result: { deduplicated: true } });
    expect(gmail.sent()).toHaveLength(3); // not resent
    expect((await getReviewItem(t.db, item.id))!.status).toBe('executed');
  });

  it('stops at the daily cap', async () => {
    clock = new Date(clock.getTime() + 6 * 60_000);
    const { contact } = await upsertContact(t.db, { companyId: ids.company!, name: 'Dee Kay', email: 'dee@acme.com' });
    const item = await draftOutreach(deps, { contactId: contact.id });
    await approveReviewItem(t.db, deps.policy, item.id, { overrideCompanyCap: true });
    const r = await runSendTick(deps);
    expect(r).toMatchObject({ dailyCapReached: true, sentLast24h: 3, outcomes: [] });
    ids.deeItem = item.id;
  });

  it('retries a failing send, then gives up after 3 attempts', async () => {
    clock = new Date(clock.getTime() + DAY);
    for (let i = 1; i <= 3; i++) {
      gmail.failNextSend = new Error('Gmail 500');
      const r = await runSendTick(deps);
      expect(r.outcomes[0]).toMatchObject({ ok: false, error: 'Gmail 500' });
      clock = new Date(clock.getTime() + 60_000);
    }
    expect((await getReviewItem(t.db, ids.deeItem!))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/gave up after 3/) });
  });

  it('drafts a follow-up when due and sends it in the same thread', async () => {
    clock = new Date(new Date('2026-10-05T09:00:00Z').getTime() + 5 * DAY + 3600_000);
    const res = await draftDueFollowups(deps);
    expect(res.errors).toEqual([]);
    expect(res.drafted).toBeGreaterThanOrEqual(1);
    const [fu] = await listReviewItems(t.db, { kind: ['followup'], status: ['pending'] });
    expect(fu!.threadId).toBe(ids.rajThread);
    expect(emailDraftSchema.parse(fu!.draft)).toMatchObject({ subject: 'Re: Your payments ledger team', to: 'rpatel@acme.com' });
    expect((await draftDueFollowups(deps)).drafted).toBe(0); // not drafted twice

    await approveReviewItem(t.db, deps.policy, fu!.id);
    const before = gmail.sent().length;
    const r = await runSendTick(deps);
    expect(r.outcomes[0]!.ok).toBe(true);
    const sent = gmail.sent()[before]!;
    const first = gmail.sent()[0]!;
    expect(sent.threadId).toBe(first.threadId);
    expect(sent.headers['in-reply-to']).toBe(first.headers['message-id']);
    const thread = (await getThread(t.db, ids.rajThread!))!;
    expect(thread.followupsSent).toBe(1);
    expect(thread.messageIds).toHaveLength(2);
    expect(thread.nextFollowupAt!.getTime()).toBe(clock.getTime() + 7 * DAY);
  });

  it('a reply closes the thread and cancels queued follow-ups; a bounce marks the contact', async () => {
    // Queue a second follow-up for Raj, then he replies.
    clock = new Date(clock.getTime() + 8 * DAY);
    await draftDueFollowups(deps);
    const pending = await listReviewItems(t.db, { kind: ['followup'], status: ['pending'] });
    expect(pending.some((p) => p.threadId === ids.rajThread)).toBe(true);

    const rajGmailThread = gmail.sent()[0]!.threadId;
    const janeGmailThread = gmail.sent()[1]!.threadId;
    gmail.receive({ threadId: rajGmailThread, from: 'Raj Patel <rpatel@acme.com>', subject: 'Re: Your payments ledger team', body: 'Sure, Thursday?', at: new Date(clock.getTime() - 3600_000) });
    gmail.receive({ threadId: 'unrelated', from: 'friend@x.com', subject: 'lunch?', at: new Date(clock.getTime() - 3600_000) });
    gmail.receive({
      threadId: janeGmailThread,
      from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      subject: 'Delivery Status Notification (Failure)',
      headers: { 'x-failed-recipients': 'jdoe@acme.com' },
      at: new Date(clock.getTime() - 3000_000),
    });
    const s = await pollTracker(deps, { since: new Date(clock.getTime() - 2 * DAY) });
    expect(s).toEqual({ inspected: 3, replies: 1, bounces: 1 });
    expect((await getThread(t.db, ids.rajThread!))!).toMatchObject({ state: 'replied', nextFollowupAt: null });
    const after = await listReviewItems(t.db, { kind: ['followup'] });
    expect(after.filter((p) => p.threadId === ids.rajThread && p.status === 'pending')).toEqual([]);
    expect((await getContact(t.db, ids.raj!))!).toMatchObject({ emailConfidence: 1, emailSource: 'reply' });
    expect((await getContact(t.db, ids.jane!))!.status).toBe('bounced');

    // Polling again changes nothing.
    expect(await pollTracker(deps, { since: new Date(clock.getTime() - 2 * DAY) })).toMatchObject({ replies: 0, bounces: 0 });
    // Bounced contacts can't be drafted to.
    await expect(draftOutreach(deps, { contactId: ids.jane!, force: true })).rejects.toBeInstanceOf(OutreachError);
  });

  it('a bounced guessed address moves on to the next candidate, and the person can be asked again', async () => {
    clock = new Date(clock.getTime() + DAY);
    const { contact } = await upsertContact(t.db, { companyId: ids.company!, name: 'Kim Ng' });
    await setInferredEmail(t.db, contact.id, { email: 'kng@acme.com', confidence: 0.6, source: 'pattern:{f}{last}' });
    await setContactHints(t.db, contact.id, {
      emailCandidates: [
        { email: 'kng@acme.com', confidence: 0.6, pattern: '{f}{last}' },
        { email: 'kim.ng@acme.com', confidence: 0.3, pattern: '{first}.{last}' },
      ],
    });
    const item = await draftOutreach(deps, { contactId: contact.id });
    await approveReviewItem(t.db, deps.policy, item.id, { overrideCompanyCap: true });
    expect((await runSendTick(deps)).outcomes[0]).toMatchObject({ ok: true });
    const sent = gmail.sent().at(-1)!;
    expect(sent.headers.to).toContain('kng@acme.com');

    gmail.receive({
      threadId: sent.threadId,
      from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      subject: 'Delivery Status Notification (Failure)',
      headers: { 'x-failed-recipients': 'kng@acme.com' },
      at: clock,
    });
    expect(await pollTracker(deps, { since: new Date(clock.getTime() - 3600_000) })).toMatchObject({ bounces: 1 });
    expect((await getContact(t.db, contact.id))!).toMatchObject({
      status: 'active',
      email: 'kim.ng@acme.com',
      emailConfidence: 0.3,
      emailSource: 'pattern:{first}.{last}',
      bouncedEmails: ['kng@acme.com'],
    });
    // Re-enrichment must not bring the bounced address back.
    expect(await setInferredEmail(t.db, contact.id, { email: 'KNG@acme.com', confidence: 0.6, source: 'pattern:{f}{last}' })).toBe(false);
    // The ask never arrived, so the cooldown doesn't block asking at the new address.
    const again = await draftOutreach(deps, { contactId: contact.id });
    expect(emailDraftSchema.parse(again.draft).to).toBe('kim.ng@acme.com');
    await expect(approveReviewItem(t.db, deps.policy, again.id, { overrideCompanyCap: true })).resolves.toMatchObject({ status: 'approved' });

    // Out of candidates: the contact is bounced for good.
    expect(await recordEmailBounce(t.db, contact.id, 'kim.ng@acme.com')).toEqual({ nextEmail: null });
    expect((await getContact(t.db, contact.id))!.status).toBe('bounced');
  });

  it('reject is final', async () => {
    const { contact } = await upsertContact(t.db, { companyId: ids.company!, name: 'Ola N', email: 'ola@acme.com' });
    const item = await draftOutreach(deps, { contactId: contact.id });
    await rejectReviewItem(t.db, item.id, 'not now');
    await expect(approveReviewItem(t.db, deps.policy, item.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await listContacts(t.db, { company: 'acme' })).length).toBe(6);
  });
});

describe.skipIf(!adminUrl)('outreach: cancel before send (postgres)', () => {
  it('an approved item rejected before its tick is never sent', async () => {
    const t = await createTestDb(adminUrl!);
    try {
      const gmail = fakeGmail('me@x.com');
      const registry = new PluginRegistry();
      const config = parseAppConfig({});
      registry.register(actor, {});
      const { id: companyId } = await upsertCompany(t.db, { name: 'Acme' });
      const { contact } = await upsertContact(t.db, { companyId, name: 'Jane Doe', email: 'jane@acme.com' });
      await loadProfileData(t.db, [], preferencesSchema.parse({}));
      const deps: OutreachDeps = {
        db: t.db,
        registry,
        log: silentLogger,
        limiter: new DomainRateLimiter(),
        dryRun: false,
        gmail,
        policy: config.outreach,
        llm: createLLMClient({
          providers: { 'claude-code': createFakeProvider(() => ({ subject: 'Hello there', body: 'Hi Jane, a short note about the backend role. Would a 15-minute chat work this week?', fact_ids: [], confidence: 0.9 })) },
          defaultProvider: 'claude-code',
        }),
      };
      const item = await draftOutreach(deps, { contactId: contact.id });
      await approveReviewItem(t.db, deps.policy, item.id);
      await rejectReviewItem(t.db, item.id, 'changed my mind');
      const r = await runSendTick(deps);
      expect(r.outcomes).toEqual([]);
      expect(gmail.messages).toHaveLength(0);
    } finally {
      await t.drop();
    }
  });
});

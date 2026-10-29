import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppConfig } from '@quarry/shared';
import { fakeGmail } from '@quarry/plugin-sdk/testing';
import { createReviewItem, getReviewItem, listSentEmails, listThreads, sql, transitionReviewItem, upsertCompany, upsertContact } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { createFakeProvider, createLLMClient } from '@quarry/llm';
import actor from '@quarry/actor-gmail-outreach';
import { cancelScheduled, composeSend, reconcileScheduled, type ComposeDeps } from './compose.js';
import { runSendTick } from './outreach.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

describe.skipIf(!adminUrl)('compose + sent-mail log (postgres)', () => {
  let t: TestDb;
  let gmail: ReturnType<typeof fakeGmail>;
  let deps: ComposeDeps;
  const clock = new Date('2026-10-29T09:00:00Z');
  const config = parseAppConfig({ plugins: { 'actor-gmail-outreach': { senderName: 'Asha Rao', signature: '' } } });
  const pdf = join(mkdtempSync(join(tmpdir(), 'compose-')), 'resume.pdf');
  writeFileSync(pdf, '%PDF-1.4 fake');

  const form = { purpose: 'referral', about: 'Backend role 4411', projectIds: [], projectNotes: '', tone: 'neutral', length: 'medium' };
  const recipient = (over: Record<string, unknown> = {}) => ({
    to: 'jane@acme.com',
    toName: 'Jane Doe',
    company: 'Acme',
    receiverInfo: 'Met at GopherCon',
    subject: 'GopherCon follow-up',
    body: 'Hi Jane, great meeting you at GopherCon. Would you refer me for role 4411?',
    variants: [
      { angle: 'connection', subject: 'GopherCon follow-up', body: 'Hi Jane, great meeting you. Would you refer me?' },
      { angle: 'project', subject: 'Go ledger', body: 'Hi Jane, I built a Go ledger. Would you refer me?' },
    ],
    chosenVariant: 0,
    notes: 'role 4411',
    ...over,
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate sent_emails, actions, outreach_threads, review_items, contacts, companies cascade`);
    gmail = fakeGmail('asha@gmail.com');
    const registry = new PluginRegistry();
    registry.register(actor, config.plugins['actor-gmail-outreach'] ?? {});
    deps = { db: t.db, registry, log: silentLogger, limiter: new DomainRateLimiter(), dryRun: false, gmail, policy: config.outreach, now: () => clock, signature: 'Asha',
      // The actor declares the LLM (for drafting); sending never calls it.
      llm: createLLMClient({ providers: { 'claude-code': createFakeProvider(() => { throw new Error('no LLM calls when sending'); }) }, defaultProvider: 'claude-code' }) };
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('Send: one approved compose item per recipient, sent now, logged with every input', async () => {
    const r = await composeSend(deps, { form, recipients: [recipient({ attachments: [{ filename: 'resume.pdf', contentType: 'application/pdf', path: pdf, resumeVariantId: null }] })] });
    expect(r.results).toMatchObject([{ status: 'sent', to: 'jane@acme.com' }]);
    expect(gmail.sent()).toHaveLength(1);

    const item = (await getReviewItem(t.db, r.results[0]!.reviewItemId!))!;
    expect(item).toMatchObject({ kind: 'compose', status: 'executed', decidedBy: 'human' });
    expect((item.draft as { body: string }).body).toMatch(/refer me for role 4411\?\n\nAsha$/); // signature appended
    expect((item.originalDraft as { body: string }).body).toBe('Hi Jane, great meeting you. Would you refer me?'); // as generated

    const [log] = await listSentEmails(t.db);
    expect(log).toMatchObject({ status: 'sent', source: 'compose', toAddress: 'jane@acme.com', fromAddress: 'asha@gmail.com', batchKey: r.batchKey, contactName: 'Jane Doe', companyName: 'Acme' });
    expect(log!.gmailId).toBeTruthy();
    expect(log!.input).toMatchObject({ form: { about: 'Backend role 4411' }, recipient: { receiverInfo: 'Met at GopherCon', notes: 'role 4411' }, chosenVariant: 0, editedAfterPick: true });
    expect((log!.input as { variants: unknown[] }).variants).toHaveLength(2);
    expect(log!.attachments).toMatchObject([{ filename: 'resume.pdf', size: 13, path: pdf }]);
    expect((log!.attachments as Array<{ sha256: string }>)[0]!.sha256).toHaveLength(64);
    // The named company made a contact, so replies are tracked on a thread.
    expect(log!.threadId).toBeTruthy();
    expect(await listThreads(t.db)).toHaveLength(1);
  });

  it('a referral ask to someone asked within the cooldown is blocked and nothing is sent', async () => {
    await composeSend(deps, { form, recipients: [recipient()] });
    const again = await composeSend(deps, { form, recipients: [recipient(), recipient({ to: 'raj@acme.com', toName: 'Raj' })] });
    expect(again.results[0]).toMatchObject({ status: 'blocked' });
    expect(again.results[0]!.blocking[0]).toMatch(/already asked/);
    expect(again.results[1]!.status).toBe('blocked'); // the batch goes together or not at all
    expect(gmail.sent()).toHaveLength(1);
    // A thank-you to the same person is fine.
    const thanks = await composeSend(deps, { form: { ...form, purpose: 'thanks' }, recipients: [recipient({ subject: 'Thank you', body: 'Hi Jane, thank you for the referral!' })] });
    expect(thanks.results[0]!.status).toBe('sent');
  });

  it('warnings stop the send until the user confirms', async () => {
    const r = await composeSend(deps, { form, recipients: [recipient({ body: 'Hi Jane, my resume is attached.' })] });
    expect(r.results[0]).toMatchObject({ status: 'warnings', warnings: [expect.stringMatching(/attachment/)] });
    expect(gmail.sent()).toHaveLength(0);
    const ok = await composeSend(deps, { form, recipients: [recipient({ body: 'Hi Jane, my resume is attached.' })], ignoreWarnings: true });
    expect(ok.results[0]!.status).toBe('sent');
  });

  it('batch: every recipient gets its own item and log row under one batch key', async () => {
    const r = await composeSend(deps, {
      form,
      recipients: [recipient(), recipient({ to: 'raj@globex.com', toName: 'Raj', company: '', body: 'Hi Raj, would you refer me?' })],
    });
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'sent']);
    const logs = await listSentEmails(t.db);
    expect(new Set(logs.map((l) => l.batchKey))).toEqual(new Set([r.batchKey]));
    expect(logs.find((l) => l.toAddress === 'raj@globex.com')!.contactId).toBeNull(); // no company named: no contact
  });

  it('dry run sends nothing but still logs the mail', async () => {
    const r = await composeSend({ ...deps, dryRun: true }, { form, recipients: [recipient()] });
    expect(r).toMatchObject({ mode: 'dry_run', results: [{ status: 'dry_run' }] });
    expect(gmail.messages).toHaveLength(0);
    const [log] = await listSentEmails(t.db);
    expect(log).toMatchObject({ status: 'dry_run', dryRun: true });
    expect((await getReviewItem(t.db, r.results[0]!.reviewItemId!))!.status).toBe('executed'); // never picked up by a later tick
  });

  it('schedule: a Gmail draft with X-Quarry-Send-At; reconcile marks it sent once the Apps Script sends it', async () => {
    const r = await composeSend(deps, { form, recipients: [recipient()], sendAt: '2026-10-30T03:30:00Z' });
    expect(r.results[0]!.status).toBe('scheduled');
    expect(gmail.sent()).toHaveLength(0);
    const [draftId, draft] = [...gmail.drafts.entries()][0]!;
    expect(draft.headers['x-quarry-send-at']).toBe('2026-10-30T03:30:00.000Z');
    let [log] = await listSentEmails(t.db);
    expect(log).toMatchObject({ status: 'scheduled', gmailDraftId: draftId });
    expect(log!.scheduledFor!.toISOString()).toBe('2026-10-30T03:30:00.000Z');

    expect(await reconcileScheduled(deps)).toMatchObject({ waiting: 1, sent: 0 });
    gmail.sendDraft(draftId, new Date('2026-10-30T03:31:00Z')); // the Apps Script, with Quarry off
    expect(await reconcileScheduled(deps)).toMatchObject({ sent: 1 });
    [log] = await listSentEmails(t.db);
    expect(log).toMatchObject({ status: 'sent' });
    expect(log!.sentAt!.toISOString()).toBe('2026-10-30T03:31:00.000Z');
    expect(log!.threadId).toBeTruthy();
  });

  it('a scheduled mail can be cancelled (draft deleted); one deleted in Gmail reconciles to cancelled', async () => {
    const a = await composeSend(deps, { form, recipients: [recipient()], sendAt: '2026-10-30T03:30:00Z' });
    await cancelScheduled(deps, a.results[0]!.sentEmailId!);
    expect(gmail.drafts.size).toBe(0);
    expect((await listSentEmails(t.db))[0]!.status).toBe('cancelled');

    const b = await composeSend(deps, { form: { ...form, purpose: 'thanks' }, recipients: [recipient()], sendAt: '2026-10-30T03:30:00Z' });
    const [draftId] = [...gmail.drafts.keys()];
    await gmail.deleteDraft!(draftId!);
    expect(await reconcileScheduled(deps)).toMatchObject({ cancelled: 1 });
    expect((await listSentEmails(t.db, { ids: [b.results[0]!.sentEmailId!] }))[0]!.status).toBe('cancelled');
  });

  it('a past schedule time is refused', async () => {
    const r = await composeSend(deps, { form, recipients: [recipient()], sendAt: '2026-10-28T00:00:00Z' });
    expect(r.results[0]).toMatchObject({ status: 'blocked', blocking: ['The scheduled time is in the past'] });
  });

  it('outreach sent by the send tick lands in the log too', async () => {
    const { id: companyId } = await upsertCompany(t.db, { name: 'Initech', domain: 'initech.com' });
    const { contact } = await upsertContact(t.db, { companyId, name: 'Bob', email: 'bob@initech.com' });
    const item = await createReviewItem(t.db, {
      kind: 'outreach',
      pluginId: 'actor-gmail-outreach',
      jobId: null,
      contactId: contact.id,
      companyId,
      draft: { to: 'bob@initech.com', toName: 'Bob', subject: 'Hello', body: 'Hi Bob, a short note about the backend role.', factIds: ['exp-1'], confidence: 0.9 },
    });
    await transitionReviewItem(t.db, item.id, ['pending'], 'approved', { decided: true, decidedBy: 'human' });
    const tick = await runSendTick(deps);
    expect(tick.outcomes[0]!.ok).toBe(true);
    const [log] = await listSentEmails(t.db);
    expect(log).toMatchObject({ source: 'outreach', status: 'sent', toAddress: 'bob@initech.com', input: { factIds: ['exp-1'], confidence: 0.9, decidedBy: 'human' } });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, preferencesSchema } from '@quarry/shared';
import { fakeGmail } from '@quarry/plugin-sdk/testing';
import { getBatchForJob, getReviewItem, listBatchItems, listContacts, recordPosting, setContactHints, upsertCompany, upsertContact } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@quarry/llm';
import gmailActor from '@quarry/actor-gmail-outreach';
import linkedinManual from '@quarry/actor-linkedin-manual';
import { commitContactImport, previewContactImport } from './contact-import/index.js';
import { listLinkedInDrafts, markLinkedInReplied, markLinkedInSent } from './linkedin-manual.js';
import { normalizePosting } from './normalize.js';
import { approveReviewItem, OutreachError, type OutreachDeps } from './outreach.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { approveBatch, fanOutReferrals, rankReferralContacts } from './referrals.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

describe.skipIf(!adminUrl)('manual LinkedIn referrals (postgres)', () => {
  let t: TestDb;
  let deps: OutreachDeps;
  const ids: Record<string, string> = {};
  const config = parseAppConfig({ outreach: { perJobReferralCap: 3, spacingMinutes: [0, 0] } });
  const provider = createFakeProvider((req: ProviderRequest) => {
    const first = /Recipient\n(\S+)/.exec(req.prompt)?.[1] ?? 'there';
    if (/direct message/.test(req.system ?? '')) {
      return {
        text: `Hi ${first}, we connected a while back. I'm applying for the Backend Engineer role (https://boards.greenhouse.io/acme/jobs/b1) and built a Go ledger service handling 2M transactions a day. My resume is attached; would you be open to referring me? Thanks, Divyansh`,
        bullet_id: 'exp-ledger',
        confidence: 0.9,
      };
    }
    if (/connection-request note/.test(req.system ?? '')) {
      return { text: `Hi ${first}, I'm applying for Backend Engineer at Acme and built a Go ledger service. Open to referring me?`, bullet_id: 'exp-ledger', confidence: 0.85 };
    }
    return { subject: 'Referral: Backend Engineer', body: `Hi ${first},\n\nWould you refer me for the Backend Engineer role? I built a Go ledger service.`, bullet_id: 'exp-ledger', confidence: 0.9 };
  });

  async function addJob(externalId: string, title: string): Promise<string> {
    const raw = { externalId, url: `https://boards.greenhouse.io/acme/jobs/${externalId}`, applyUrl: `https://boards.greenhouse.io/acme/jobs/${externalId}`, title, locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
    return (await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: ids.company! }, { sourcePlugin: 's', companySourceId: null, externalId, url: raw.url, payload: {} }, new Date())).jobId;
  }

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    for (const p of [gmailActor, linkedinManual]) registry.register(p);
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      gmail: fakeGmail('me@gmail.com'),
      policy: config.outreach,
    };
    ids.company = (await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' })).id;
    ids.job = await addJob('b1', 'Backend Engineer');
    ids.job2 = await addJob('b2', 'Platform Engineer');
    await loadProfileData(
      t.db,
      [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day', metrics: {}, tags: [] }],
      preferencesSchema.parse({ roles: ['Backend Engineer'], application: { first_name: 'Divyansh' } }),
    );
    // Found earlier by other means: an engineer with a good email, and one with only a LinkedIn profile.
    ids.emailOnly = (await upsertContact(t.db, { companyId: ids.company, name: 'Emma Mail', email: 'emma@acme.com' })).contact.id;
    ids.liOnly = (await upsertContact(t.db, { companyId: ids.company, name: 'Lars Profile', linkedinUrl: 'https://www.linkedin.com/in/lars-profile/', source: 'linkedin' })).contact.id;
    for (const id of [ids.emailOnly, ids.liOnly]) await setContactHints(t.db, id, { roleHint: 'engineer' });
    // The user's own connection, from their LinkedIn export.
    const csv = 'Notes:\n"x"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nCara,Connect,https://www.linkedin.com/in/cara-connect,,Acme,Recruiter,01 Feb 2025\n';
    const p = await previewContactImport(t.db, { data: Buffer.from(csv), filename: 'Connections.csv' });
    await commitContactImport(t.db, p.importId);
    ids.connection = (await listContacts(t.db, { companyId: ids.company })).find((c) => c.name === 'Cara Connect')!.id;
  });
  afterAll(async () => t?.drop());

  it('ranks the imported connection first, even though she is a recruiter', async () => {
    const ranked = rankReferralContacts(await listContacts(t.db, { companyId: ids.company! }), config.outreach.referralMinEmailConfidence);
    expect(ranked.map((c) => c.name)).toEqual(['Cara Connect', 'Emma Mail', 'Lars Profile']);
  });

  it('drafts a message for the connection, an email for the emailable contact, and a note for the LinkedIn-only one', async () => {
    const r = await fanOutReferrals(deps, ids.job!);
    expect(r.drafted.map((d) => [d.channel, d.kind ?? null])).toEqual([
      ['linkedin_manual', 'message'],
      ['email', null],
      ['linkedin_manual', 'note'],
    ]);
    const msg = (await getReviewItem(t.db, r.drafted[0]!.reviewItemId))!;
    expect(msg.pluginId).toBe('actor-linkedin-manual');
    expect(msg.draft).toMatchObject({ kind: 'message', toName: 'Cara Connect', jobUrl: 'https://boards.greenhouse.io/acme/jobs/b1', resumeBulletId: 'exp-ledger' });
    const note = (await getReviewItem(t.db, r.drafted[2]!.reviewItemId))!;
    expect((note.draft as { text: string }).text.length).toBeLessThanOrEqual(300);

    const drafts = await listLinkedInDrafts(t.db, { jobId: ids.job! });
    expect(drafts.map((d) => d.linkedin.kind).sort()).toEqual(['message', 'note']);
  });

  it('"I sent it" records the send (thread, batch counts) from pending or approved; replies stop the batch', async () => {
    const batch = (await getBatchForJob(t.db, ids.job!))!;
    await approveBatch(t.db, config.outreach, batch.id);
    const [msg, note] = (await listLinkedInDrafts(t.db, { jobId: ids.job! })).sort((a, b) => a.linkedin.kind.localeCompare(b.linkedin.kind));
    expect(msg!.status).toBe('approved');

    const sent = await markLinkedInSent(t.db, config.outreach, msg!.id);
    expect(sent.item.status).toBe('executed');
    expect(sent.thread).toMatchObject({ channel: 'linkedin', state: 'sent', jobId: ids.job, contactId: ids.connection });
    await expect(markLinkedInSent(t.db, config.outreach, msg!.id)).rejects.toThrow(/already marked sent/);
    expect((await getBatchForJob(t.db, ids.job!))!).toMatchObject({ sentCount: 1, status: 'sending' });

    await markLinkedInSent(t.db, config.outreach, note!.id);
    expect((await getBatchForJob(t.db, ids.job!))!.sentCount).toBe(2);

    await expect(markLinkedInReplied(t.db, (await listBatchItems(t.db, batch.id)).find((i) => i.channel === 'email')!.id)).rejects.toThrow(/only manual LinkedIn drafts/);
    const replied = await markLinkedInReplied(t.db, msg!.id, { note: 'happy to refer' });
    expect(replied.state).toBe('replied');
    expect((await getBatchForJob(t.db, ids.job!))!.status).toBe('replied');
  });

  it('the 30-day cooldown still holds for a hand-sent message', async () => {
    const r = await fanOutReferrals(deps, ids.job2!, { count: 3 });
    // Everyone was asked (or queued) for the first job.
    expect(r.drafted).toEqual([]);
    const { createReviewItem } = await import('@quarry/db');
    const again = await createReviewItem(t.db, {
      kind: 'referral_ask',
      pluginId: 'actor-linkedin-manual',
      jobId: ids.job2!,
      contactId: ids.connection!,
      companyId: ids.company!,
      draft: { channel: 'linkedin_manual', kind: 'message', profileUrl: 'https://www.linkedin.com/in/cara-connect/', toName: 'Cara Connect', text: 'Hi Cara, one more role I would love a referral for, if you are open to it.' },
    });
    await expect(markLinkedInSent(t.db, config.outreach, again.id)).rejects.toMatchObject({ code: 'cooldown' });
    await expect(approveReviewItem(t.db, config.outreach, again.id)).rejects.toBeInstanceOf(OutreachError);
  });
});

import { describe, expect, it } from 'vitest';
import { pluginManifestSchema, preferencesSchema, type ApprovedDraft, type EmailDraft, type OutreachActionInput } from '@jobforge/plugin-sdk';
import { fakeGmail, parseRfc822, testContext } from '@jobforge/plugin-sdk/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@jobforge/llm';
import plugin, { buildMime, configSchema, encodeHeader, messageIdFor } from './index.js';

const input = (o: Partial<OutreachActionInput> = {}): OutreachActionInput => ({
  kind: 'outreach',
  job: {
    id: 'j1',
    companyId: 'c1',
    company: 'Acme',
    title: 'Backend Engineer',
    normalizedTitle: 'backend engineer',
    locations: ['Bengaluru'],
    remotePolicy: 'hybrid',
    seniority: null,
    descriptionMd: 'Build the payments ledger in Go.',
    applyUrl: null,
    postedAt: null,
    embedding: null,
  },
  company: { id: 'c1', name: 'Acme', domain: 'acme.com', tags: [], emailDomain: 'acme.com', emailPattern: null, contacts: [] },
  contact: { id: 'p1', name: 'Jane Doe', role: 'Engineering Manager', email: 'jdoe@acme.com', emailConfidence: 1, emailSource: 'manual', status: 'active' },
  profile: {
    version: 'v1',
    preferences: preferencesSchema.parse({ roles: ['Backend Engineer'] }),
    facts: [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day', metrics: {}, tags: [] }],
    summary: '',
    embedding: null,
  },
  ...o,
});

const BODY = 'Hi Jane,\n\nI saw the Backend Engineer role on the payments ledger team. I built a Go ledger service handling 2M transactions a day. Would you be open to a 15-minute chat this week?';

function llmWith(outputs: unknown[]) {
  const provider = createFakeProvider((_r: ProviderRequest, i: number) => outputs[Math.min(i, outputs.length - 1)]);
  return { provider, llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }) };
}
const cfg = configSchema.parse({ senderName: 'Asha Rao', signature: 'Asha\nlinkedin.com/in/asha' });
/** Tests stand in for the core here; production code never builds one of these. */
const approve = (draft: EmailDraft) => ({ reviewItemId: 'r1', draft }) as unknown as ApprovedDraft<EmailDraft>;

describe('mime', () => {
  it('encodes non-ASCII headers, base64s the body, and blocks header injection', () => {
    const raw = buildMime({
      from: { name: 'Asha Rao', address: 'asha@gmail.com' },
      to: { name: 'José', address: 'jose@acme.com' },
      subject: 'Hello\r\nBcc: victim@evil.com',
      body: 'Line 1\nLíne 2',
      messageId: '<x@gmail.com>',
      references: ['<a@x>', '<b@x>'],
      inReplyTo: '<b@x>',
    });
    const { headers, body } = parseRfc822(raw);
    expect(headers.subject).toBe('Hello Bcc: victim@evil.com');
    expect(headers.bcc).toBeUndefined();
    expect(headers.to).toBe(`${encodeHeader('José')} <jose@acme.com>`);
    expect(headers.from).toBe('"Asha Rao" <asha@gmail.com>');
    expect(headers.references).toBe('<a@x> <b@x>');
    expect(body).toBe('Line 1\r\nLíne 2');
    expect(() => buildMime({ from: { name: '', address: 'a@b.c' }, to: { name: '', address: 'x>@y\nz' }, subject: 's', body: 'b', messageId: '<m>' })).toThrow(/invalid email/);
  });

  it('derives a stable Message-ID from the idempotency key', () => {
    expect(messageIdFor('outreach:r1', 'me@gmail.com')).toBe(messageIdFor('outreach:r1', 'me@gmail.com'));
    expect(messageIdFor('outreach:r1', 'me@gmail.com')).not.toBe(messageIdFor('outreach:r2', 'me@gmail.com'));
    expect(messageIdFor('k', 'me@gmail.com')).toMatch(/^<jobforge\.[0-9a-f]{32}@gmail\.com>$/);
  });

  it('wraps body + attachment in multipart/mixed with a stable boundary', () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n%mock pdf bytes', 'utf8');
    const raw = buildMime({
      from: { name: 'Asha', address: 'asha@gmail.com' },
      to: { name: 'Jane', address: 'jane@acme.com' },
      subject: 'Role',
      body: 'See attached.',
      messageId: '<m@gmail.com>',
      attachments: [{ filename: 'resume.pdf', contentType: 'application/pdf', data: pdfBytes }],
    });
    const match = raw.match(/boundary="([^"]+)"/);
    expect(match).toBeTruthy();
    const boundary = match![1]!;
    expect(raw).toContain(`--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"`);
    expect(raw).toContain('Content-Disposition: attachment; filename="resume.pdf"');
    expect(raw).toContain('Content-Type: application/pdf; name="resume.pdf"');
    expect(raw).toContain(pdfBytes.toString('base64'));
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});

describe('actor-gmail-outreach', () => {
  it('declares an external side effect, the LLM, and Gmail send+read', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest).toMatchObject({ sideEffects: 'external', permissions: { llm: true, gmail: ['send', 'read'] } });
  });

  it('prepare drafts a grounded email; placeholders trigger the repair retry; unknown fact ids are dropped', async () => {
    const { provider, llm } = llmWith([
      { subject: 'Backend role', body: 'Hi [Name], ' + BODY, fact_ids: [], confidence: 0.9 },
      { subject: 'Payments ledger role', body: BODY, fact_ids: ['exp-ledger', 'made-up'], confidence: 0.9 },
    ]);
    const draft = await plugin.prepare(testContext(cfg, undefined, { llm }), input());
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.prompt).toMatch(/placeholder/);
    expect(provider.calls[0]!.prompt).toContain('[exp-ledger] (experience) Built a Go ledger service');
    expect(draft).toMatchObject({
      to: 'jdoe@acme.com',
      toName: 'Jane Doe',
      subject: 'Payments ledger role',
      factIds: ['exp-ledger'],
      gmailThreadId: null,
      references: [],
    });
    expect(draft.body.endsWith('\n\nAsha\nlinkedin.com/in/asha')).toBe(true);
  });

  it('follow-ups reply in-thread with Re: subject and References', async () => {
    const { llm, provider } = llmWith([{ subject: 'whatever', body: 'Hi Jane, just bumping this in case it got buried. Since writing, I also shipped X.', fact_ids: [], confidence: 0.9 }]);
    const draft = await plugin.prepare(
      testContext(cfg, undefined, { llm }),
      input({
        kind: 'followup',
        previous: { subject: 'Payments ledger role', body: BODY, sentAt: new Date(), followupNumber: 1, gmailThreadId: 't9', messageIds: ['<a@x>'] },
      }),
    );
    expect(draft).toMatchObject({ subject: 'Re: Payments ledger role', gmailThreadId: 't9', inReplyTo: '<a@x>', references: ['<a@x>'] });
    expect(provider.calls[0]!.prompt).toContain('follow-up #1');
  });

  it('drafts a short referral ask citing one bullet and keeping the posting URL', async () => {
    const { provider, llm } = llmWith([
      { subject: 'Referral for Backend Engineer?', body: 'Hi Jane,\n\nWould you refer me for the Backend Engineer role? I built a Go ledger service handling 2M transactions a day. Happy to send my resume and a two-line blurb.', bullet_id: 'b2', confidence: 0.86 },
    ]);
    const job = { ...input().job!, applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' };
    const draft = await plugin.prepare(
      testContext(cfg, undefined, { llm }),
      input({
        kind: 'referral_ask',
        job,
        contact: { ...input().contact, roleHint: 'engineer', department: 'Payments' },
        resumeBullets: [
          { id: 'b1', text: 'Built a React dashboard' },
          { id: 'b2', text: 'Built a Go ledger service handling 2M tx/day' },
        ],
      }),
    );
    expect(draft.resumeBulletId).toBe('b2');
    expect(draft.body).toContain('Role: https://boards.greenhouse.io/acme/jobs/1'); // appended when the LLM dropped it
    expect(draft.body.endsWith('Asha\nlinkedin.com/in/asha')).toBe(true);
    expect(draft.confidence).toBe(0.86);
    const prompt = provider.calls[0]!.prompt;
    expect(prompt).toContain('Posting URL: https://boards.greenhouse.io/acme/jobs/1');
    expect(prompt).toContain('team: Payments');
    expect(prompt).toContain('[b2] Built a Go ledger service');
  });

  it('repairs a referral ask that cites an unknown bullet', async () => {
    const { provider, llm } = llmWith([
      { subject: 'Referral?', body: 'Hi Jane, would you refer me for the role at https://x.com/1 ? I have relevant backend work to share.', bullet_id: 'nope', confidence: 0.9 },
      { subject: 'Referral?', body: 'Hi Jane, would you refer me for the role at https://x.com/1 ? I built a React dashboard for internal tools.', bullet_id: 'b1', confidence: 0.9 },
    ]);
    const draft = await plugin.prepare(
      testContext(cfg, undefined, { llm }),
      input({ kind: 'referral_ask', job: { ...input().job!, applyUrl: 'https://x.com/1' }, resumeBullets: [{ id: 'b1', text: 'Built a React dashboard' }] }),
    );
    expect(provider.calls).toHaveLength(2);
    expect(draft.resumeBulletId).toBe('b1');
    expect(draft.body).not.toContain('Role: https://x.com/1'); // URL already present
  });

  const draft: EmailDraft = {
    to: 'jdoe@acme.com',
    toName: 'Jane Doe',
    subject: 'Payments ledger role',
    body: BODY,
    factIds: [],
    attachments: [],
    confidence: null,
    resumeBulletId: null,
    gmailThreadId: null,
    inReplyTo: null,
    references: [],
  };

  it('dry run never touches Gmail', async () => {
    const gmail = fakeGmail('asha@gmail.com');
    const res = await plugin.execute(testContext(cfg, undefined, { gmail, dryRun: true }), approve(draft), 'outreach:r1');
    expect(res).toMatchObject({ dryRun: true, gmailId: null });
    expect(gmail.messages).toHaveLength(0);
  });

  it('sends once; a retry with the same key finds the message instead of resending', async () => {
    const gmail = fakeGmail('asha@gmail.com');
    const ctx = testContext(cfg, undefined, { gmail, dryRun: false });
    const first = await plugin.execute(ctx, approve(draft), 'outreach:r1');
    expect(first).toMatchObject({ dryRun: false, deduplicated: false, gmailId: 'm1' });
    const sent = gmail.sent()[0]!;
    expect(sent.headers['message-id']).toBe(first.messageId);
    expect(sent.headers.to).toBe('"Jane Doe" <jdoe@acme.com>');
    expect(sent.body).toContain('15-minute chat');

    const retry = await plugin.execute(ctx, approve(draft), 'outreach:r1');
    expect(retry).toMatchObject({ deduplicated: true, gmailId: 'm1', messageId: first.messageId });
    expect(gmail.sent()).toHaveLength(1);
  });

  it('rejects a malformed approved draft', async () => {
    const gmail = fakeGmail();
    await expect(
      plugin.execute(testContext(cfg, undefined, { gmail, dryRun: false }), approve({ ...draft, to: 'not-an-email' }), 'k'),
    ).rejects.toThrow();
    expect(gmail.messages).toHaveLength(0);
  });
});

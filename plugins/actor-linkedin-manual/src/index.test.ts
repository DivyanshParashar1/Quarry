import { describe, expect, it } from 'vitest';
import { pluginManifestSchema, preferencesSchema, type ApprovedDraft, type LinkedInManualDraft, type OutreachActionInput } from '@quarry/plugin-sdk';
import { testContext } from '@quarry/plugin-sdk/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@quarry/llm';
import plugin, { configSchema, draftKind } from './index.js';

const PROFILE = 'https://www.linkedin.com/in/ananya-sharma-1a2b3c/';
const RESUME = '5b1f8c5e-6c1a-4d0e-9a51-0e2f2d3c4b5a';

const input = (degree: number | null, notes: string | null = null): OutreachActionInput => ({
  kind: 'referral_ask',
  job: { id: 'j1', companyId: 'c1', company: 'Walmart', title: 'Software Engineer III', normalizedTitle: 'software engineer iii', locations: ['Bengaluru'], remotePolicy: null, seniority: null, descriptionMd: 'Payments platform', applyUrl: 'https://walmart.wd5.myworkdayjobs.com/x', postedAt: null, embedding: null },
  company: { id: 'c1', name: 'Walmart Global Tech', domain: 'walmart.com', tags: [], emailDomain: null, emailPattern: null, contacts: [] },
  contact: { id: 'p1', name: 'Ananya Sharma', role: 'Senior Software Engineer', email: '', emailConfidence: null, emailSource: null, status: 'active', linkedinUrl: PROFILE, department: 'Payments', linkedinDegree: degree, notes },
  profile: { version: 'v1', preferences: preferencesSchema.parse({ application: { first_name: 'Jane' } }), facts: [], summary: '', embedding: null },
  resumeBullets: [{ id: 'b1', text: 'Built a Go ledger service handling 2M tx/day' }],
  attachments: [{ filename: 'resume.pdf', contentType: 'application/pdf', path: '/tmp/r.pdf', resumeVariantId: RESUME }],
});

const MESSAGE =
  'Hi Ananya, good to reconnect since our college days! I am applying for Software Engineer III on the payments team (https://walmart.wd5.myworkdayjobs.com/x). I built a Go ledger service handling 2M transactions a day. I have attached my resume; would you be open to referring me, or pointing me to the right person? Thanks, Jane';

function llmReturning(...outs: unknown[]) {
  const provider = createFakeProvider((_r: ProviderRequest, i: number) => outs[Math.min(i, outs.length - 1)]);
  return { provider, llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }) };
}

describe('actor-linkedin-manual', () => {
  it('has a valid manifest that never touches the network', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions.domains).toEqual([]);
    expect(plugin.manifest.permissions.browser).toBeUndefined();
  });

  it('drafts a full message (job link, one bullet, resume reference, sign-off) for a 1st-degree connection', async () => {
    const { provider, llm } = llmReturning({ text: MESSAGE, bullet_id: 'b1', confidence: 0.9 });
    const d = await plugin.prepare(testContext(configSchema.parse({}), undefined, { llm }), input(1, 'college senior'));
    expect(d).toMatchObject({
      channel: 'linkedin_manual',
      kind: 'message',
      profileUrl: PROFILE,
      toName: 'Ananya Sharma',
      text: MESSAGE,
      jobTitle: 'Software Engineer III',
      jobUrl: 'https://walmart.wd5.myworkdayjobs.com/x',
      resumeVariantId: RESUME,
      resumeBulletId: 'b1',
      confidence: 0.9,
    });
    const prompt = provider.calls[0]!.prompt;
    expect(prompt).toContain('1st-degree LinkedIn connection of the candidate; context: college senior');
    expect(prompt).toContain('Posting URL: https://walmart.wd5.myworkdayjobs.com/x');
    expect(prompt).toContain('Sign off as "Jane"');
    expect(provider.calls[0]!.system).toMatch(/resume is attached/);
  });

  it('drafts a ≤300-char connection note for anyone else, repairing an over-long one', async () => {
    const note = 'Hi Ananya, I am applying for Software Engineer III on Payments; I built a Go ledger handling 2M tx/day. Would you be open to referring me?';
    const { provider, llm } = llmReturning({ text: `Hi Ananya, ${'x'.repeat(320)}`, bullet_id: 'b1', confidence: 0.9 }, { text: note, bullet_id: 'b1', confidence: 0.8 });
    const d = await plugin.prepare(testContext(configSchema.parse({}), undefined, { llm }), input(null));
    expect(provider.calls).toHaveLength(2);
    expect(d).toMatchObject({ kind: 'note', text: note, resumeVariantId: null, confidence: 0.8 });
    expect(provider.calls[0]!.prompt).toContain('Relationship: not connected yet');
    expect(provider.calls[0]!.prompt).not.toContain('Posting URL');
  });

  it('rejects a message with a placeholder, and contacts without a profile', async () => {
    const { llm } = llmReturning({ text: `${MESSAGE} [Your Name]`, bullet_id: 'b1', confidence: 0.9 });
    await expect(plugin.prepare(testContext(configSchema.parse({}), undefined, { llm }), input(1))).rejects.toThrow();
    const noUrl = input(1);
    noUrl.contact.linkedinUrl = null;
    await expect(plugin.prepare(testContext(configSchema.parse({}), undefined, { llm }), noUrl)).rejects.toThrow(/no LinkedIn profile URL/);
  });

  it('chooses the kind from the connection degree', () => {
    expect(draftKind(input(1).contact)).toBe('message');
    expect(draftKind(input(2).contact)).toBe('note');
    expect(draftKind(input(null).contact)).toBe('note');
  });

  it('never executes', async () => {
    const approved = { reviewItemId: 'r1', draft: {} } as unknown as ApprovedDraft<LinkedInManualDraft>;
    await expect(plugin.execute(testContext(configSchema.parse({})), approved, 'k')).rejects.toThrow(/manual: send the message yourself/);
  });
});

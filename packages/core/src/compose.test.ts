import { describe, expect, it } from 'vitest';
import { preferencesSchema, type Profile } from '@quarry/shared';
import { createFakeProvider, createLLMClient } from '@quarry/llm';
import { APPS_SCRIPT, checkComposeText, composeFormSchema, composeProjects, composePrompt, composeSchema, generateCompose } from './compose.js';

const profile: Profile = {
  version: 'v1',
  preferences: preferencesSchema.parse({ roles: ['Backend Engineer'], application: { first_name: 'Asha', last_name: 'Rao', current_title: 'SDE', current_company: 'Initech' } }),
  facts: [
    { id: 'proj-ledger', kind: 'project', content: 'Go ledger service, 2M tx/day', metrics: {}, tags: ['go'] },
    { id: 'proj-crdt', kind: 'project', content: 'CRDT text editor in Rust', metrics: {}, tags: ['rust'] },
    { id: 'exp-initech', kind: 'experience', content: 'Intern at Globex', metrics: {}, tags: [] },
  ],
  summary: '',
  embedding: null,
};

describe('compose prompt', () => {
  const form = composeFormSchema.parse({ purpose: 'referral', about: 'The Backend Engineer opening, req 4411', projectIds: ['proj-ledger'], tone: 'casual', length: 'short' });
  const recipient = { toName: 'Jane Doe', receiverInfo: 'We met at GopherCon; she leads the payments team.', notes: 'Mention I can start in January.' };

  it("is built only from the user's inputs and the picked projects", () => {
    const p = composePrompt(form, recipient, profile, { count: 2 });
    expect(p).toContain('We met at GopherCon');
    expect(p).toContain('req 4411');
    expect(p).toContain('Mention I can start in January.');
    expect(p).toContain('[proj-ledger] Go ledger service');
    expect(p).not.toContain('CRDT'); // not picked
    expect(p).not.toContain('Intern at Globex'); // experience facts are not pulled in
    expect(p).toContain('Name: Asha Rao');
    expect(p).toContain('At most 90 words');
    expect(p).toContain('Write 2 variants.');
  });

  it('asks for one new, different variant when regenerating one', () => {
    const p = composePrompt(form, recipient, profile, { count: 1, keep: { angle: 'connection', subject: 'From GopherCon', body: 'Hi Jane, ...' } });
    expect(p).toContain('write ONE new variant with a different angle');
    expect(p).toContain('Subject: From GopherCon');
  });

  it('lists only project facts on the form', () => {
    expect(composeProjects(profile).map((p) => p.id)).toEqual(['proj-ledger', 'proj-crdt']);
    expect(composeProjects(null)).toEqual([]);
  });

  it('rejects placeholders, overlong bodies and the wrong variant count', () => {
    const s = composeSchema(2, 90);
    const ok = { angle: 'project first', subject: 'Ledger work', body: 'Hi Jane, I built a Go ledger service and would love a referral for the backend role.' };
    expect(s.safeParse({ variants: [ok, ok] }).success).toBe(true);
    expect(s.safeParse({ variants: [ok] }).success).toBe(false);
    expect(s.safeParse({ variants: [ok, { ...ok, body: 'Hi [Name], I would love a referral for the backend role at your company.' }] }).success).toBe(false);
    expect(s.safeParse({ variants: [ok, { ...ok, body: 'word '.repeat(200) }] }).success).toBe(false);
  });

  it('returns two variants from the LLM', async () => {
    const provider = createFakeProvider(() => ({
      variants: [
        { angle: 'connection first', subject: 'GopherCon follow-up', body: 'Hi Jane, great meeting you at GopherCon. I can start in January and would love a referral.' },
        { angle: 'project first', subject: 'Go ledger + your team', body: 'Hi Jane, I built a Go ledger handling 2M tx a day. I can start in January; would you refer me?' },
      ],
    }));
    const llm = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' });
    const r = await generateCompose(llm, profile, { form, recipient });
    expect(r.variants).toHaveLength(2);
    expect(provider.calls[0]!.system).toMatch(/Never invent facts about the receiver/);
  });
});

describe('pre-send checks', () => {
  it('blocks a missing or bad address and an empty body', () => {
    expect(checkComposeText({ to: '', subject: 's', body: 'b', attachmentCount: 0 }).blocking).toEqual(['To is empty']);
    expect(checkComposeText({ to: 'jane@', subject: 's', body: 'b', attachmentCount: 0 }).blocking[0]).toMatch(/not a valid email/);
    expect(checkComposeText({ to: 'jane@acme.com', subject: 's', body: ' ', attachmentCount: 0 }).blocking).toEqual(['Body is empty']);
  });

  it('warns about a mentioned-but-missing attachment, placeholders and an empty subject', () => {
    const w = checkComposeText({ to: 'jane@acme.com', subject: '', body: 'Hi {{name}}, please find attached my resume.', attachmentCount: 0 }).warnings;
    expect(w).toHaveLength(3);
    expect(checkComposeText({ to: 'jane@acme.com', subject: 'x', body: 'Resume attached.', attachmentCount: 1 }).warnings).toEqual([]);
  });
});

describe('Apps Script', () => {
  it('only sends drafts carrying the Quarry header, once due', () => {
    expect(APPS_SCRIPT).toContain("getHeader('X-Quarry-Send-At')");
    expect(APPS_SCRIPT).toContain('if (!at) return;');
    expect(APPS_SCRIPT).toContain('everyMinutes(5)');
  });
});

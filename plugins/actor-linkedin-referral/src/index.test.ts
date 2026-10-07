import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pluginManifestSchema,
  preferencesSchema,
  SessionBlockedError,
  type ApprovedDraft,
  type BrowserHandle,
  type LinkedInNoteDraft,
  type OutreachActionInput,
} from '@jobforge/plugin-sdk';
import { fakeBrowser, testContext } from '@jobforge/plugin-sdk/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@jobforge/llm';
import plugin, { configSchema, SEL } from './index.js';

const html = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');
const PROFILE = 'https://www.linkedin.com/in/ananya-sharma-1a2b3c/';
const shots = () => mkdtempSync(join(tmpdir(), 'li-shots-'));

const input = (): OutreachActionInput => ({
  kind: 'referral_ask',
  job: { id: 'j1', companyId: 'c1', company: 'Walmart', title: 'Software Engineer III', normalizedTitle: 'software engineer iii', locations: ['Bengaluru'], remotePolicy: null, seniority: null, descriptionMd: 'Payments', applyUrl: 'https://walmart.wd5.myworkdayjobs.com/x', postedAt: null, embedding: null },
  company: { id: 'c1', name: 'Walmart Global Tech', domain: 'walmart.com', tags: [], emailDomain: null, emailPattern: null, contacts: [] },
  contact: { id: 'p1', name: 'Ananya Sharma', role: 'Senior Software Engineer', email: '', emailConfidence: null, emailSource: null, status: 'active', linkedinUrl: PROFILE, department: 'Payments' },
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  resumeBullets: [{ id: 'b1', text: 'Built a Go ledger service handling 2M tx/day' }],
});

const draft: LinkedInNoteDraft = {
  channel: 'linkedin',
  profileUrl: PROFILE,
  toName: 'Ananya Sharma',
  note: 'Hi Ananya, I am applying for Software Engineer III on Payments; I built a Go ledger handling 2M tx/day. Would you be open to referring me?',
  jobUrl: null,
  resumeBulletId: 'b1',
  confidence: 0.9,
};
/** Tests stand in for the core here; production code never builds one of these. */
const approve = (d: LinkedInNoteDraft) => ({ reviewItemId: 'r1', draft: d }) as unknown as ApprovedDraft<LinkedInNoteDraft>;

function site(profile = 'profile.html', afterSend = 'profile-pending.html') {
  return fakeBrowser({
    pages: { [PROFILE]: html(profile) },
    onClick(sel) {
      if (sel === SEL.connect || sel === SEL.moreConnect) return { html: html('modal-add-note.html') };
      if (sel === SEL.more) return { html: html('profile-more.html').replace('<div class="artdeco-dropdown__content"></div>', '<div role="button">Connect</div>') };
      if (sel === SEL.addNote) return { html: html('modal-note.html') };
      if (sel === SEL.send) return { html: html(afterSend) };
      return undefined;
    },
  });
}

describe('actor-linkedin-referral', () => {
  it('has a valid external manifest scoped to linkedin.com', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.sideEffects).toBe('external');
    expect(plugin.manifest.permissions.domains).toEqual(['www.linkedin.com']);
  });

  it('drafts a ≤300-char note citing one bullet, repairing an over-long one', async () => {
    const long = 'x'.repeat(320);
    const provider = createFakeProvider((_r: ProviderRequest, i: number) =>
      i === 0
        ? { note: `Hi Ananya, ${long}`, bullet_id: 'b1', confidence: 0.9 }
        : { note: draft.note, bullet_id: 'b1', confidence: 0.85 },
    );
    const llm = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' });
    const d = await plugin.prepare(testContext(configSchema.parse({}), undefined, { llm }), input());
    expect(provider.calls).toHaveLength(2);
    expect(d).toMatchObject({ channel: 'linkedin', profileUrl: PROFILE, toName: 'Ananya Sharma', resumeBulletId: 'b1', confidence: 0.85 });
    expect(d.note.length).toBeLessThanOrEqual(300);
    expect(provider.calls[0]!.prompt).toContain('team: Payments');
  });

  it('dry run opens nothing', async () => {
    const browser = site();
    const r = await plugin.execute(testContext(configSchema.parse({}), undefined, { browser: browser as BrowserHandle, dryRun: true }), approve(draft), 'send:r1');
    expect(r.outcome).toBe('dry_run');
    expect(browser.actions).toEqual([]);
  });

  it('connects with a note, typing it, with pre/post screenshots', async () => {
    const browser = site();
    const dir = shots();
    const r = await plugin.execute(
      testContext(configSchema.parse({ screenshotDir: dir }), undefined, { browser: browser as BrowserHandle, dryRun: false }),
      approve(draft),
      'send:r1',
    );
    expect(r).toMatchObject({ dryRun: false, outcome: 'sent', profileUrl: PROFILE });
    expect(r.screenshots.map((s) => s.split('/').pop())).toEqual(['send_r1-pre.png', 'send_r1-post.png']);
    for (const s of r.screenshots) expect(existsSync(s)).toBe(true);
    const steps = browser.actions.filter((a) => a.type !== 'mouse' && a.type !== 'screenshot').map((a) => [a.type, a.selector ?? a.url]);
    expect(steps).toEqual([
      ['goto', PROFILE],
      ['click', SEL.connect],
      ['click', SEL.addNote],
      ['type', SEL.note],
      ['click', SEL.send],
    ]);
    expect(browser.actions.find((a) => a.type === 'type')!.value).toBe(draft.note);
  });

  it('finds Connect under "More" when it is not the primary button', async () => {
    const browser = site('profile-more.html');
    const r = await plugin.execute(testContext(configSchema.parse({ screenshotDir: shots() }), undefined, { browser: browser as BrowserHandle, dryRun: false }), approve(draft), 'send:r2');
    expect(r.outcome).toBe('sent');
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual([SEL.more, SEL.moreConnect, SEL.addNote, SEL.send]);
  });

  it('never sends twice: pending or connected profiles are no-ops', async () => {
    for (const [file, outcome] of [['profile-pending.html', 'already_pending'], ['profile-connected.html', 'already_connected']] as const) {
      const browser = site(file);
      const r = await plugin.execute(testContext(configSchema.parse({ screenshotDir: shots() }), undefined, { browser: browser as BrowserHandle, dryRun: false }), approve(draft), 'send:r3');
      expect(r.outcome).toBe(outcome);
      expect(browser.actions.some((a) => a.type === 'click')).toBe(false);
    }
  });

  it('fails fast on a checkpoint and on the weekly-limit notice', async () => {
    const blocked = fakeBrowser({ pages: { [PROFILE]: html('checkpoint.html') } });
    await expect(
      plugin.execute(testContext(configSchema.parse({ screenshotDir: shots() }), undefined, { browser: blocked as BrowserHandle, dryRun: false }), approve(draft), 'send:r4'),
    ).rejects.toBeInstanceOf(SessionBlockedError);
    const limited = site('profile.html', 'weekly-limit.html');
    await expect(
      plugin.execute(testContext(configSchema.parse({ screenshotDir: shots() }), undefined, { browser: limited as BrowserHandle, dryRun: false }), approve(draft), 'send:r5'),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
  });
});

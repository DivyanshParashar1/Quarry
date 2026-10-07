import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationSchema, preferencesSchema } from '@jobforge/shared';
import { applicationDraftSchema, pluginManifestSchema, type ApplicationDraft, type ApprovedDraft, type ApplyInput, type BrowserHandle } from '@jobforge/plugin-sdk';
import { fakeBrowser, fixtureHttp, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { applyPageUrl, configSchema, parseApplyPage } from './index.js';

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');
const URL_ = applyPageUrl('acme', 'abc-123');

const input = (): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'Acme', title: 'Backend Engineer', normalizedTitle: 'x', locations: [], remotePolicy: null, seniority: null, descriptionMd: null, applyUrl: 'https://jobs.lever.co/acme/abc-123', postedAt: null, embedding: null },
  ats: 'lever',
  boardToken: 'acme',
  postingId: 'abc-123',
  applyUrl: 'https://jobs.lever.co/acme/abc-123',
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  applicant: applicationSchema.parse({
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@example.com',
    github_url: 'https://github.com/asha',
    work_authorization: { India: 'yes' },
    eeo: { gender: 'decline' },
  }),
  resume: { path: '/tmp/resume.pdf', resumeVariantId: 'rv1' },
});

describe('actor-apply-lever', () => {
  it('parses the apply page into questions', () => {
    const q = parseApplyPage(fx('apply.html'));
    expect(q.map((x) => [x.key, x.kind, x.required])).toEqual([
      ['resume', 'file', true],
      ['name', 'text', true],
      ['email', 'text', true],
      ['phone', 'text', false],
      ['org', 'text', false],
      ['urls[LinkedIn]', 'text', false],
      ['urls[GitHub]', 'text', false],
      ['cards[9f1c][field0]', 'radio', true],
      ['cards[9f1c][field1]', 'text', true],
      ['comments', 'textarea', false],
      ['eeo[gender]', 'select', false],
    ]);
    expect(q.find((x) => x.key === 'cards[9f1c][field0]')).toMatchObject({ label: 'Are you authorized to work in India?', options: ['Yes', 'No'] });
    expect(q.find((x) => x.key === 'eeo[gender]')).toMatchObject({ eeo: 'gender', options: ['Female', 'Male', 'Decline to self-identify'] });
  });

  it('prepares, previews, and submits after approval', async () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    const http = fixtureHttp({ [URL_]: { text: fx('apply.html') } }, plugin.manifest.permissions.domains);
    const d = await plugin.prepare(testContext(configSchema.parse({}), http), input());
    const v = Object.fromEntries(d.fields.map((f) => [f.key, f.value]));
    expect(v).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', 'urls[GitHub]': 'https://github.com/asha', 'cards[9f1c][field0]': 'Yes', 'eeo[gender]': 'Decline to self-identify', 'cards[9f1c][field1]': null });
    expect(d.missingRequired).toEqual(['What is your expected CTC?']);

    const filled = applicationDraftSchema.parse({ ...d, fields: d.fields.map((f) => (f.key === 'cards[9f1c][field1]' ? { ...f, value: '12 LPA', source: 'human' } : f)), missingRequired: [] });
    const browser = fakeBrowser({ pages: { [URL_]: fx('apply.html') }, onClick: (s) => (s === '#btn-submit' ? { html: fx('thanks.html') } : undefined) });
    const r = await plugin.execute(
      testContext(configSchema.parse({ screenshotDir: mkdtempSync(join(tmpdir(), 'lv-')), typingDelayMs: 0 }), undefined, { browser: browser as BrowserHandle, dryRun: false }),
      { reviewItemId: 'r1', draft: filled } as unknown as ApprovedDraft<ApplicationDraft>,
      'apply:j1:v1',
    );
    expect(r).toMatchObject({ submitted: true, confirmation: 'Application submitted' });
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['input[name="cards[9f1c][field0]"][value="Yes"]', '#btn-submit']);
  });
});

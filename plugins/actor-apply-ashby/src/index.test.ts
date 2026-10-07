import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationSchema, preferencesSchema } from '@jobforge/shared';
import { pluginManifestSchema, type ApplicationDraft, type ApprovedDraft, type ApplyInput, type BrowserHandle } from '@jobforge/plugin-sdk';
import { fakeBrowser, fixtureHttp, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { applicationUrl, configSchema, GRAPHQL_URL } from './index.js';

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');

const input = (): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'Linear', title: 'Software Engineer', normalizedTitle: 'x', locations: [], remotePolicy: null, seniority: null, descriptionMd: null, applyUrl: 'https://jobs.ashbyhq.com/linear/8a1d', postedAt: null, embedding: null },
  ats: 'ashby',
  boardToken: 'linear',
  postingId: '8a1d',
  applyUrl: 'https://jobs.ashbyhq.com/linear/8a1d',
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  applicant: applicationSchema.parse({
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@example.com',
    linkedin_url: 'https://www.linkedin.com/in/asha/',
    work_authorization: { India: 'yes' },
    answers: [{ match: 'hear about', answer: 'Company careers page' }],
    eeo: { gender: 'decline' },
  }),
  resume: { path: '/tmp/resume.pdf', resumeVariantId: null },
});

describe('actor-apply-ashby', () => {
  it('reads the form over GraphQL, fills and submits after approval', async () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    const http = fixtureHttp({ [`POST ${GRAPHQL_URL}`]: { text: fx('form.json'), contentType: 'application/json' } }, plugin.manifest.permissions.domains);
    const d = await plugin.prepare(testContext(configSchema.parse({}), http), input());
    expect(JSON.parse(http.bodies[0]!)).toMatchObject({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: 'linear', jobPostingId: '8a1d' } });
    expect(Object.fromEntries(d.fields.map((f) => [f.key, f.value]))).toEqual({
      _systemfield_name: 'Asha Rao',
      _systemfield_email: 'asha@example.com',
      _systemfield_resume: '/tmp/resume.pdf',
      '2c4e7a1b-phone': null,
      '5b8f-linkedin': 'https://www.linkedin.com/in/asha/',
      '7d2a-auth': 'Yes',
      '9e1f-hear': 'Company careers page',
      'eeo-gender': 'Decline to self-identify',
    });
    expect(d.missingRequired).toEqual([]);
    expect(d.applyUrl).toBe(applicationUrl('linear', '8a1d'));

    const browser = fakeBrowser({
      pages: { [d.applyUrl]: fx('application.html') },
      onClick: (s) => (s.includes('Submit Application') ? { html: fx('thanks.html') } : undefined),
    });
    const r = await plugin.execute(
      testContext(configSchema.parse({ screenshotDir: mkdtempSync(join(tmpdir(), 'ab-')), typingDelayMs: 0 }), undefined, { browser: browser as BrowserHandle, dryRun: false }),
      { reviewItemId: 'r1', draft: d } as unknown as ApprovedDraft<ApplicationDraft>,
      'apply:j1:v1',
    );
    expect(r).toMatchObject({ submitted: true });
    expect(browser.actions.find((a) => a.type === 'fill' && a.selector === '[id="_systemfield_name"]')?.value).toBe('Asha Rao');
  });

  it('fails clearly for a closed posting', async () => {
    const http = fixtureHttp({ [`POST ${GRAPHQL_URL}`]: { body: { data: { jobPosting: null } } } }, plugin.manifest.permissions.domains);
    await expect(plugin.prepare(testContext(configSchema.parse({}), http), input())).rejects.toThrow(/no job posting/);
  });
});

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadAppConfig, parseAppConfig } from './app-config.js';

describe('config.yaml', () => {
  it('defaults when the file is missing', () => {
    expect(loadAppConfig('/nonexistent/config.yaml')).toEqual({
      llm: { tasks: {} },
      embeddings: { model: 'Xenova/bge-small-en-v1.5' },
      outreach: {
        dailyCap: null,
        perCompanyPerWeek: null,
        senderDailyLimit: 400,
        perJobReferralCap: 10,
        perContactCooldownDays: 30,
        referralMinEmailConfidence: 0.3,
        spacingMinutes: [4, 11],
        followupDays: [5, 7],
        maxFollowups: 2,
      },
      resume: { name: '', contact: '', headline: '' },
      autopilot: {
        enabled: false,
        minMatchScore: 70,
        confidenceFloor: { match: 0.75, tailor: 0.75, outreach: 0.8 },
        minEmailConfidence: 0.6,
        maxAutoApprovesPerDay: 10,
        candidateBatch: 20,
      },
      linkedin: {
        dailyConnectionCap: 25,
        searchIntervalSeconds: 60,
        actionGapSeconds: [45, 120],
        cooldownMinutes: 60,
        searchKeywords: ['software engineer', 'SDE', 'developer'],
        profilesPerCompany: 15,
      },
      discovery: { minConfidence: 0.5, lists: {}, alertThreshold: 40, recheckDays: 30, nightly: false },
      plugins: {},
    });
  });

  it('parses the checked-in example', () => {
    const c = loadAppConfig(fileURLToPath(new URL('../../../config.example.yaml', import.meta.url)));
    expect(c.llm.tasks.match).toEqual({ model: 'claude-haiku-4-5' });
    expect(c.plugins['matcher-default']).toMatchObject({ llmTopK: 150 });
  });

  it('rejects unknown providers and keys', () => {
    expect(() => parseAppConfig({ llm: { tasks: { match: { provider: 'gpt' } } } })).toThrow(/llm\.tasks\.match\.provider/);
    expect(() => parseAppConfig({ llm: { tasks: { summarize: {} } } })).toThrow(/Unrecognized key/);
  });
});

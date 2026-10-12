import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BENCHMARK_CATEGORIES, loadAppConfig, parseAppConfig } from './app-config.js';

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
        followupDays: [1],
        maxFollowups: 1,
      },
      resume: { name: '', contact: '', headline: '' },
      autopilot: {
        enabled: false,
        minMatchScore: 70,
        confidenceFloor: { match: 0.75, tailor: 0.75, outreach: 0.8, answers: 0.85 },
        minEmailConfidence: 0.6,
        maxAutoApprovesPerDay: 10,
        candidateBatch: 20,
        strategy: 'referrals',
        referralWaitDays: 2,
        deadlineImminentDays: 3,
        maxConcurrentJobs: 50,
        referralsPerJob: null,
        autoApproveReferrals: true,
        maxAutoApprovedAsksPerDay: 200,
        autoApproveApplications: false,
        maxPendingReviews: 300,
      },
      deadlines: { minMatchScore: 60, staleDays: 14, batchSize: 20, expireMinConfidence: 0.6, expireGraceDays: 1, nightly: false },
      linkedin: {
        dailyConnectionCap: 25,
        searchIntervalSeconds: 60,
        actionGapSeconds: [45, 120],
        cooldownMinutes: 60,
        searchKeywords: ['software engineer', 'SDE', 'developer'],
        profilesPerCompany: 15,
      },
      discovery: { minConfidence: 0.5, lists: {}, alertThreshold: 40, recheckDays: 30, nightly: true },
      sweeper: { intervalMinutes: 60, fetchEveryHours: 6, runOnStart: true, matchLimit: 150 },
      resumes: {
        projectsPerResume: 3,
        selector: { similarityWeight: 0.4, similarityLow: 0.5, similarityHigh: 0.9, threshold: 75, tieMargin: 1 },
        benchmarks: { perCategory: 5, categories: DEFAULT_BENCHMARK_CATEGORIES },
      },
      orchestrator: {
        enabled: true,
        intervalMinutes: 15,
        dailyLlmBudgetUsd: 5,
        autoFix: true,
        maxCodeFixesPerDay: 3,
        verifyWindowMin: 60,
        checks: { sourceErrorStreak: 3, applyFailures: 2, stuckHours: { referral_pending: 96, ready_to_apply: 48 }, reviewBacklog: 300, bounceRate: 0.15, minSends: 10, stageFailures: 5 },
        codeFix: {
          command: 'claude',
          timeoutMin: 30,
          setup: [['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']],
          gates: [['pnpm', 'typecheck'], ['pnpm', 'lint'], ['pnpm', 'test']],
        },
      },
      chat: {
        enabled: true,
        timeoutMin: 30,
        maxConcurrent: 2,
        mergeCodeChanges: true,
        setup: [['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']],
        gates: [['pnpm', 'typecheck'], ['pnpm', 'lint'], ['pnpm', 'test']],
      },
      plugins: {},
    });
  });

  it('parses the checked-in example', () => {
    const c = loadAppConfig(fileURLToPath(new URL('../../../config.example.yaml', import.meta.url)));
    expect(c.llm.tasks.match).toEqual({ model: 'claude-haiku-4-5' });
    expect(c.plugins['matcher-default']).toMatchObject({ llmTopK: 150 });
  });

  it('sweep interval must be 60 or divide 60', () => {
    expect(parseAppConfig({}).sweeper.intervalMinutes).toBe(60);
    expect(parseAppConfig({ sweeper: { intervalMinutes: 15 } }).sweeper.intervalMinutes).toBe(15);
    expect(() => parseAppConfig({ sweeper: { intervalMinutes: 25 } })).toThrow(/divide 60/);
    expect(parseAppConfig({}).autopilot.confidenceFloor.answers).toBe(0.85);
    expect(parseAppConfig({ orchestrator: { dailyLlmBudgetUsd: null } }).orchestrator.dailyLlmBudgetUsd).toBeNull();
  });

  it('rejects unknown providers and keys', () => {
    expect(() => parseAppConfig({ llm: { tasks: { match: { provider: 'gpt' } } } })).toThrow(/llm\.tasks\.match\.provider/);
    expect(() => parseAppConfig({ llm: { tasks: { summarize: {} } } })).toThrow(/Unrecognized key/);
  });
});

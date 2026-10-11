import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LLMClient } from '@jobforge/shared';
import type { ExpertName, Finding } from './checks.js';

// Phase 22: experts. Invoked only for a failing check, each with a narrow
// toolset (the action types it may propose). The router picks the expert from
// the finding; the expert returns a structured plan; anything outside its
// toolset is dropped. Without an LLM (or over budget) a deterministic playbook
// stands in.

export const ACTION_TYPES = [
  'requeue_source',
  'pause_source',
  'resume_source',
  'pause_plugin',
  'resume_plugin',
  'set_tenant_override',
  'advance_job',
  'expire_job',
  'top_up_referrals',
  'rerun_stage',
  'pause_llm',
  'raise_attention',
  'code_fix',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Flat on purpose (one object shape is the most portable structured output); checked per type in actions.ts. */
export const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  companySourceId: z.string().optional(),
  pluginId: z.string().optional(),
  tenant: z.string().optional(),
  /** set_tenant_override: the override as a JSON object string, e.g. {"selectors":{"next":["#saveBtn"]}}. */
  overrideJson: z.string().optional(),
  jobId: z.string().optional(),
  hours: z.number().optional(),
  stage: z.enum(['sweep', 'match', 'apply', 'deadlines']).optional(),
  reason: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  /** code_fix: what to change and how to reproduce it. */
  instructions: z.string().optional(),
});
export type PlannedAction = z.infer<typeof actionSchema>;

export const planSchema = z.object({
  diagnosis: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  actions: z.array(actionSchema).max(10),
});
export type Plan = z.infer<typeof planSchema>;

export const TOOLSETS: Record<ExpertName, readonly ActionType[]> = {
  sources: ['requeue_source', 'pause_source', 'resume_source', 'pause_plugin', 'raise_attention', 'code_fix'],
  apply: ['pause_plugin', 'resume_plugin', 'set_tenant_override', 'raise_attention', 'code_fix'],
  outreach: ['pause_plugin', 'resume_plugin', 'raise_attention'],
  resume: ['rerun_stage', 'raise_attention', 'code_fix'],
  ops: ['advance_job', 'expire_job', 'top_up_referrals', 'rerun_stage', 'pause_llm', 'pause_plugin', 'resume_plugin', 'raise_attention'],
};

const ROLE: Record<ExpertName, string> = {
  sources: 'You are the Sources expert of JobForge (a self-hosted job-search pipeline). You fix job-board fetching: ATS boards that error, drift, or return nothing.',
  apply: 'You are the Apply expert of JobForge. You fix automated job-application form filling (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, SuccessFactors, Taleo): selector drift, unrecognised pages, wizard steps that are rejected.',
  outreach: 'You are the Outreach expert of JobForge. You protect email deliverability and reply rates of referral asks.',
  resume: 'You are the Resume expert of JobForge. You fix resume tailoring failures (one-page fit overflow, low ATS scores, tailoring errors).',
  ops: 'You are the Ops expert of JobForge. You keep the pipeline moving: stuck jobs, queues, the LLM budget, the review backlog.',
};

const ACTION_HELP: Record<ActionType, string> = {
  requeue_source: 'requeue_source {companySourceId}: fetch the board again now',
  pause_source: 'pause_source {companySourceId, reason}: stop fetching a board (e.g. it is gone: 404/410)',
  resume_source: 'resume_source {companySourceId}',
  pause_plugin: 'pause_plugin {pluginId, hours (1-168), reason}: skip a plugin for a while',
  resume_plugin: 'resume_plugin {pluginId}',
  set_tenant_override: 'set_tenant_override {pluginId, tenant, overrideJson}: per-tenant selectors/steps for an apply actor, e.g. {"selectors":{"next":["#saveContinue"]}} — use the failure capture HTML to pick selectors that exist there',
  advance_job: 'advance_job {jobId}: move a stuck job to its next pipeline step',
  expire_job: 'expire_job {jobId, reason}: close a job that cannot progress',
  top_up_referrals: 'top_up_referrals {jobId}: ask more people for a referral',
  rerun_stage: 'rerun_stage {stage: sweep|match|apply|deadlines}',
  pause_llm: 'pause_llm {}: pause LLM steps until tomorrow',
  raise_attention: 'raise_attention {title, message}: ask the user (only when a human must act)',
  code_fix: 'code_fix {title, instructions}: a code change (Claude Code in a worktree; must add a reproducing test; typecheck, lint and tests must pass; merged automatically; protected safety code cannot be changed). Use when the code itself is wrong (e.g. a selector in a plugin changed for every tenant).',
};

const MAX_CAPTURE = 12_000;

/** Failure-capture HTML for the prompt: scripts and styles removed, cut to size. */
async function captureSnippet(paths: unknown): Promise<string> {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  for (const p of list) {
    try {
      const html = (await readFile(p, 'utf8')).replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '').replace(/\s+/g, ' ');
      return `Failure capture (${p}):\n${html.slice(0, MAX_CAPTURE)}`;
    } catch {
      /* moved or deleted */
    }
  }
  return '';
}

export interface ExpertAdvice {
  plan: Plan;
  costUsd: number;
  source: 'llm' | 'playbook';
}

export async function consultExpert(llm: LLMClient, f: Finding, history: unknown[]): Promise<ExpertAdvice> {
  const tools = TOOLSETS[f.expert];
  const capture = f.expert === 'apply' ? await captureSnippet(f.data.captures) : '';
  const system = [
    ROLE[f.expert],
    'A deterministic health check failed. Diagnose it from the evidence and propose the smallest set of actions that fixes it.',
    'Only these actions are available to you:',
    ...tools.map((t) => `- ${ACTION_HELP[t]}`),
    'Prefer ops actions over code changes. Never propose anything that sends email, submits applications, solves captchas or logs in anywhere.',
    'If nothing safe would help, return no actions and say why; raise_attention when the user must act.',
  ].join('\n');
  const prompt = [
    `Check: ${f.checkId} (${f.severity})`,
    `Summary: ${f.summary}`,
    `Evidence: ${JSON.stringify(f.data).slice(0, 6000)}`,
    history.length ? `Earlier attempts on this incident: ${JSON.stringify(history).slice(0, 4000)}` : '',
    capture,
  ]
    .filter(Boolean)
    .join('\n\n');
  const res = await llm.generate({ task: 'orchestrator', system, prompt, schema: planSchema });
  const plan = { ...res.data, actions: res.data.actions.filter((a) => tools.includes(a.type)) };
  return { plan, costUsd: res.usage.costUsd ?? 0, source: 'llm' };
}

/** The deterministic stand-in when no LLM may be used. */
export function playbook(f: Finding): Plan {
  const attention = (title: string, message: string): PlannedAction => ({ type: 'raise_attention', title, message });
  switch (f.checkId) {
    case 'source_errors':
      return f.data.allPermanent
        ? { diagnosis: 'The board answers with a permanent error (gone or moved).', confidence: 0.8, actions: [{ type: 'pause_source', companySourceId: String(f.data.companySourceId), reason: f.summary }] }
        : { diagnosis: 'Repeated transient failures; pausing the board until it is checked.', confidence: 0.5, actions: [{ type: 'pause_source', companySourceId: String(f.data.companySourceId), reason: f.summary }, attention('A job board keeps failing', f.summary)] };
    case 'apply_failures':
      return { diagnosis: 'Applications keep failing on this ATS; paused for a day.', confidence: 0.5, actions: [{ type: 'pause_plugin', pluginId: String(f.data.pluginId), hours: 24, reason: f.summary }, attention(`${String(f.data.pluginId)} keeps failing`, f.summary)] };
    case 'stuck_pipeline': {
      const jobs = (f.data.jobs as { jobId: string }[] | undefined) ?? [];
      return f.data.state === 'referral_pending'
        ? { diagnosis: 'Referral waits ran past their window; advancing to apply.', confidence: 0.7, actions: jobs.slice(0, 10).map((j) => ({ type: 'advance_job' as const, jobId: j.jobId })) }
        : { diagnosis: 'Jobs wait to be applied to.', confidence: 0.6, actions: [attention('Jobs are waiting to be applied to', f.summary)] };
    }
    case 'llm_budget':
      return { diagnosis: "Today's LLM budget is spent.", confidence: 1, actions: [{ type: 'pause_llm' }, attention('LLM budget reached', `${f.summary}. LLM steps are paused until tomorrow (UTC).`)] };
    case 'bounce_rate':
      return { diagnosis: 'Too many bounces hurt deliverability; email outreach paused.', confidence: 0.7, actions: [{ type: 'pause_plugin', pluginId: 'actor-gmail-outreach', hours: 24, reason: f.summary }, attention('Emails are bouncing', `${f.summary}. Email outreach is paused for 24 h; check the contact addresses.`)] };
    default:
      return { diagnosis: f.summary, confidence: 0.5, actions: [attention(f.summary, `${f.summary}\n\n${JSON.stringify(f.data).slice(0, 1500)}`)] };
  }
}

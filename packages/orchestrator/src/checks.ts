import { sql, type DB } from '@quarry/db';
import type { OrchestratorConfig } from '@quarry/shared';

// Phase 22: the monitor. Deterministic SQL health checks; each failing one is a
// Finding routed to one expert. No LLM here.

export type ExpertName = 'sources' | 'outreach' | 'apply' | 'resume' | 'ops';

export interface Finding {
  checkId: string;
  /** Subject within the check (board id, plugin id, …); fingerprint = check:key. */
  key: string;
  severity: 'warn' | 'error' | 'critical';
  summary: string;
  /** The newest piece of evidence (the latest failure, the latest LLM call). */
  evidenceAt: Date | null;
  data: Record<string, unknown>;
  expert: ExpertName;
  /** Captcha / checkpoint / login walls: pause + notify, never automated. */
  humanOnly?: boolean;
}

export const fingerprintOf = (f: Pick<Finding, 'checkId' | 'key'>) => `${f.checkId}:${f.key}`;

export interface CheckContext {
  db: DB;
  config: OrchestratorConfig;
  now: Date;
}

type Check = (c: CheckContext) => Promise<Finding[]>;
const d = (v: unknown) => (v ? new Date(String(v)) : null);

/** A board whose last N fetches all failed (paused boards excluded). */
const sourceErrors: Check = async ({ db, config, now }) => {
  const n = config.checks.sourceErrorStreak;
  const rows = await db.execute<{ id: string; ats: string; token: string | null; company: string; failed: number; total: number; last_at: string; errors: (string | null)[]; permanent: number }>(sql`
    with ranked as (
      select e.subject_id, e.kind, e.payload, e.created_at,
             row_number() over (partition by e.subject_id order by e.created_at desc) as rn
      from events e
      where e.kind in ('source.run.succeeded', 'source.run.failed') and e.created_at > ${new Date(now.getTime() - 14 * 86400_000).toISOString()}::timestamptz
    )
    select s.id, s.ats_type as ats, s.board_token as token, c.name as company,
           count(*) filter (where r.kind = 'source.run.failed')::int as failed, count(*)::int as total,
           max(r.created_at) as last_at, array_agg(r.payload->>'error' order by r.created_at desc) as errors,
           count(*) filter (where (r.payload->>'permanent')::boolean)::int as permanent
    from ranked r
    join company_sources s on s.id::text = r.subject_id
    join companies c on c.id = s.company_id
    where r.rn <= ${n} and s.status = 'active'
    group by s.id, s.ats_type, s.board_token, c.name
    having count(*) = ${n} and count(*) filter (where r.kind = 'source.run.failed') = ${n}`);
  return rows.map((r) => ({
    checkId: 'source_errors',
    key: r.id,
    severity: 'error' as const,
    summary: `${r.company}'s ${r.ats} board (${r.token ?? '-'}) failed its last ${r.failed} fetches: ${r.errors[0] ?? 'unknown error'}`,
    evidenceAt: d(r.last_at),
    data: { companySourceId: r.id, company: r.company, atsType: r.ats, boardToken: r.token, errors: r.errors.slice(0, 5), allPermanent: r.permanent === r.total },
    expert: 'sources' as const,
  }));
};

/** An apply actor that failed (or hit an unrecognised page) on several applications in 24 h (one application's events count once). */
const applyFailures: Check = async ({ db, config, now }) => {
  const since = new Date(now.getTime() - 86400_000).toISOString();
  const rows = await db.execute<{ plugin: string; n: number; last_at: string; errors: (string | null)[]; captures: (string | null)[]; tenants: (string | null)[]; kinds: string[] }>(sql`
    select coalesce(ri.plugin_id, substring(e.kind from '^plugin\\.(.+)\\.step_failed$')) as plugin,
           count(distinct e.subject_id)::int as n, max(e.created_at) as last_at,
           array_agg(coalesce(e.payload->>'error', e.payload->>'reason') order by e.created_at desc) as errors,
           array_agg(e.payload->>'html' order by e.created_at desc) as captures,
           array_agg(e.payload->>'tenant' order by e.created_at desc) as tenants,
           array_agg(e.kind order by e.created_at desc) as kinds
    from events e left join review_items ri on e.subject_type = 'review_item' and ri.id::text = e.subject_id and e.kind like 'application.%'
    where e.created_at > ${since}::timestamptz
      and (e.kind in ('application.failed', 'application.unknown_layout') or e.kind like 'plugin.actor-apply-%.step_failed')
    group by 1
    having count(distinct e.subject_id) >= ${config.checks.applyFailures}`);
  return rows
    .filter((r) => r.plugin)
    .map((r) => ({
      checkId: 'apply_failures',
      key: r.plugin,
      severity: 'error' as const,
      summary: `${r.plugin}: ${r.n} failed application steps in 24 h (latest: ${r.errors.find(Boolean) ?? r.kinds[0]})`,
      evidenceAt: d(r.last_at),
      data: { pluginId: r.plugin, count: r.n, errors: r.errors.filter(Boolean).slice(0, 5), captures: [...new Set(r.captures.filter(Boolean))].slice(0, 3), tenants: [...new Set(r.tenants.filter(Boolean))] },
      expert: 'apply' as const,
    }));
};

/** Jobs that sat in a pipeline state too long. One finding per state. */
const stuckPipeline: Check = async ({ db, config, now }) => {
  const out: Finding[] = [];
  for (const [state, hours] of Object.entries(config.checks.stuckHours)) {
    const before = new Date(now.getTime() - hours * 3600_000).toISOString();
    const rows = await db.execute<{ job_id: string; title: string; company: string; entered: string }>(sql`
      select p.job_id, j.title, c.name as company, p.entered_state_at as entered
      from job_pipeline_state p join jobs j on j.id = p.job_id join companies c on c.id = j.company_id
      where p.state = ${state} and p.entered_state_at < ${before}::timestamptz
      order by p.entered_state_at limit 50`);
    if (!rows.length) continue;
    out.push({
      checkId: 'stuck_pipeline',
      key: state,
      severity: 'warn',
      summary: `${rows.length} job(s) stuck in ${state} for more than ${hours} h`,
      evidenceAt: null,
      data: { state, hours, jobs: rows.map((r) => ({ jobId: r.job_id, title: r.title, company: r.company, since: r.entered })) },
      expert: 'ops',
    });
  }
  return out;
};

/** LLM spend today (UTC) above the budget. */
const llmBudget: Check = async ({ db, config, now }) => {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const [r] = await db.execute<{ usd: number | null; last_at: string | null; calls: number }>(sql`
    select coalesce(sum(cost_usd), 0)::float as usd, max(created_at) as last_at, count(*)::int as calls from llm_calls where created_at >= ${midnight}::timestamptz`);
  if (!r || (r.usd ?? 0) <= config.dailyLlmBudgetUsd) return [];
  return [
    {
      checkId: 'llm_budget',
      key: midnight.slice(0, 10),
      severity: 'critical',
      summary: `LLM spend today is $${(r.usd ?? 0).toFixed(2)} (${r.calls} calls), above the $${config.dailyLlmBudgetUsd} budget`,
      evidenceAt: d(r.last_at),
      data: { usd: r.usd, calls: r.calls, budget: config.dailyLlmBudgetUsd },
      expert: 'ops',
    },
  ];
};

const reviewBacklog: Check = async ({ db, config }) => {
  const [r] = await db.execute<{ n: number }>(sql`select count(*)::int as n from review_items where status = 'pending'`);
  if (!r || r.n <= config.checks.reviewBacklog) return [];
  return [{ checkId: 'review_backlog', key: 'pending', severity: 'warn', summary: `${r.n} review items are waiting for you`, evidenceAt: null, data: { pending: r.n }, expert: 'ops' }];
};

/** Email bounce rate over 7 days. */
const bounceRate: Check = async ({ db, config, now }) => {
  const [r] = await db.execute<{ sent: number; bounced: number; last_at: string | null }>(sql`
    select count(*)::int as sent, count(*) filter (where state = 'bounced')::int as bounced, max(bounced_at) as last_at
    from outreach_threads where channel = 'email' and sent_at > ${new Date(now.getTime() - 7 * 86400_000).toISOString()}::timestamptz`);
  if (!r || r.sent < config.checks.minSends || r.bounced / r.sent <= config.checks.bounceRate) return [];
  return [
    {
      checkId: 'bounce_rate',
      key: '7d',
      severity: 'error',
      summary: `${r.bounced} of ${r.sent} emails bounced in 7 days (${Math.round((100 * r.bounced) / r.sent)}%)`,
      evidenceAt: d(r.last_at),
      data: { sent: r.sent, bounced: r.bounced },
      expert: 'outreach',
    },
  ];
};

/** Captchas, checkpoints and login walls in 24 h: only a human can clear them. */
const blocked: Check = async ({ db, now }) => {
  const rows = await db.execute<{ kind: string; n: number; last_at: string; reasons: (string | null)[] }>(sql`
    select kind, count(*)::int as n, max(created_at) as last_at, array_agg(payload->>'reason' order by created_at desc) as reasons
    from events where kind in ('application.blocked', 'linkedin.paused', 'application.otp_timeout') and created_at > ${new Date(now.getTime() - 86400_000).toISOString()}::timestamptz
    group by kind`);
  return rows.map((r) => ({
    checkId: 'blocked',
    key: r.kind,
    severity: 'critical' as const,
    summary: `${r.kind.replace('.', ' ')} ×${r.n} in 24 h (${r.reasons.find(Boolean) ?? 'needs you'})`,
    evidenceAt: d(r.last_at),
    data: { kind: r.kind, count: r.n, reasons: r.reasons.filter(Boolean).slice(0, 5) },
    expert: 'ops' as const,
    humanOnly: true,
  }));
};

/** Tailoring / matching failing repeatedly in 24 h. */
const stageFailures: Check = async ({ db, config, now }) => {
  const rows = await db.execute<{ kind: string; n: number; last_at: string; errors: (string | null)[] }>(sql`
    select kind, count(*)::int as n, max(created_at) as last_at, array_agg(payload->>'error' order by created_at desc) as errors
    from events where kind in ('tailor.failed', 'match.run.failed', 'discovery.run.failed') and created_at > ${new Date(now.getTime() - 86400_000).toISOString()}::timestamptz
    group by kind having count(*) >= ${config.checks.stageFailures}`);
  return rows.map((r) => ({
    checkId: 'stage_failures',
    key: r.kind,
    severity: 'error' as const,
    summary: `${r.kind} ×${r.n} in 24 h: ${r.errors.find(Boolean) ?? 'no error text'}`,
    evidenceAt: d(r.last_at),
    data: { kind: r.kind, count: r.n, errors: r.errors.filter(Boolean).slice(0, 5) },
    expert: r.kind === 'tailor.failed' ? ('resume' as const) : r.kind === 'discovery.run.failed' ? ('sources' as const) : ('ops' as const),
  }));
};

export const CHECKS: Record<string, Check> = {
  source_errors: sourceErrors,
  apply_failures: applyFailures,
  stuck_pipeline: stuckPipeline,
  llm_budget: llmBudget,
  review_backlog: reviewBacklog,
  bounce_rate: bounceRate,
  blocked,
  stage_failures: stageFailures,
};

/** Run every check; a check that throws becomes a finding itself (the monitor never dies quietly). */
export async function runChecks(c: CheckContext): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [id, check] of Object.entries(CHECKS)) {
    try {
      out.push(...(await check(c)));
    } catch (err) {
      out.push({ checkId: 'monitor', key: id, severity: 'error', summary: `health check ${id} failed: ${(err as Error).message}`, evidenceAt: c.now, data: { check: id }, expert: 'ops' });
    }
  }
  return out;
}

import { randomUUID } from 'node:crypto';
import { appendEvent, countCodeFixesSince, listIncidents, releaseLease, tryLease, updateIncident, upsertIncident, type IncidentLogEntry, type IncidentRow } from '@quarry/db';
import { llmPausedUntil } from '@quarry/core';
import type { LLMClient, Logger, OrchestratorConfig } from '@quarry/shared';
import { executeAction, raiseAttention, type ActionOutcome, type OpsDeps } from './actions.js';
import { fingerprintOf, runChecks, type Finding } from './checks.js';
import { revertMerge, runCodeChange, type CodeChangeOptions, type CodeChangeResult } from './codefix.js';
import { consultExpert, playbook, type ExpertAdvice, type PlannedAction } from './experts.js';

// Phase 22: one orchestrator pass (every 15 min, and after failure events).
//   monitor → findings → one incident per fingerprint →
//     human-only (captcha/checkpoint/login) → attention + notify, never automated;
//     new / still failing after the last action → expert (LLM, or the playbook
//       when there is no LLM or the budget is spent) → ops actions / a code fix;
//     a merged fix is watched for verifyWindowMin: newer evidence = regression →
//       git revert + restart + attention; quiet window = resolved;
//   incidents whose check no longer fires → resolved.
// Max maxCodeFixesPerDay merged fixes; a second failed fix escalates to you.

export interface OrchestratorDeps extends OpsDeps {
  config: OrchestratorConfig;
  log: Logger;
  llm?: () => Promise<LLMClient | undefined>;
  /** Present when code fixes may run (autoFix on). */
  codeChange?: Omit<CodeChangeOptions, 'log'>;
  /** Restart the workers after a merge or a revert (the server exits for its supervisor). */
  restart?: (reason: string) => void;
  /** Push a notification for human-only problems (ntfy). */
  notify?: (title: string, message: string) => Promise<void>;
}

export interface TickResult {
  skipped?: string;
  findings: number;
  opened: string[];
  acted: { incidentId: string; actions: ActionOutcome[]; codeFix?: Pick<CodeChangeResult, 'status' | 'reason' | 'mergeCommit'> }[];
  resolved: string[];
  escalated: string[];
  reverted: string[];
}

const MAX_ATTEMPTS = 3;
/** Findings without timestamped evidence (stuck jobs, backlog) are re-planned at most this often. */
const REACT_AFTER_MS = 6 * 3600_000;

export async function runOrchestratorTick(deps: OrchestratorDeps): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const out: TickResult = { findings: 0, opened: [], acted: [], resolved: [], escalated: [], reverted: [] };
  if (!deps.config.enabled) return { ...out, skipped: 'orchestrator disabled' };
  const owner = randomUUID();
  if (!(await tryLease(deps.db, 'orchestrator.tick', owner, 60 * 60_000))) return { ...out, skipped: 'another pass is running' };
  try {
    const findings = await runChecks({ db: deps.db, config: deps.config, now });
    out.findings = findings.length;
    const seen = new Set<string>();
    for (const f of findings) {
      const fp = fingerprintOf(f);
      seen.add(fp);
      const { incident, created } = await upsertIncident(deps.db, { checkId: f.checkId, fingerprint: fp, severity: f.severity, summary: f.summary, data: f.data, evidenceAt: f.evidenceAt }, now);
      if (created) {
        out.opened.push(incident.id);
        await appendEvent(deps.db, { kind: 'incident.opened', subjectType: 'incident', subjectId: incident.id, payload: { check: f.checkId, summary: f.summary } });
      }
      await handle(deps, f, incident, now, out);
    }
    // Quiet incidents: the check no longer fires.
    for (const inc of await listIncidents(deps.db, { status: ['open', 'acting', 'verifying', 'escalated'], limit: 500 })) {
      if (seen.has(inc.fingerprint)) continue;
      if (inc.status === 'verifying' && inc.verifyUntil && inc.verifyUntil > now) continue; // still watching
      await resolve(deps, inc, now, 'the check no longer fires', out);
    }
    return out;
  } finally {
    await releaseLease(deps.db, 'orchestrator.tick', owner);
  }
}

async function resolve(deps: OrchestratorDeps, inc: IncidentRow, now: Date, why: string, out: TickResult): Promise<void> {
  await updateIncident(deps.db, inc.id, { status: 'resolved', resolvedAt: now, log: [{ at: now.toISOString(), kind: 'resolved', why }] }, now);
  await appendEvent(deps.db, { kind: 'incident.resolved', subjectType: 'incident', subjectId: inc.id, payload: { why } });
  out.resolved.push(inc.id);
}

async function escalate(deps: OrchestratorDeps, inc: IncidentRow, now: Date, title: string, message: string, out: TickResult, extra: IncidentLogEntry[] = []): Promise<void> {
  const attentionId = await raiseAttention(deps.db, { title, message, incidentId: inc.id });
  await updateIncident(deps.db, inc.id, { status: 'escalated', log: [...extra, { at: now.toISOString(), kind: 'escalated', title, attentionId }] }, now);
  await appendEvent(deps.db, { kind: 'incident.escalated', subjectType: 'incident', subjectId: inc.id, payload: { title } });
  await deps.notify?.(title, message).catch((err: unknown) => deps.log.warn({ err: (err as Error).message }, 'notification failed'));
  out.escalated.push(inc.id);
}

async function handle(deps: OrchestratorDeps, f: Finding, inc: IncidentRow, now: Date, out: TickResult): Promise<void> {
  if (inc.status === 'escalated') return; // waiting for you (resolves itself once the check stops firing)

  if (inc.status === 'verifying') {
    const fix = [...(inc.log as IncidentLogEntry[])].reverse().find((e) => e.kind === 'code_fix' && e.status === 'merged');
    const mergedAt = fix ? new Date(fix.at) : inc.actedAt;
    if (f.evidenceAt && mergedAt && f.evidenceAt > mergedAt && fix?.mergeCommit && deps.codeChange) {
      // Regression inside the verify window: undo the merge.
      const r = await revertMerge({ ...deps.codeChange, log: deps.log }, String(fix.mergeCommit), `regression of incident ${inc.id} (${f.checkId})`);
      const entry: IncidentLogEntry = { at: now.toISOString(), kind: 'revert', ok: r.ok, ...(r.commit ? { commit: r.commit } : {}), ...(r.error ? { error: r.error } : {}) };
      if (r.ok) {
        out.reverted.push(inc.id);
        await appendEvent(deps.db, { kind: 'incident.reverted', subjectType: 'incident', subjectId: inc.id, payload: { mergeCommit: fix.mergeCommit, revert: r.commit } });
        deps.restart?.(`reverted the fix for incident ${inc.id}`);
      }
      await updateIncident(deps.db, inc.id, { attempts: inc.attempts + 1 }, now);
      await escalate(deps, inc, now, `An automatic fix made things worse and was ${r.ok ? 'reverted' : 'NOT reverted'}`, `${f.summary}\n\nThe fix merged as ${String(fix.mergeCommit).slice(0, 10)} (branch ${String(fix.branch)}) did not hold: the check failed again after it. ${r.ok ? `It was reverted (${r.commit?.slice(0, 10)}).` : `Reverting failed: ${r.error}. Revert it by hand.`}`, out, [entry]);
      return;
    }
    if (inc.verifyUntil && inc.verifyUntil > now) return; // keep watching
    await resolve(deps, inc, now, 'no new failures during the verify window', out);
    return;
  }

  if (f.humanOnly) {
    await escalate(deps, inc, now, 'Quarry needs you (blocked by a captcha, checkpoint or login wall)', `${f.summary}\n\nThese are never automated. The affected loop is paused; clear it by hand, then resolve this item.`, out);
    return;
  }

  if (inc.status === 'acting' && inc.actedAt) {
    const stillOld = f.evidenceAt ? f.evidenceAt <= inc.actedAt : now.getTime() - inc.actedAt.getTime() < REACT_AFTER_MS;
    if (stillOld) return; // give the last action time to work
    if (inc.attempts + 1 >= MAX_ATTEMPTS) {
      await escalate(deps, inc, now, `Could not fix: ${f.checkId}`, `${f.summary}\n\nThe orchestrator tried ${inc.attempts + 1} times. See the incident log on the Health tab.`, out);
      return;
    }
    await updateIncident(deps.db, inc.id, { attempts: inc.attempts + 1 }, now);
    inc = { ...inc, attempts: inc.attempts + 1 };
  }

  const advice = await advise(deps, f, inc, now);
  const results: ActionOutcome[] = [];
  let codeFix: CodeChangeResult | undefined;
  for (const a of advice.plan.actions) {
    if (a.type === 'code_fix') {
      codeFix = await tryCodeFix(deps, f, inc, a, advice, now);
      continue;
    }
    results.push(await executeAction(deps, a, inc.id));
  }
  const log: IncidentLogEntry[] = [
    { at: now.toISOString(), kind: 'plan', source: advice.source, diagnosis: advice.plan.diagnosis, confidence: advice.plan.confidence, actions: advice.plan.actions },
    ...results.map((r) => ({ at: now.toISOString(), kind: 'action', ...r })),
  ];
  if (codeFix) log.push({ at: now.toISOString(), kind: 'code_fix', status: codeFix.status, branch: codeFix.branch, files: codeFix.files, ...(codeFix.mergeCommit ? { mergeCommit: codeFix.mergeCommit } : {}), ...(codeFix.reason ? { reason: codeFix.reason } : {}), ...(codeFix.summary ? { summary: codeFix.summary.slice(0, 1500) } : {}) });

  const merged = codeFix?.status === 'merged';
  const fixFailed = codeFix && !merged;
  const attempts = fixFailed ? inc.attempts + 1 : inc.attempts;
  await updateIncident(
    deps.db,
    inc.id,
    {
      status: merged ? 'verifying' : 'acting',
      expert: f.expert,
      diagnosis: advice.plan.diagnosis,
      actedAt: now,
      attempts,
      ...(merged ? { verifyUntil: new Date(now.getTime() + deps.config.verifyWindowMin * 60_000) } : {}),
      ...(advice.costUsd ? { addCostUsd: advice.costUsd } : {}),
      log,
    },
    now,
  );
  out.acted.push({ incidentId: inc.id, actions: results, ...(codeFix ? { codeFix: { status: codeFix.status, ...(codeFix.reason ? { reason: codeFix.reason } : {}), ...(codeFix.mergeCommit ? { mergeCommit: codeFix.mergeCommit } : {}) } } : {}) });
  await appendEvent(deps.db, { kind: 'incident.acted', subjectType: 'incident', subjectId: inc.id, payload: { source: advice.source, actions: results.map((r) => `${r.type}:${r.ok ? 'ok' : 'fail'}`), codeFix: codeFix?.status ?? null } });
  if (merged) deps.restart?.(`merged the fix for incident ${inc.id}`);
  if (codeFix && !merged && (!deps.config.autoFix || !deps.codeChange)) {
    // No automatic code changes here: the code change the expert asked for goes to you.
    const ask = advice.plan.actions.find((x) => x.type === 'code_fix');
    await escalate(deps, { ...inc, attempts }, now, `A code change is needed: ${f.checkId}`, `${f.summary}\n\nDiagnosis: ${advice.plan.diagnosis}\n\nSuggested change: ${ask?.instructions ?? ask?.title ?? '(none given)'}\n\nAutomatic code fixes are off on this server; make the change (or ask the chatbot to), then resolve this incident.`, out);
  } else if (fixFailed && attempts >= 2) {
    await escalate(deps, { ...inc, attempts }, now, `Automatic fix failed twice: ${f.checkId}`, `${f.summary}\n\nLast attempt (${codeFix!.branch}): ${codeFix!.reason}`, out);
  }
}

async function advise(deps: OrchestratorDeps, f: Finding, inc: IncidentRow, now: Date): Promise<ExpertAdvice> {
  // The budget check itself never spends LLM money; neither does anything while LLM steps are paused.
  const paused = await llmPausedUntil(deps.db, now);
  const llm = f.checkId === 'llm_budget' || paused ? undefined : await deps.llm?.().catch(() => undefined);
  if (llm) {
    try {
      const history = (inc.log as IncidentLogEntry[]).filter((e) => e.kind !== 'resolved').slice(-6);
      return await consultExpert(llm, f, history);
    } catch (err) {
      deps.log.warn({ err: (err as Error).message, check: f.checkId }, 'expert failed; using the playbook');
    }
  }
  return { plan: playbook(f), costUsd: 0, source: 'playbook' };
}

async function tryCodeFix(deps: OrchestratorDeps, f: Finding, inc: IncidentRow, a: PlannedAction, advice: ExpertAdvice, now: Date): Promise<CodeChangeResult> {
  const branch = `orchestrator/fix-${inc.id.slice(0, 8)}`;
  if (!deps.config.autoFix || !deps.codeChange) return { status: 'rejected', branch, files: [], reason: 'automatic code fixes are off' };
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((await countCodeFixesSince(deps.db, midnight)) >= deps.config.maxCodeFixesPerDay) return { status: 'rejected', branch, files: [], reason: `daily limit of ${deps.config.maxCodeFixesPerDay} code fixes reached` };
  const captures = Array.isArray(f.data.captures) ? (f.data.captures as string[]) : [];
  const prompt = [
    `You are fixing an incident in this repository (Quarry, a TypeScript pnpm monorepo; read CLAUDE.md first).`,
    `Incident ${inc.id}: ${f.summary}`,
    `Diagnosis: ${advice.plan.diagnosis}`,
    `What to change: ${a.instructions ?? a.title ?? 'see the diagnosis'}`,
    `Evidence: ${JSON.stringify(f.data).slice(0, 4000)}`,
    captures.length ? `Failure captures (page HTML at the moment it failed; copy what you need into the plugin's fixtures/ for the test): ${captures.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const readDirs = [...new Set(captures.map((c) => c.replace(/\/[^/]+$/, '')))];
  return runCodeChange(
    { ...deps.codeChange, log: deps.log },
    { id: inc.id.slice(0, 8), branchPrefix: 'orchestrator/fix', title: `fix(${f.checkId}): ${(a.title ?? f.summary).slice(0, 72)}`, prompt, requireTest: true, readDirs, body: [`Incident ${inc.id} (${f.checkId}), merged by the orchestrator after typecheck, lint and tests passed.`] },
  );
}

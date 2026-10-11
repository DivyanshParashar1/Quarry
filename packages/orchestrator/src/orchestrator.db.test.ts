import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, getCompanySource, getIncident, listIncidents, listReviewItems, sql, upsertCompany, upsertCompanySource } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { budgetGuardedLlm, llmPausedUntil, LlmPausedError, pausedPlugins, setLlmPausedUntil } from '@quarry/core';
import { createLLMClient, createFakeProvider } from '@quarry/llm';
import { orchestratorConfigSchema, createLogger, type LLMClient } from '@quarry/shared';
import { runOrchestratorTick, spawnExec, type Exec, type OrchestratorDeps, type Plan } from './index.js';

// Phase 22 "done when": injected faults are detected, routed to the right
// expert and resolved — the selector change via an auto-merged patch, and a
// deliberately bad patch auto-reverted.

const adminUrl = testDbAdminUrl();
const log = createLogger({ level: 'silent' });

/** A git repo standing in for the codebase: one plugin selector file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-repo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  mkdirSync(join(dir, 'plugins/actor-apply-workday/src'), { recursive: true });
  writeFileSync(join(dir, 'plugins/actor-apply-workday/src/selectors.ts'), "export const NEXT = 'button[data-automation-id=\"bottom-navigation-next-button\"]';\n");
  writeFileSync(join(dir, 'CLAUDE.md'), '# rules\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

/** Claude Code stand-in: applies `edit` to the worktree it runs in. */
function fakeClaude(edit: (cwd: string) => void): Exec {
  return async (cmd, args, o) => {
    if (cmd === 'claude') {
      edit(o.cwd);
      return { code: 0, stdout: JSON.stringify({ result: 'Changed the Next selector and added a test.' }), stderr: '' };
    }
    return spawnExec(cmd, args, o);
  };
}

const goodFix = (cwd: string) => {
  writeFileSync(join(cwd, 'plugins/actor-apply-workday/src/selectors.ts'), "export const NEXT = 'button[data-automation-id=\"pageFooterNextButton\"]';\n");
  writeFileSync(join(cwd, 'plugins/actor-apply-workday/src/selectors.test.ts'), "import { NEXT } from './selectors';\n// reproduces the capture\n");
};

/** An LLM whose experts answer from a table keyed by check. */
function expertLlm(plans: Record<string, Plan>): LLMClient & { calls: string[] } {
  const calls: string[] = [];
  const provider = createFakeProvider((req) => {
    const check = req.prompt.match(/^Check: (\S+)/)?.[1] ?? '';
    calls.push(check);
    return plans[check] ?? { diagnosis: 'nothing to do', confidence: 0.1, actions: [] };
  }, { costUsd: 0.01 });
  const client = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' });
  return Object.assign(client, { calls });
}

describe.skipIf(!adminUrl)('orchestrator (postgres)', () => {
  let t: TestDb;
  const notified: string[] = [];
  const restarts: string[] = [];
  const advanced: string[] = [];
  const config = orchestratorConfigSchema.parse({ dailyLlmBudgetUsd: 1, verifyWindowMin: 30, codeFix: { gates: [['node', '-e', 'process.exit(0)']], setup: [] } });

  const base = (extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
    db: t.db,
    log,
    config,
    notify: async (title) => void notified.push(title),
    restart: (why) => void restarts.push(why),
    advanceJob: async (jobId) => {
      advanced.push(jobId);
      await t.db.execute(sql`delete from job_pipeline_state where job_id = ${jobId}`);
    },
    ...extra,
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
  });
  afterAll(async () => t?.drop());

  it('a board returning 404s → Sources expert pauses it → resolved once it stops failing', async () => {
    const c = await upsertCompany(t.db, { name: 'Gone Corp' });
    const src = await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: 'gonecorp' });
    for (let i = 0; i < 3; i++) await appendEvent(t.db, { kind: 'source.run.failed', subjectType: 'company_source', subjectId: src.id, payload: { error: 'GET https://boards-api.greenhouse.io/v1/boards/gonecorp/jobs -> 404', permanent: true } });
    const llm = expertLlm({ source_errors: { diagnosis: 'The board was removed (404).', confidence: 0.9, actions: [{ type: 'pause_source', companySourceId: src.id, reason: 'board gone' }] } });

    const r = await runOrchestratorTick(base({ llm: async () => llm }));
    expect(llm.calls).toEqual(['source_errors']);
    expect(r.opened).toHaveLength(1);
    expect((await getCompanySource(t.db, src.id))!.status).toBe('paused');
    const [inc] = await listIncidents(t.db, { status: ['acting'] });
    expect(inc).toMatchObject({ checkId: 'source_errors', expert: 'sources', diagnosis: 'The board was removed (404).' });
    expect(inc!.llmCostUsd).toBeCloseTo(0.01);

    const r2 = await runOrchestratorTick(base({ llm: async () => llm }));
    expect(r2.resolved).toEqual([inc!.id]);
  });

  it('a stuck pipeline state → Ops playbook (no LLM) advances the jobs → resolved', async () => {
    const c = await upsertCompany(t.db, { name: 'Slow Co' });
    const [job] = await t.db.execute<{ id: string }>(sql`
      insert into jobs (company_id, title, normalized_title, fingerprint, locations) values (${c.id}, 'Engineer', 'engineer', 'slow-1', '{}') returning id`);
    await t.db.execute(sql`insert into job_pipeline_state (job_id, state, entered_state_at) values (${job!.id}, 'referral_pending', now() - interval '200 hours')`);

    const r = await runOrchestratorTick(base());
    const acted = r.acted.find((a) => a.actions.some((x) => x.type === 'advance_job'));
    expect(acted!.actions).toEqual([expect.objectContaining({ type: 'advance_job', ok: true })]);
    expect(advanced).toEqual([job!.id]);
    const r2 = await runOrchestratorTick(base());
    expect(r2.resolved).toContain(acted!.incidentId);
  });

  it('a selector change in an apply flow → Apply expert → auto-merged patch, verified over the window', async () => {
    const repo = makeRepo();
    const capDir = mkdtempSync(join(tmpdir(), 'orch-cap-'));
    const cap = join(capDir, 'workday-my-information.html');
    writeFileSync(cap, '<button data-automation-id="pageFooterNextButton">Save and Continue</button>');
    for (let i = 0; i < 2; i++) await appendEvent(t.db, { kind: 'plugin.actor-apply-workday.step_failed', subjectType: 'review_item', subjectId: `ri-${i}`, payload: { tenant: 'acme', step: 'My Information', reason: 'no "Save and Continue" button', html: cap } });
    const llm = expertLlm({
      apply_failures: { diagnosis: 'Workday renamed the Next button for every tenant.', confidence: 0.85, actions: [{ type: 'code_fix', title: 'Workday Next button renamed', instructions: 'Use pageFooterNextButton.' }] },
    });
    const deps = base({ llm: async () => llm, codeChange: { repoDir: repo, worktreeRoot: mkdtempSync(join(tmpdir(), 'orch-wt-')), exec: fakeClaude(goodFix), claude: { command: 'claude', timeoutMs: 60_000 }, setup: [], gates: config.codeFix.gates } });

    const r = await runOrchestratorTick(deps);
    const fix = r.acted.find((a) => a.codeFix)!;
    expect(fix.codeFix).toMatchObject({ status: 'merged' });
    expect(readFileSync(join(repo, 'plugins/actor-apply-workday/src/selectors.ts'), 'utf8')).toContain('pageFooterNextButton');
    const msg = execFileSync('git', ['log', '-2', '--format=%B'], { cwd: repo }).toString();
    expect(msg).toMatch(/fix\(apply_failures\): Workday Next button renamed/);
    expect(msg).not.toMatch(/Co-Authored-By/i);
    expect(restarts.at(-1)).toMatch(/merged the fix/);
    expect((await getIncident(t.db, fix.incidentId))!.status).toBe('verifying');

    // No new failures: after the window the incident is resolved.
    const later = new Date(Date.now() + 31 * 60_000);
    const r2 = await runOrchestratorTick({ ...deps, now: () => later });
    expect(r2.resolved).toContain(fix.incidentId);
  });

  it('a deliberately bad patch that does not hold is reverted automatically and escalated', async () => {
    const repo = makeRepo();
    await t.db.execute(sql`delete from events where kind like 'plugin.actor-apply-%'`);
    const cap = join(mkdtempSync(join(tmpdir(), 'orch-cap-')), 'lever.html');
    writeFileSync(cap, '<form></form>');
    for (let i = 0; i < 2; i++) await appendEvent(t.db, { kind: 'plugin.actor-apply-lever.step_failed', subjectType: 'review_item', subjectId: `rl-${i}`, payload: { tenant: 'x', reason: 'submit not found', html: cap } });
    const bad = (cwd: string) => {
      writeFileSync(join(cwd, 'plugins/actor-apply-workday/src/selectors.ts'), "export const NEXT = '#wrong';\n");
      writeFileSync(join(cwd, 'plugins/actor-apply-workday/src/selectors.test.ts'), '// claims to reproduce\n');
    };
    const llm = expertLlm({ apply_failures: { diagnosis: 'Guess: the selector.', confidence: 0.6, actions: [{ type: 'code_fix', title: 'bad guess', instructions: 'change it' }] } });
    const deps = base({ llm: async () => llm, codeChange: { repoDir: repo, worktreeRoot: mkdtempSync(join(tmpdir(), 'orch-wt-')), exec: fakeClaude(bad), claude: { command: 'claude', timeoutMs: 60_000 }, setup: [], gates: config.codeFix.gates } });

    const r = await runOrchestratorTick(deps);
    const fix = r.acted.find((a) => a.codeFix?.status === 'merged')!;
    expect(readFileSync(join(repo, 'plugins/actor-apply-workday/src/selectors.ts'), 'utf8')).toContain('#wrong');

    // The same failure happens again after the merge → regression.
    await new Promise((res) => setTimeout(res, 20));
    await appendEvent(t.db, { kind: 'plugin.actor-apply-lever.step_failed', subjectType: 'review_item', subjectId: 'rl-9', payload: { tenant: 'x', reason: 'submit not found', html: cap } });
    const r2 = await runOrchestratorTick(deps);
    expect(r2.reverted).toEqual([fix.incidentId]);
    expect(r2.escalated).toContain(fix.incidentId);
    expect(readFileSync(join(repo, 'plugins/actor-apply-workday/src/selectors.ts'), 'utf8')).toContain('bottom-navigation-next-button');
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo }).toString()).toMatch(/^Revert [0-9a-f]{10}: regression of incident/);
    expect(restarts.at(-1)).toMatch(/reverted the fix/);
    const attention = await listReviewItems(t.db, { kind: ['attention'], status: ['pending'] });
    expect(attention.map((a) => (a.draft as { title: string }).title)).toContain('An automatic fix made things worse and was reverted');
    expect(notified).toContain('An automatic fix made things worse and was reverted');
  });

  it('a patch touching a protected path is refused before any gate runs', async () => {
    const repo = makeRepo();
    await t.db.execute(sql`delete from events where kind like 'plugin.actor-apply-%'`);
    await t.db.execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    for (let i = 0; i < 2; i++) await appendEvent(t.db, { kind: 'plugin.actor-apply-taleo.step_failed', subjectType: 'review_item', subjectId: `rt-${i}`, payload: { tenant: 'aa', reason: 'x' } });
    const sneaky = (cwd: string) => {
      writeFileSync(join(cwd, 'CLAUDE.md'), '# rules (relaxed)\n');
      writeFileSync(join(cwd, 'plugins/actor-apply-workday/src/selectors.test.ts'), '// test\n');
    };
    const llm = expertLlm({ apply_failures: { diagnosis: 'x', confidence: 0.5, actions: [{ type: 'code_fix', title: 'relax rules', instructions: 'x' }] } });
    let gatesRan = 0;
    const exec: Exec = async (cmd, args, o) => (cmd === 'node' ? (gatesRan++, { code: 0, stdout: '', stderr: '' }) : fakeClaude(sneaky)(cmd, args, o));
    const r = await runOrchestratorTick(base({ llm: async () => llm, codeChange: { repoDir: repo, worktreeRoot: mkdtempSync(join(tmpdir(), 'orch-wt-')), exec, claude: { command: 'claude', timeoutMs: 60_000 }, setup: [], gates: config.codeFix.gates } }));
    const fix = r.acted.find((a) => a.codeFix)!;
    expect(fix.codeFix).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/protected paths: CLAUDE\.md/) });
    expect(gatesRan).toBe(0);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe('# rules\n');
  });

  it('LLM budget exceeded → LLM steps pause until tomorrow without asking an expert', async () => {
    await t.db.execute(sql`insert into llm_calls (task, provider, model, success, cost_usd, latency_ms) values ('match', 'x', 'm', true, 3.5, 10)`);
    const llm = expertLlm({});
    const r = await runOrchestratorTick(base({ llm: async () => llm }));
    expect(llm.calls).not.toContain('llm_budget');
    expect(r.acted.some((a) => a.actions.some((x) => x.type === 'pause_llm' && x.ok))).toBe(true);
    expect(await llmPausedUntil(t.db)).not.toBeNull();
    await expect(budgetGuardedLlm(llm, t.db).generate({ task: 'match', system: '', prompt: '', schema: orchestratorConfigSchema })).rejects.toBeInstanceOf(LlmPausedError);
  });

  it('captchas / login walls are never automated: attention + notification only', async () => {
    await appendEvent(t.db, { kind: 'application.blocked', subjectType: 'review_item', subjectId: 'rb-1', payload: { reason: 'captcha' } });
    const before = Object.keys(await pausedPlugins(t.db)).length;
    const r = await runOrchestratorTick(base());
    const [inc] = (await listIncidents(t.db, { status: ['escalated'] })).filter((i) => i.checkId === 'blocked');
    expect(r.escalated).toContain(inc!.id);
    expect(notified.some((n) => /captcha, checkpoint or login wall/.test(n))).toBe(true);
    expect((inc!.log as { kind: string }[]).some((e) => e.kind === 'plan')).toBe(false);
    expect(Object.keys(await pausedPlugins(t.db)).length).toBe(before);
  });

  it('without the code-change pipeline (the server default), a proposed code fix escalates to you with the suggestion', async () => {
    await t.db.execute(sql`delete from events where kind like 'plugin.actor-apply-%'`);
    await t.db.execute(sql`update incidents set status = 'resolved' where status <> 'resolved'`);
    await t.db.execute(sql`delete from llm_calls`);
    await setLlmPausedUntil(t.db, null);
    for (let i = 0; i < 2; i++) await appendEvent(t.db, { kind: 'plugin.actor-apply-ashby.step_failed', subjectType: 'review_item', subjectId: `ra-${i}`, payload: { tenant: 'z', reason: 'no submit' } });
    const llm = expertLlm({ apply_failures: { diagnosis: 'Ashby renamed its submit button.', confidence: 0.8, actions: [{ type: 'code_fix', title: 'Ashby submit selector', instructions: 'Use button[type=submit] in actor-apply-ashby.' }] } });
    const r = await runOrchestratorTick(base({ llm: async () => llm }));
    const inc = (await listIncidents(t.db, { status: ['escalated'] })).find((i) => i.checkId === 'apply_failures')!;
    expect(r.escalated).toContain(inc.id);
    const att = (await listReviewItems(t.db, { kind: ['attention'], status: ['pending'] })).find((a) => (a.draft as { title: string }).title === 'A code change is needed: apply_failures');
    expect((att!.draft as { message: string }).message).toMatch(/Use button\[type=submit\] in actor-apply-ashby/);
  });
});

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@jobforge/shared';
import { protectedHits } from './protected.js';

// Phase 22: gated code changes (orchestrator fixes and chatbot changes).
//   1. a git worktree of main on <branchPrefix>/<id>; dependencies installed (setup);
//   2. Claude Code edits it (print mode, edits auto-accepted, no commits);
//   3. refused if nothing changed, a protected path changed, or (fixes) no test changed;
//   4. every gate passes (typecheck, lint, full tests);
//   5. committed (the message names the incident/request, no AI trailer) and merged
//      into main with --no-ff — only when main's working tree is clean;
//   6. the caller restarts the workers and watches; a regression → revertMerge().
// The branch is kept either way (the audit trail); the worktree is removed.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], o: { cwd: string; timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

export const spawnExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cap = (s: string, add: string) => (s.length > 2_000_000 ? s : s + add);
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d.toString())));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d.toString())));
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(o.input ?? '');
  });

export interface CodeChangeOptions {
  repoDir: string;
  /** Where worktrees are created (default <tmp>/jobforge-worktrees, outside the repo so its test run never sees them). */
  worktreeRoot?: string;
  exec?: Exec;
  log: Logger;
  /** The Claude Code CLI and model. */
  claude: { command: string; model?: string | undefined; timeoutMs: number };
  setup: string[][];
  gates: string[][];
  gateTimeoutMs?: number;
}

export interface CodeChangeRequest {
  /** Short unique id (incident id, chat request id). */
  id: string;
  /** e.g. orchestrator/fix, chat/change */
  branchPrefix: string;
  /** First line of the commit message. */
  title: string;
  /** What Claude is asked to do (the guardrails are appended). */
  prompt: string;
  /** A changed *.test.ts is required (fixes must come with a reproducing test). */
  requireTest: boolean;
  /** Extra directories Claude may read (failure captures). */
  readDirs?: string[];
  /** Extra commit-message body lines. */
  body?: string[];
}

export type CodeChangeStatus = 'merged' | 'rejected' | 'failed' | 'blocked';

export interface CodeChangeResult {
  status: CodeChangeStatus;
  branch: string;
  /** The merge commit on main (merged only). */
  mergeCommit?: string;
  files: string[];
  reason?: string;
  /** Claude's own summary of what it changed. */
  summary?: string;
  gateLog?: { cmd: string; code: number; tail: string }[];
}

const tail = (s: string, n = 3000) => (s.length > n ? s.slice(-n) : s);

export function guardrailPrompt(requireTest: boolean): string {
  return [
    'Rules for this change (enforced after you finish; breaking one rejects the whole change):',
    '- Edit files only; do not commit, branch, push, or run git commands that change history.',
    '- Never modify CLAUDE.md, .env*, migrations, review/approval gating, dryRun/MODE handling, rate limiters, send caps, cooldowns,',
    '  the LinkedIn gate, the session store, secrets/keychain, robots.txt handling, consent gating, the MCP server, or orchestrator/chatbot guardrails.',
    requireTest
      ? '- Add or update a vitest test (*.test.ts) that reproduces the failure (use the failure capture as a fixture) and passes with your fix.'
      : '- Add or update tests for behaviour you change.',
    '- Run `pnpm typecheck` and the affected tests before you finish. External HTTP only through recorded fixtures.',
    '- Finish with a 2-4 line plain summary of what you changed and why.',
  ].join('\n');
}

export async function runCodeChange(o: CodeChangeOptions, req: CodeChangeRequest): Promise<CodeChangeResult> {
  const exec = o.exec ?? spawnExec;
  const branch = `${req.branchPrefix}-${req.id}`.replace(/[^A-Za-z0-9/_.-]+/g, '-');
  const root = o.worktreeRoot ?? join(tmpdir(), 'jobforge-worktrees');
  const wt = join(root, branch.replace(/\//g, '_'));
  const git = (args: string[], cwd = o.repoDir) => exec('git', args, { cwd, timeoutMs: 120_000 });
  const res = (status: CodeChangeStatus, extra: Partial<CodeChangeResult> = {}): CodeChangeResult => ({ status, branch, files: [], ...extra });

  await mkdir(root, { recursive: true });
  if (existsSync(wt)) await git(['worktree', 'remove', '--force', wt]);
  const add = await git(['worktree', 'add', '-B', branch, wt, 'main']);
  if (add.code !== 0) return res('failed', { reason: `git worktree add failed: ${tail(add.stderr, 500)}` });
  try {
    for (const cmd of o.setup) {
      const r = await exec(cmd[0]!, cmd.slice(1), { cwd: wt, timeoutMs: o.gateTimeoutMs ?? 20 * 60_000 });
      if (r.code !== 0) return res('failed', { reason: `setup "${cmd.join(' ')}" failed: ${tail(r.stderr || r.stdout, 800)}` });
    }

    const args = [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Edit,Write,Glob,Grep,Bash(pnpm:*),Bash(node:*),Bash(npx vitest:*),Bash(npx tsc:*),Bash(git diff:*),Bash(git status:*),Bash(ls:*),Bash(cat:*)',
      '--disallowedTools',
      'Bash(git commit:*),Bash(git push:*),Bash(git reset:*),Bash(git checkout:*),Bash(rm -rf:*)',
      ...(o.claude.model ? ['--model', o.claude.model] : []),
      ...(req.readDirs ?? []).flatMap((d) => ['--add-dir', d]),
    ];
    const claude = await exec(o.claude.command, args, { cwd: wt, timeoutMs: o.claude.timeoutMs, input: `${req.prompt}\n\n${guardrailPrompt(req.requireTest)}` });
    let summary = '';
    try {
      summary = String((JSON.parse(claude.stdout) as { result?: unknown }).result ?? '').trim();
    } catch {
      summary = claude.stdout.trim().slice(0, 2000);
    }
    if (claude.code !== 0) return res('failed', { reason: `Claude Code exited ${claude.code}: ${tail(claude.stderr || claude.stdout, 800)}`, summary });

    await git(['add', '-A'], wt);
    const diff = await git(['diff', '--cached', '--name-only', 'main'], wt);
    const files = diff.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
    if (!files.length) return res('rejected', { reason: 'no change was made', summary });
    const hits = protectedHits(files);
    if (hits.length) return res('rejected', { files, summary, reason: `touches protected paths: ${hits.map((h) => `${h.file} (${h.why})`).join(', ')}` });
    if (req.requireTest && !files.some((f) => /\.test\.ts$/.test(f))) return res('rejected', { files, summary, reason: 'no test was added or changed (a fix must come with a reproducing test)' });

    const gateLog: CodeChangeResult['gateLog'] = [];
    for (const cmd of o.gates) {
      const r = await exec(cmd[0]!, cmd.slice(1), { cwd: wt, timeoutMs: o.gateTimeoutMs ?? 30 * 60_000 });
      gateLog.push({ cmd: cmd.join(' '), code: r.code, tail: tail(r.stdout + r.stderr, 1500) });
      if (r.code !== 0) return res('rejected', { files, summary, gateLog, reason: `gate "${cmd.join(' ')}" failed` });
    }

    const msg = [req.title, '', ...(req.body ?? []), ...(summary ? ['', summary] : [])].join('\n');
    const commit = await git(['commit', '-q', '-m', msg], wt);
    if (commit.code !== 0) return res('failed', { files, summary, gateLog, reason: `commit failed: ${tail(commit.stderr, 500)}` });

    // Merge only into a clean main checkout; otherwise the branch waits for a human.
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (head.stdout.trim() !== 'main' || dirty.stdout.trim()) {
      return res('blocked', { files, summary, gateLog, reason: `main checkout is ${head.stdout.trim() !== 'main' ? `on ${head.stdout.trim()}` : 'not clean'}; branch ${branch} kept for a manual merge` });
    }
    const merge = await git(['merge', '--no-ff', '-q', '-m', `Merge ${branch}: ${req.title}`, branch]);
    if (merge.code !== 0) {
      await git(['merge', '--abort']);
      return res('blocked', { files, summary, gateLog, reason: `merge failed (${tail(merge.stderr, 300)}); branch ${branch} kept` });
    }
    const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    o.log.info({ branch, merge: sha, files }, 'code change merged');
    return res('merged', { files, summary, gateLog, mergeCommit: sha });
  } finally {
    await git(['worktree', 'remove', '--force', wt]);
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}

/** Undo a merged change on main (a regression in the verify window). */
export async function revertMerge(o: Pick<CodeChangeOptions, 'repoDir' | 'exec' | 'log'>, mergeCommit: string, reason: string): Promise<{ ok: boolean; commit?: string; error?: string }> {
  const exec = o.exec ?? spawnExec;
  const git = (args: string[]) => exec('git', args, { cwd: o.repoDir, timeoutMs: 120_000 });
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.stdout.trim()) return { ok: false, error: 'main checkout is not clean; revert by hand' };
  const r = await git(['revert', '--no-edit', '-m', '1', mergeCommit]);
  if (r.code !== 0) {
    await git(['revert', '--abort']);
    return { ok: false, error: tail(r.stderr || r.stdout, 500) };
  }
  await git(['commit', '--amend', '-q', '-m', `Revert ${mergeCommit.slice(0, 10)}: ${reason}`]);
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  o.log.warn({ reverted: mergeCommit, commit: sha }, 'code change reverted');
  return { ok: true, commit: sha };
}

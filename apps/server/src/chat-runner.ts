import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addChatMessage, getChatSession, listChatSessions, updateChatSession, type DB } from '@jobforge/db';
import { gateAndMerge, spawnExec, type CodeChangeResult, type Exec } from '@jobforge/orchestrator';
import type { Logger } from '@jobforge/shared';

// The chatbot. Each message runs Claude Code (print mode, streaming JSON) in the
// chat session's own git worktree of main, with:
//   - the JobForge MCP tools (the whole product through the HTTP API) — except
//     `approve`: the chatbot drafts, you approve in the Review tab;
//   - web search / fetch (e.g. reading a job description from a link);
//   - Read/Edit/Write and any shell command, to run its own scripts (scratch
//     files go in .chat-scratch/, which git ignores) — except a deny list: no
//     curl/wget/ssh, no git history changes, no sudo / rm -rf / chmod / keychain.
// When the run ends, any code it changed goes through the gated pipeline:
// protected paths refused → typecheck, lint, tests → commit → merge into a clean
// main (or the branch is kept and you're told why). The conversation resumes
// across messages (--resume).

export interface ChatRunnerOptions {
  db: DB;
  log: Logger;
  repoDir: string;
  /** Where session worktrees live (outside the repo). */
  worktreeRoot: string;
  /** The server's own API, for the MCP tools. */
  apiUrl: string;
  claude: { command: string; model?: string | undefined; timeoutMs: number };
  setup: string[][];
  gates: string[][];
  /** false = code edits are allowed but never merged (branch kept for you). */
  mergeCodeChanges: boolean;
  maxConcurrent: number;
  /** Test seams. */
  exec?: Exec;
  spawnClaude?: (args: string[], o: { cwd: string; input: string }) => ChildProcess;
}

export const CHAT_RULES = `You are the JobForge assistant, running inside the user's JobForge checkout (a self-hosted job-search pipeline; read CLAUDE.md for the rules — they bind you too).

You can:
- operate the product through the jobforge MCP tools: search jobs, add a job from a link (fetch the page with WebFetch first, then add_job with the full description), tailor resumes, draft referral asks / outreach / applications, check the pipeline, health and incidents, run the orchestrator, import contacts, discover companies;
- read the web (WebSearch, WebFetch);
- read and change the codebase in this working copy, and run shell commands and your own scripts (pnpm, pnpm jf …, node, npx tsx, python3, …). Put throwaway scripts and notes in .chat-scratch/ (ignored by git). You are in your own working copy; the user's main checkout is the repository root you came from. No curl/wget (use WebFetch), no git commands that change history, no sudo.

Hard rules:
- You never approve, send, submit or publish anything. Drafts go to the review queue; tell the user what is waiting for them in the Review tab. Never try to reach the approve endpoints another way.
- Never invent facts about the user: resumes, answers and messages come only from their profile.
- Code changes: edit files here; do not commit, branch, reset or push. When you finish, the server checks your change (protected safety files are refused: approval/review gating, dryRun/MODE, rate limits and caps, cooldowns, the LinkedIn gate, secrets/keychain, robots.txt, consent gating, migrations, the MCP server, CLAUDE.md, orchestrator/chat guardrails), runs typecheck, lint and the full test suite, and merges it only if all pass. Add or update tests for what you change. Mention that the server needs a restart to load server-side code changes.
- No logins, no captchas, no account creation on third-party sites.
Be brief: say what you did, what is waiting for the user, and anything that failed.`;

const ALLOWED = [
  'mcp__jobforge',
  'WebFetch',
  'WebSearch',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'TodoWrite',
  // Any shell command (it runs its own scripts, cd, pipes, …) — minus the deny list below, which wins.
  // Claude Code checks each part of a compound command (a; b | c) separately.
  'Bash',
];
const DISALLOWED = [
  'mcp__jobforge__approve',
  // Network clients outside the MCP tools (the approve endpoints must stay out of reach).
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(nc:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  // History stays the server's job (the gated merge).
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git reset:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git branch:*)',
  'Bash(git worktree:*)',
  'Bash(git config:*)',
  // Machine-level changes.
  'Bash(sudo:*)',
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(chmod:*)',
  'Bash(chown:*)',
  'Bash(security:*)',
  'Bash(launchctl:*)',
  'Bash(crontab:*)',
];

export function chatClaudeArgs(o: { mcpConfig: string; resume: string | null; model?: string | undefined }): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--mcp-config',
    o.mcpConfig,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED.join(','),
    '--disallowedTools',
    DISALLOWED.join(','),
    '--append-system-prompt',
    CHAT_RULES,
    ...(o.resume ? ['--resume', o.resume] : []),
    ...(o.model ? ['--model', o.model] : []),
  ];
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }> | string };
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  num_turns?: number;
}

const short = (v: unknown, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export class ChatRunner {
  private readonly running = new Map<string, ChildProcess | null>();

  constructor(private readonly o: ChatRunnerOptions) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** Mark runs a crash/restart interrupted. */
  async recover(): Promise<void> {
    for (const s of await listChatSessions(this.o.db, 500)) {
      if (s.status !== 'running') continue;
      await updateChatSession(this.o.db, s.id, { status: 'idle' });
      await addChatMessage(this.o.db, { sessionId: s.id, role: 'system', content: 'The previous request was interrupted (server restart).' });
    }
  }

  /** Start handling a message in the background. Throws when this session is busy or too many run at once. */
  async send(sessionId: string, text: string): Promise<{ done: Promise<void> }> {
    if (this.running.has(sessionId)) throw Object.assign(new Error('this chat is still working on the previous message'), { statusCode: 409 });
    if (this.running.size >= this.o.maxConcurrent) throw Object.assign(new Error(`${this.running.size} chats are running; try again shortly`), { statusCode: 429 });
    const session = await getChatSession(this.o.db, sessionId);
    if (!session) throw Object.assign(new Error('no such chat'), { statusCode: 404 });
    this.running.set(sessionId, null);
    await addChatMessage(this.o.db, { sessionId, role: 'user', content: text });
    await updateChatSession(this.o.db, sessionId, { status: 'running' });
    const done = this.run(sessionId, session.claudeSessionId, text)
      .catch(async (err: unknown) => {
        this.o.log.error({ err: (err as Error).message, sessionId }, 'chat run failed');
        await addChatMessage(this.o.db, { sessionId, role: 'system', content: `Something went wrong: ${(err as Error).message}` });
      })
      .finally(async () => {
        this.running.delete(sessionId);
        await updateChatSession(this.o.db, sessionId, { status: 'idle' }).catch(() => {});
      });
    return { done };
  }

  stop(sessionId: string): boolean {
    const child = this.running.get(sessionId);
    if (!child) return false;
    child.kill('SIGTERM');
    return true;
  }

  async remove(sessionId: string): Promise<void> {
    this.stop(sessionId);
    const wt = this.worktree(sessionId);
    if (existsSync(wt)) await this.git(['worktree', 'remove', '--force', wt]).catch(() => undefined);
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }

  private worktree(sessionId: string): string {
    return join(this.o.worktreeRoot, sessionId);
  }

  private branch(sessionId: string): string {
    return `chat/${sessionId.slice(0, 8)}`;
  }

  private git(args: string[], cwd = this.o.repoDir) {
    return (this.o.exec ?? spawnExec)('git', args, { cwd, timeoutMs: 120_000 });
  }

  /** The session's worktree, on a branch that starts from the current main. */
  private async prepare(sessionId: string): Promise<string> {
    const wt = this.worktree(sessionId);
    const branch = this.branch(sessionId);
    const exec = this.o.exec ?? spawnExec;
    if (!existsSync(wt)) {
      await mkdir(this.o.worktreeRoot, { recursive: true });
      const add = await this.git(['worktree', 'add', '-B', branch, wt, 'main']);
      if (add.code !== 0) throw new Error(`could not create the chat's working copy: ${add.stderr.slice(0, 300)}`);
      for (const cmd of this.o.setup) {
        const r = await exec(cmd[0]!, cmd.slice(1), { cwd: wt, timeoutMs: 20 * 60_000 });
        if (r.code !== 0) throw new Error(`setup "${cmd.join(' ')}" failed: ${(r.stderr || r.stdout).slice(-400)}`);
      }
    } else {
      // Start every message from the latest main (earlier changes were merged or parked on a branch).
      const sync = await this.git(['reset', '--hard', '-q', 'main'], wt);
      if (sync.code !== 0) throw new Error(`could not refresh the chat's working copy: ${sync.stderr.slice(0, 300)}`);
    }
    await mkdir(join(wt, '.chat-scratch'), { recursive: true });
    return wt;
  }

  private async run(sessionId: string, resume: string | null, text: string): Promise<void> {
    const wt = await this.prepare(sessionId);
    const mcpConfig = join(wt, '.chat-scratch', 'mcp.json');
    await writeFile(
      mcpConfig,
      JSON.stringify({ mcpServers: { jobforge: { command: 'npx', args: ['tsx', join(this.o.repoDir, 'apps/mcp/src/index.ts')], env: { JOBFORGE_API_URL: this.o.apiUrl } } } }, null, 2),
    );
    const args = chatClaudeArgs({ mcpConfig, resume, model: this.o.claude.model });
    const child = (this.o.spawnClaude ?? ((a, so) => spawn(this.o.claude.command, a, { cwd: so.cwd, stdio: ['pipe', 'pipe', 'pipe'] })))(args, { cwd: wt, input: text });
    this.running.set(sessionId, child);
    child.stdin?.end(text);
    const timer = setTimeout(() => child.kill('SIGTERM'), this.o.claude.timeoutMs);

    let buffer = '';
    let stderr = '';
    let final: StreamEvent | null = null;
    // Stored in arrival order (one write at a time).
    let chain: Promise<unknown> = Promise.resolve();
    const pending = { push: (p: () => Promise<unknown>) => (chain = chain.then(p).catch((err: unknown) => this.o.log.warn({ err: (err as Error).message }, 'chat message not stored'))) };
    const handle = (e: StreamEvent) => {
      if (e.type === 'system' && e.subtype === 'init' && e.session_id) pending.push(() => updateChatSession(this.o.db, sessionId, { claudeSessionId: e.session_id! }));
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          if (c.type === 'text' && c.text?.trim()) pending.push(() => addChatMessage(this.o.db, { sessionId, role: 'assistant', content: c.text! }));
          if (c.type === 'tool_use') pending.push(() => addChatMessage(this.o.db, { sessionId, role: 'tool', content: `${c.name}`, meta: { input: short(c.input, 2000) } }));
        }
      }
      if (e.type === 'user' && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          if (c.type === 'tool_result' && c.is_error) pending.push(() => addChatMessage(this.o.db, { sessionId, role: 'tool', content: 'tool error', meta: { error: short(c.content, 1000) } }));
        }
      }
      if (e.type === 'result') {
        final = e;
        if (e.session_id) pending.push(() => updateChatSession(this.o.db, sessionId, { claudeSessionId: e.session_id! }));
      }
    };
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line) as StreamEvent);
        } catch {
          /* not JSON (a warning line) */
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const code = await new Promise<number>((res) => child.on('close', (c) => res(c ?? 1)));
    clearTimeout(timer);
    await chain;
    const result = final as StreamEvent | null;
    if (result) {
      await addChatMessage(this.o.db, {
        sessionId,
        role: 'system',
        content: result.is_error ? `The assistant stopped with an error: ${short(result.result ?? '', 500)}` : 'done',
        meta: { costUsd: result.total_cost_usd ?? null, turns: result.num_turns ?? null, kind: 'result' },
      });
    } else {
      await addChatMessage(this.o.db, { sessionId, role: 'system', content: `Claude Code exited (${code}) without finishing${stderr ? `: ${short(stderr.trim(), 600)}` : ''}` });
    }
    await this.landCodeChange(sessionId, wt, text);
  }

  /** Gate and merge whatever the run changed in the working copy; park it on a branch otherwise. */
  private async landCodeChange(sessionId: string, wt: string, request: string): Promise<void> {
    await this.git(['add', '-A'], wt);
    const changed = (await this.git(['diff', '--cached', '--name-only', 'main'], wt)).stdout.trim();
    if (!changed) return;
    const branch = this.branch(sessionId);
    const title = `chat: ${request.split('\n')[0]!.slice(0, 64)}`;
    let r: CodeChangeResult;
    if (this.o.mergeCodeChanges) {
      await addChatMessage(this.o.db, { sessionId, role: 'system', content: `Checking the code change (${changed.split('\n').length} file(s)): protected paths, typecheck, lint, tests…` });
      r = await gateAndMerge(
        { repoDir: this.o.repoDir, log: this.o.log, gates: this.o.gates, ...(this.o.exec ? { exec: this.o.exec } : {}) },
        { wt, branch, title, body: [`Requested in chat ${sessionId}:`, request.slice(0, 1500)], summary: '', requireTest: false },
      );
    } else {
      r = { status: 'blocked', branch, files: changed.split('\n'), reason: 'merging chat code changes is turned off (chat.mergeCodeChanges)' };
    }
    if (r.status === 'merged') {
      await addChatMessage(this.o.db, {
        sessionId,
        role: 'system',
        content: `Code change merged into main (${r.mergeCommit?.slice(0, 10)}): ${r.files.join(', ')}. Restart the server to load server-side changes.`,
        meta: { kind: 'code_change', ...r },
      });
      return;
    }
    // Keep the work: commit it (if not yet) on a parked branch, then the next message starts clean.
    const parked = `${branch}-parked-${Date.now().toString(36)}`;
    await this.git(['add', '-A'], wt);
    await this.git(['commit', '-q', '-m', `${title} (not merged: ${r.reason ?? r.status})`], wt);
    await this.git(['branch', '-f', parked, 'HEAD'], wt);
    await addChatMessage(this.o.db, {
      sessionId,
      role: 'system',
      content: `Code change NOT merged — ${r.reason ?? r.status}. Kept on branch ${parked} (${r.files.join(', ')}).${r.gateLog?.length ? `\n\n${r.gateLog.at(-1)!.cmd}:\n${r.gateLog.at(-1)!.tail.slice(-1200)}${r.gateLog.at(-1)!.logFile ? `\n(full output: ${r.gateLog.at(-1)!.logFile})` : ''}` : ''}`,
      meta: { kind: 'code_change', ...r, parked },
    });
  }
}

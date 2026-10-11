import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createChatSession, getChatSession, listChatMessages } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createLogger } from '@jobforge/shared';
import { ChatRunner, type ChatRunnerOptions } from './chat-runner.js';
import { buildApi } from './api.js';

// The chatbot runner with a scripted stand-in for Claude Code (a node process that
// streams the CLI's JSON events and edits files in its working copy) and a real
// git repository: messages are stored, the conversation resumes, approve is never
// available, and code changes are gated — merged, or refused and parked on a branch.

const adminUrl = testDbAdminUrl();
const log = createLogger({ level: 'silent' });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-repo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'CLAUDE.md'), '# rules\n');
  writeFileSync(join(dir, '.gitignore'), '.chat-scratch/\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

/** A fake `claude -p --output-format stream-json`: emits events and runs `edit` (JS source) in its cwd. */
function scripted(edit = '', text = 'Done: added the job and drafted 3 referral asks.') {
  const calls: { args: string[]; cwd: string; input: string }[] = [];
  const spawnClaude: ChatRunnerOptions['spawnClaude'] = (args, o) => {
    calls.push({ args, ...o });
    const events = [
      { type: 'system', subtype: 'init', session_id: 'claude-sess-1' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__jobforge__add_job', input: { url: 'https://x.example/j/1' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: false, content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      { type: 'result', subtype: 'success', session_id: 'claude-sess-1', total_cost_usd: 0.12, num_turns: 3, is_error: false, result: text },
    ];
    const script = `${edit}\n${events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('\n')}`;
    return spawn(process.execPath, ['-e', script], { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  };
  return { spawnClaude, calls };
}

describe.skipIf(!adminUrl)('chatbot runner (postgres + git)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
  });
  afterAll(async () => t?.drop());

  const runner = (repo: string, extra: Partial<ChatRunnerOptions> = {}) =>
    new ChatRunner({
      db: t.db,
      log,
      repoDir: repo,
      worktreeRoot: mkdtempSync(join(tmpdir(), 'chat-wt-')),
      apiUrl: 'http://127.0.0.1:3999',
      claude: { command: 'claude', timeoutMs: 60_000 },
      setup: [],
      gates: [['node', '-e', 'process.exit(0)']],
      mergeCodeChanges: true,
      maxConcurrent: 2,
      ...extra,
    });

  it('stores the conversation, resumes the Claude session, never offers approve', async () => {
    const repo = makeRepo();
    const fake = scripted();
    const r = runner(repo, { spawnClaude: fake.spawnClaude });
    const s = await createChatSession(t.db, 'jd link');
    await (await r.send(s.id, 'Tailor my resume for https://x.example/j/1 and draft referrals')).done;
    const msgs = await listChatMessages(t.db, s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Tailor my resume for https://x.example/j/1 and draft referrals'],
      ['tool', 'mcp__jobforge__add_job'],
      ['assistant', 'Done: added the job and drafted 3 referral asks.'],
      ['system', 'done'],
    ]);
    expect(msgs.at(-1)!.meta).toMatchObject({ costUsd: 0.12, turns: 3 });
    expect((await getChatSession(t.db, s.id))).toMatchObject({ claudeSessionId: 'claude-sess-1', status: 'idle' });

    const args = fake.calls[0]!.args;
    const flag = (f: string) => args[args.indexOf(f) + 1]!;
    expect(flag('--disallowedTools').split(',')).toEqual(expect.arrayContaining(['mcp__jobforge__approve', 'Bash(curl:*)', 'Bash(git commit:*)', 'Bash(sudo:*)', 'Bash(rm -rf:*)']));
    expect(flag('--allowedTools').split(',')).toEqual(expect.arrayContaining(['mcp__jobforge', 'WebFetch', 'WebSearch', 'Edit', 'Bash']));
    expect(flag('--append-system-prompt')).toMatch(/never approve, send, submit or publish/);
    expect(args).not.toContain('--resume');
    const mcp = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'));
    expect(mcp.mcpServers.jobforge.env).toEqual({ JOBFORGE_API_URL: 'http://127.0.0.1:3999' });
    expect(fake.calls[0]!.input).toMatch(/^Tailor my resume/);
    expect(fake.calls[0]!.cwd).not.toBe(repo); // its own working copy

    await (await r.send(s.id, 'and now the application draft')).done;
    expect(fake.calls[1]!.args.slice(fake.calls[1]!.args.indexOf('--resume'), fake.calls[1]!.args.indexOf('--resume') + 2)).toEqual(['--resume', 'claude-sess-1']);
  });

  it('merges a code change that passes the gates into main', async () => {
    const repo = makeRepo();
    const r = runner(repo, { spawnClaude: scripted("require('fs').writeFileSync('src/feature.ts', 'export const feature = true;\\n'); require('fs').writeFileSync('.chat-scratch/notes.txt', 'scratch');").spawnClaude });
    const s = await createChatSession(t.db, 'feature');
    await (await r.send(s.id, 'Add a feature flag module')).done;
    expect(readFileSync(join(repo, 'src/feature.ts'), 'utf8')).toContain('feature = true');
    expect(existsSync(join(repo, '.chat-scratch'))).toBe(false); // scratch never lands
    const log1 = execFileSync('git', ['log', '-2', '--format=%s'], { cwd: repo }).toString();
    expect(log1).toMatch(/chat: Add a feature flag module/);
    expect(log1).not.toMatch(/Co-Authored-By/i);
    const last = (await listChatMessages(t.db, s.id)).at(-1)!;
    expect(last.content).toMatch(/^Code change merged into main \([0-9a-f]{10}\): src\/feature\.ts/);
  });

  it('refuses a change to a protected file and parks it on a branch; main is untouched', async () => {
    const repo = makeRepo();
    const r = runner(repo, { spawnClaude: scripted("require('fs').writeFileSync('CLAUDE.md', '# rules (relaxed)\\n');").spawnClaude });
    const s = await createChatSession(t.db, 'rules');
    await (await r.send(s.id, 'Relax the rules')).done;
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe('# rules\n');
    const last = (await listChatMessages(t.db, s.id)).at(-1)!;
    expect(last.content).toMatch(/NOT merged — touches protected paths: CLAUDE\.md/);
    const parked = (last.meta as { parked: string }).parked;
    expect(execFileSync('git', ['show', `${parked}:CLAUDE.md`], { cwd: repo }).toString()).toBe('# rules (relaxed)\n');
  });

  it('a failing gate keeps the change off main, with the gate output', async () => {
    const repo = makeRepo();
    const r = runner(repo, { gates: [['node', '-e', "console.log('2 tests failed'); process.exit(1)"]], spawnClaude: scripted("require('fs').writeFileSync('src/a.ts', 'export const a = 2;\\n');").spawnClaude });
    const s = await createChatSession(t.db, 'gate');
    await (await r.send(s.id, 'Change a')).done;
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect((await listChatMessages(t.db, s.id)).at(-1)!.content).toMatch(/NOT merged — gate "node -e .*" failed[\s\S]*2 tests failed/);
  });

  it('a gate that fails once (a flaky run) is retried before the change is refused', async () => {
    const repo = makeRepo();
    const marker = join(mkdtempSync(join(tmpdir(), 'chat-flaky-')), 'ran-once');
    const flaky = `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.log('FAIL timed out'); process.exit(1); }`;
    const r = runner(repo, { gates: [['node', '-e', flaky]], spawnClaude: scripted("require('fs').writeFileSync('src/b.ts', 'export const b = 1;\\n');").spawnClaude });
    const s = await createChatSession(t.db, 'flaky');
    await (await r.send(s.id, 'Add b')).done;
    expect(existsSync(join(repo, 'src/b.ts'))).toBe(true);
    expect((await listChatMessages(t.db, s.id)).at(-1)!.content).toMatch(/^Code change merged/);
  });

  it('one request at a time per chat; the API starts runs and reports progress', async () => {
    const repo = makeRepo();
    const slow: ChatRunnerOptions['spawnClaude'] = (_args, o) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { cwd: o.cwd });
    const r = runner(repo, { spawnClaude: slow });
    const app: FastifyInstance = await buildApi({ db: t.db, chat: r });
    const H = { 'x-jobforge': '1', 'content-type': 'application/json' };
    const created = (await app.inject({ method: 'POST', url: '/api/chat/sessions', headers: H, payload: '{}' })).json();
    let res = await app.inject({ method: 'POST', url: `/api/chat/sessions/${created.id}/messages`, headers: H, payload: JSON.stringify({ text: 'Find me backend jobs in Bengaluru' }) });
    expect(res.statusCode).toBe(202);
    res = await app.inject({ method: 'POST', url: `/api/chat/sessions/${created.id}/messages`, headers: H, payload: JSON.stringify({ text: 'again' }) });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/chat/sessions/${created.id}` })).json()).toMatchObject({ running: true, session: { title: 'Find me backend jobs in Bengaluru' } });
    for (let i = 0; i < 50 && r.isRunning(created.id); i++) await new Promise((x) => setTimeout(x, 50));
    const body = (await app.inject({ url: `/api/chat/sessions/${created.id}` })).json();
    expect(body.running).toBe(false);
    expect(body.messages.at(-1).content).toMatch(/exited \(0\) without finishing/);
    expect((await app.inject({ method: 'DELETE', url: `/api/chat/sessions/${created.id}`, headers: H, payload: '{}' })).json()).toEqual({ deleted: true });
    await app.close();
  });
});

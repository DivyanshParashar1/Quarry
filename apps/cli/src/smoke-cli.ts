// Smoke test of the `quarry` CLI: runs every read-only command once against your
// database (Postgres up, `pnpm db:migrate` done) and reports exit codes. Nothing
// here sends, submits, approves, writes profile files or spends LLM money.
//   pnpm smoke:cli [--network]   (--network adds the read-only commands that call public sites / Gmail)
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const network = process.argv.includes('--network');

const COMMANDS: Array<{ args: string[]; ok?: number[]; network?: boolean }> = [
  { args: ['--help'] },
  { args: ['companies', 'list'] },
  { args: ['jobs', 'list', '--limit', '5'] },
  { args: ['profile', 'show'], ok: [0, 1] },
  { args: ['llm', 'check'], ok: [0, 1] },
  { args: ['contacts', 'list'] },
  { args: ['review', 'list'] },
  { args: ['review', 'list', '--all'] },
  { args: ['outreach', 'threads'] },
  { args: ['pipeline', 'list'] },
  { args: ['answers'] },
  { args: ['incidents', '--all'] },
  { args: ['linkedin', 'drafts'] },
  { args: ['linkedin', 'status'], ok: [0, 1] },
  { args: ['resumes', 'list'] },
  { args: ['gmail', 'status'], ok: [0, 1], network: true },
  { args: ['gmail', 'alerts', '--since', new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10)], network: true },
  { args: ['discover_ats', 'linear.app'], network: true },
  { args: ['discover_companies', '--list', 'yc', '--dry-run', '--max-new', '3'], network: true },
  { args: ['nonsense-command'], ok: [1, 2] },
];

function run(args: string[]): Promise<{ code: number; out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'apps/cli/src/index.ts', ...args], { cwd: root, env: process.env });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out, ms: Date.now() - started }));
  });
}

let failed = 0;
for (const c of COMMANDS) {
  if (c.network && !network) continue;
  const r = await run(c.args);
  const ok = (c.ok ?? [0]).includes(r.code) && !/\bat .+\.ts:\d+:\d+\)/.test(r.out); // no stack traces
  if (!ok) failed++;
  const last = r.out.trim().split('\n').filter(Boolean).at(-1) ?? '';
  console.log(`${ok ? 'OK  ' : 'FAIL'} quarry ${c.args.join(' ').padEnd(58)} exit ${r.code} · ${String(r.ms).padStart(5)} ms  ${ok ? '' : last.slice(0, 160)}`);
}
console.log(failed ? `\n${failed} command(s) failed` : '\nall commands passed');
process.exit(failed ? 1 : 0);

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@jobforge/shared';

export interface CompileResult {
  pdf: Uint8Array;
  pages: number;
}

export interface CompileOptions {
  tex: string;
  latexBin?: string;
  log: Logger;
  signal: AbortSignal;
  /** Keep the temp dir for debugging. */
  keepTemp?: boolean;
}

/**
 * Compile a complete .tex document to PDF via latexmk. The temp dir is
 * cleaned on success; on failure the latexmk log is included in the error.
 */
export async function compileLatex(opts: CompileOptions): Promise<CompileResult> {
  const latexBin = opts.latexBin ?? process.env.LATEX_BIN ?? 'latexmk';
  const dir = await mkdtemp(join(tmpdir(), 'jf-resume-'));
  const texPath = join(dir, 'resume.tex');
  const pdfPath = join(dir, 'resume.pdf');
  const logPath = join(dir, 'resume.log');

  try {
    await writeFile(texPath, opts.tex, 'utf8');
    await runLatexmk(latexBin, dir, texPath, opts.signal);
    const pdf = await readFile(pdfPath);
    const pages = extractPageCount(await safeRead(logPath));
    return { pdf, pages };
  } catch (err) {
    const log = await safeRead(logPath);
    const detail = log ? `\n--- latexmk log (tail) ---\n${tail(log, 60)}` : '';
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`latexmk failed: ${message}${detail}`);
  } finally {
    if (!opts.keepTemp) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    } else {
      opts.log.info({ dir }, 'tailor: kept temp dir for inspection');
    }
  }
}

function runLatexmk(bin: string, cwd: string, texPath: string, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    // `-no-shell-escape` blocks \write18 / `-shell-escape` style abuse — the
    // Technical Skills section comes from an LLM and could try to invoke
    // shell commands via a crafted fragment if we didn't lock this down.
    const args = ['-pdf', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', texPath];
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', () => {}); // drain
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      rej(e);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) res();
      else rej(new Error(`latexmk exit ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`));
    });
  });
}

async function safeRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

function tail(s: string, lines: number): string {
  const parts = s.split('\n');
  return parts.slice(-lines).join('\n');
}

/** Parse "Output written on resume.pdf (1 page" from the latexmk log. */
export function extractPageCount(log: string | null): number {
  if (!log) return 1;
  const m = log.match(/Output written on [^\s]+ \((\d+) page/);
  return m ? Number(m[1]) : 1;
}

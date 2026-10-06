import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForAuthCode, writeEnvVar } from './gmail-auth.js';

describe('writeEnvVar', () => {
  it('replaces an existing key, appends a missing one, and makes the file owner-only', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jf-env-')), '.env');
    writeFileSync(f, 'A=1\nGMAIL_REFRESH_TOKEN=\nB=2\n', { mode: 0o644 });
    writeEnvVar(f, 'GMAIL_REFRESH_TOKEN', 'tok');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nGMAIL_REFRESH_TOKEN=tok\nB=2\n');
    writeEnvVar(f, 'NEW', 'x');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nGMAIL_REFRESH_TOKEN=tok\nB=2\nNEW=x\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(() => writeEnvVar(f, 'X', 'a\nB=evil')).toThrow(/multi-line/);
  });
});

describe('waitForAuthCode', () => {
  const uri = 'http://127.0.0.1:53999/oauth2callback';

  it('resolves with the code when the state matches', async () => {
    const p = waitForAuthCode(uri, 'st8', 5000);
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${uri}?code=abc&state=st8`)).status).toBe(200);
    await expect(p).resolves.toBe('abc');
  });

  it('rejects a mismatched state or an error redirect', async () => {
    const p = waitForAuthCode(uri, 'st8', 5000);
    const caught = p.catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${uri}?code=abc&state=evil`)).status).toBe(400);
    expect(((await caught) as Error).message).toMatch(/state mismatch/);
  });

  it('refuses non-loopback redirect URIs', async () => {
    await expect(waitForAuthCode('https://example.com/cb', 's')).rejects.toThrow(/loopback/);
  });
});

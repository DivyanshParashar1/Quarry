import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Env } from '@jobforge/shared';
import { DomainRateLimiter, createGmailClient, exchangeGmailCode, gmailAuthUrl, type GmailCredentials } from '@jobforge/core';

// `jf gmail auth`: local OAuth (installed-app flow) against the user's own
// Google OAuth client. The refresh token goes into .env (gitignored, 0600)
// and is never printed or logged.

export function gmailCredentials(env: Env): GmailCredentials {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env (Google Cloud OAuth client, type "Desktop app").');
  }
  return { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, redirectUri: env.GMAIL_REDIRECT_URI };
}

/** Wait for Google to redirect back to our loopback URI; resolves with the code once the state matches. */
export function waitForAuthCode(redirectUri: string, state: string, timeoutMs = 5 * 60_000): Promise<string> {
  const u = new URL(redirectUri);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    return Promise.reject(new Error(`GMAIL_REDIRECT_URI must be an http loopback URL, got ${redirectUri}`));
  }
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== u.pathname) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const ok = !error && code && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain', connection: 'close' });
      res.end(ok ? 'JobForge is connected to Gmail. You can close this tab.' : `Authorization failed: ${error ?? 'state mismatch'}`);
      finish(() => (ok ? resolve(code) : reject(new Error(`authorization failed: ${error ?? 'state mismatch'}`))));
    });
    const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for the Google redirect'))), timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      fn();
    };
    server.on('error', (err) => finish(() => reject(err)));
    server.listen(Number(u.port || 80), u.hostname.replace(/^\[|\]$/g, ''));
  });
}

/** Set KEY=value in a dotenv file (replacing an existing line) and make the file owner-only. */
export function writeEnvVar(path: string, key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error('refusing to write a multi-line env value');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.splice(lines.length - 1, 0, `${key}=${value}`);
  }
  writeFileSync(path, lines.join('\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function gmailAuth(env: Env, envPath: string, print: (s: string) => void): Promise<string> {
  const creds = gmailCredentials(env);
  const state = randomBytes(16).toString('hex');
  print(`Open this URL in your browser and allow access (send + read-only):\n\n  ${gmailAuthUrl(creds, state)}\n`);
  print(`Waiting for the redirect to ${creds.redirectUri} …`);
  const code = await waitForAuthCode(creds.redirectUri, state);
  const { refreshToken } = await exchangeGmailCode(creds, code);
  writeEnvVar(envPath, 'GMAIL_REFRESH_TOKEN', refreshToken);
  const client = await createGmailClient({ ...creds, refreshToken }, new DomainRateLimiter());
  return client.address;
}

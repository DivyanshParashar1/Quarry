import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

// The OS keychain (macOS `security`, Linux `secret-tool`), service "jobforge".
// Used for the session-file key and (Phase 20) per-portal account passwords.
// Both functions fail soft: null / false when no keychain is available.

const run = promisify(execFile);
const SERVICE = 'jobforge';

export async function keychainGet(account: string): Promise<string | null> {
  try {
    if (platform() === 'darwin') {
      const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      return stdout.trim() || null;
    }
    if (platform() === 'linux') {
      const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
      return stdout.trim() || null;
    }
  } catch {
    /* not present / no keychain */
  }
  return null;
}

export async function keychainSet(account: string, secret: string): Promise<boolean> {
  try {
    if (platform() === 'darwin') {
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret]);
      return true;
    }
    if (platform() === 'linux') {
      const child = execFile('secret-tool', ['store', '--label', `JobForge ${account}`, 'service', SERVICE, 'account', account]);
      child.stdin?.end(secret);
      await new Promise<void>((res, rej) => child.on('exit', (c) => (c === 0 ? res() : rej(new Error(`secret-tool exited ${c}`)))).on('error', rej));
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

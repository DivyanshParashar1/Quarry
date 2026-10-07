import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

// Encrypted-at-rest browser session (LinkedIn storageState). The file is
// AES-256-GCM encrypted, mode 600; the key comes from (in order):
//   1. JOBFORGE_SESSION_KEY (env, 32+ chars)
//   2. the OS keychain (macOS `security`, Linux `secret-tool`), created on first use
//   3. a key file in ~/.config/jobforge/session.key (mode 600) — weakest, warned about.
// Cookies never touch the disk in plaintext.

const run = promisify(execFile);
const SERVICE = 'jobforge';
const MAGIC = 'JFSESS1';

export type KeySource = 'env' | 'keychain' | 'keyfile';

export interface SessionKey {
  key: Buffer;
  source: KeySource;
}

async function keychainGet(account: string): Promise<string | null> {
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

async function keychainSet(account: string, secret: string): Promise<boolean> {
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

export async function resolveSessionKey(
  account: string,
  o: { envKey?: string | undefined; keyFile?: string; useKeychain?: boolean } = {},
): Promise<SessionKey> {
  if (o.envKey) return { key: createHash('sha256').update(o.envKey).digest(), source: 'env' };
  if (o.useKeychain !== false) {
    let secret = await keychainGet(account);
    if (!secret) {
      const fresh = randomBytes(32).toString('base64');
      if (await keychainSet(account, fresh)) secret = await keychainGet(account);
    }
    if (secret) return { key: createHash('sha256').update(secret).digest(), source: 'keychain' };
  }
  const file = o.keyFile ?? join(homedir(), '.config', 'jobforge', `${account}.key`);
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  await chmod(file, 0o600);
  return { key: createHash('sha256').update((await readFile(file, 'utf8')).trim()).digest(), source: 'keyfile' };
}

export function encryptJson(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC), iv, cipher.getAuthTag(), body]);
}

export function decryptJson<T = unknown>(data: Buffer, key: Buffer): T {
  if (data.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error('not a JobForge session file');
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data.subarray(MAGIC.length + 28)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

export class SessionStore {
  constructor(
    readonly path: string,
    private readonly key: SessionKey,
  ) {}

  get keySource(): KeySource {
    return this.key.source;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  async load<T = unknown>(): Promise<T | null> {
    if (!this.exists()) return null;
    return decryptJson<T>(await readFile(this.path), this.key.key);
  }

  /** Atomic write, mode 600. */
  async save(value: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, encryptJson(value, this.key.key), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }
}

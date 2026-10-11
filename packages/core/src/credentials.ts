import { randomInt } from 'node:crypto';
import type { CredentialStore } from '@quarry/plugin-sdk';
import { keychainGet, keychainSet } from './keychain.js';

// Phase 20: passwords for accounts a plugin creates on a portal (one per
// Workday tenant). Only in the OS keychain, as account "<pluginId>:<account>";
// never in the DB, events or logs. No keychain → create() throws and the
// application waits for a human, rather than falling back to a weaker store.

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SPECIAL = '!@#$%^&*-_=+?';

/** 20 characters with at least one of each class (portals' usual password rules). */
export function generatePassword(length = 20): string {
  const all = LOWER + UPPER + DIGIT + SPECIAL;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SPECIAL)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface KeychainBackend {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<boolean>;
}

const osKeychain: KeychainBackend = { get: keychainGet, set: keychainSet };

/** The credential store handed to plugins that declare permissions.credentials. */
export function keychainCredentials(pluginId: string, backend: KeychainBackend = osKeychain): CredentialStore {
  const name = (account: string) => `${pluginId}:${account.toLowerCase()}`;
  return Object.freeze({
    get: (account: string) => backend.get(name(account)),
    async create(account: string) {
      const password = generatePassword();
      if (!(await backend.set(name(account), password)) || (await backend.get(name(account))) !== password) {
        throw new Error('no OS keychain available to store the portal password (macOS Keychain or Linux secret-tool); apply by hand');
      }
      return password;
    },
  });
}

import { Resolver } from 'node:dns/promises';
import type { DnsResolver, GmailHandle, MxRecord, PluginManifest } from '@jobforge/plugin-sdk';
import { PluginError } from '@jobforge/shared';

/** MX resolver with a timeout and an in-process cache. No SMTP, ever. */
export function createDnsResolver(opts: { timeoutMs?: number; ttlMs?: number; resolver?: Pick<Resolver, 'resolveMx'> } = {}): DnsResolver {
  const r = opts.resolver ?? new Resolver({ timeout: opts.timeoutMs ?? 5000, tries: 2 });
  const ttl = opts.ttlMs ?? 6 * 3600_000;
  const cache = new Map<string, { at: number; value: MxRecord[] }>();
  return {
    async resolveMx(domain) {
      const key = domain.trim().toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.value;
      let value: MxRecord[];
      try {
        value = (await r.resolveMx(key)).sort((a, b) => a.priority - b.priority);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') value = [];
        else throw err;
      }
      cache.set(key, { at: Date.now(), value });
      return value;
    },
  };
}

/**
 * Narrow a full Gmail client to what the manifest declares. A plugin that
 * didn't ask for `send` gets no send method at all.
 */
export function scopeGmail(full: GmailHandle | undefined, manifest: PluginManifest): GmailHandle | undefined {
  const scopes = manifest.permissions.gmail ?? [];
  if (!scopes.length) return undefined;
  if (!full) throw new PluginError(`${manifest.id} needs Gmail but it is not connected; run \`jf gmail auth\``);
  const h: GmailHandle = { address: full.address };
  if (scopes.includes('send')) {
    if (!full.send) throw new PluginError('Gmail client cannot send');
    h.send = full.send.bind(full);
  }
  if (scopes.includes('read')) {
    if (!full.search || !full.getMessage) throw new PluginError('Gmail client cannot read');
    h.search = full.search.bind(full);
    h.getMessage = full.getMessage.bind(full);
  }
  return Object.freeze(h);
}

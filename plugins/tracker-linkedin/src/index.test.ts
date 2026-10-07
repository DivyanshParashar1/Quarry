import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pluginManifestSchema, SessionBlockedError, type BrowserHandle } from '@jobforge/plugin-sdk';
import { collect, fakeBrowser, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { CONNECTIONS_URL, configSchema, MESSAGING_URL, parseConnections, parseInbox } from './index.js';

const html = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');

describe('tracker-linkedin parsers', () => {
  it('reads accepted connections with dates', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const c = parseConnections(html('connections.html'), now);
    expect(c[0]).toEqual({ profileUrl: 'https://www.linkedin.com/in/ananya-sharma-1a2b3c/', name: 'Ananya Sharma', connectedAt: new Date('2026-10-06T00:00:00Z') });
    expect(c).toHaveLength(2);
  });
  it('reads inbox threads and who spoke last', () => {
    expect(parseInbox(html('messaging.html'))).toEqual([
      { name: 'Rohit Verma', threadUrl: 'https://www.linkedin.com/messaging/thread/2-abc123/', snippet: 'Rohit: Sure, happy to refer you. Send your resume?', fromThem: true, unread: true },
      { name: 'Priya Nair', threadUrl: 'https://www.linkedin.com/messaging/thread/2-def456/', snippet: 'You: Thanks for connecting!', fromThem: false, unread: false },
    ]);
  });
});

describe('tracker-linkedin', () => {
  it('has a valid read-only manifest', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.sideEffects).toBe('none');
  });

  it('yields recent accepts and replies from them only', async () => {
    const browser = fakeBrowser({ pages: { [CONNECTIONS_URL]: html('connections.html'), [MESSAGING_URL]: html('messaging.html') } });
    const events = await collect(plugin.poll(testContext(configSchema.parse({}), undefined, { browser: browser as BrowserHandle, dryRun: false }), new Date(Date.now() - 7 * 86_400_000)));
    expect(events.map((e) => [e.kind, e.data.name])).toEqual([
      ['accepted', 'Ananya Sharma'],
      ['reply', 'Rohit Verma'],
    ]);
  });

  it('stops on a checkpoint', async () => {
    const browser = fakeBrowser({ pages: { [CONNECTIONS_URL]: '<title>Security Verification</title><h1>Let’s do a quick security check</h1>' } });
    await expect(collect(plugin.poll(testContext(configSchema.parse({}), undefined, { browser: browser as BrowserHandle }), new Date()))).rejects.toBeInstanceOf(SessionBlockedError);
  });
});

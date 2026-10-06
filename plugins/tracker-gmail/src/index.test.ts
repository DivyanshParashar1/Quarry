import { describe, expect, it } from 'vitest';
import { pluginManifestSchema } from '@jobforge/plugin-sdk';
import { collect, fakeGmail, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { classify, configSchema } from './index.js';

const meta = (headers: Record<string, string>) => ({ id: 'm', threadId: 't', labelIds: [], internalDate: new Date(), snippet: '', headers });

describe('tracker-gmail', () => {
  it('is read-only', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions.gmail).toEqual(['read']);
  });

  it('classifies replies, bounces, and auto-replies', () => {
    expect(classify(meta({ from: 'Jane <jdoe@acme.com>', subject: 'Re: Payments ledger role' }))).toBe('reply');
    expect(classify(meta({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)' }))).toBe('bounce');
    expect(classify(meta({ from: 'postmaster@acme.com', subject: 'Undeliverable: hi' }))).toBe('bounce');
    expect(classify(meta({ from: 'x@acme.com', subject: 'hi', 'x-failed-recipients': 'jdoe@acme.com' }))).toBe('bounce');
    expect(classify(meta({ from: 'Jane <jdoe@acme.com>', subject: 'Automatic reply: Payments ledger role' }))).toBe('auto_reply');
    expect(classify(meta({ from: 'Jane <jdoe@acme.com>', subject: 'Re: role', 'auto-submitted': 'auto-replied' }))).toBe('auto_reply');
    // A human reply that mentions delivery isn't a bounce.
    expect(classify(meta({ from: 'Jane <jdoe@acme.com>', subject: 'Re: delivery failed?' }))).toBe('reply');
  });

  it('polls the inbox since the cursor, skipping our own and automatic messages', async () => {
    const gmail = fakeGmail('asha@gmail.com');
    const old = gmail.receive({ threadId: 't0', from: 'old@x.com', subject: 'old', at: new Date('2026-09-01T00:00:00Z') });
    gmail.receive({ threadId: 't1', from: 'Jane <jdoe@acme.com>', subject: 'Re: role', body: 'Happy to chat Thursday', at: new Date('2026-10-02T10:00:00Z') });
    gmail.receive({ threadId: 't2', from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', headers: { 'x-failed-recipients': 'bad@acme.com' }, at: new Date('2026-10-02T11:00:00Z') });
    gmail.receive({ threadId: 't3', from: 'Raj <raj@acme.com>', subject: 'Out of office', at: new Date('2026-10-02T12:00:00Z') });
    const events = await collect(plugin.poll(testContext(configSchema.parse({}), undefined, { gmail }), new Date('2026-10-01T00:00:00Z')));
    expect(events.map((e) => [e.kind, e.data.gmailThreadId])).toEqual([
      ['reply', 't1'],
      ['bounce', 't2'],
    ]);
    expect(events[0]!.data.snippet).toBe('Happy to chat Thursday');
    expect(events[1]!.data.failedRecipients).toBe('bad@acme.com');
    expect(old).toBeTruthy();
  });
});

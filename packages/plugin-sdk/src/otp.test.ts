import { describe, expect, it } from 'vitest';
import { extractOtp, OtpTimeoutError, waitForOtp } from './otp.js';
import { fakeGmail } from './testing.js';

const GREENHOUSE_HTML = `<html><body><p>Hi Divyansh,</p><p>Copy and paste this security code into the application form:</p>
<p style="font-size:24px"><strong>8pKz2QxR</strong></p><p>This code expires in 10 minutes. © 2026 Greenhouse</p></body></html>`;

describe('extractOtp', () => {
  it('reads Greenhouse 8-character security codes from HTML', () => {
    expect(extractOtp({ html: GREENHOUSE_HTML, text: null })).toEqual({ code: '8pKz2QxR', link: null });
  });

  it('handles a capitalised phrase and a code followed by more text', () => {
    expect(extractOtp({ text: 'Security Code\nQ7rT2mKa\nThis code expires in 10 minutes.', html: null }).code).toBe('Q7rT2mKa');
  });

  it('reads numeric verification codes (Workday / SmartRecruiters phrasing)', () => {
    expect(extractOtp({ text: 'Your verification code is 482913. It expires in 2026 minutes? No: 15.', html: null }).code).toBe('482913');
    expect(extractOtp({ text: 'Enter the code 7351 to continue your application.', html: null }).code).toBe('7351');
    expect(extractOtp({ text: 'Your one-time passcode: 902114', html: null }).code).toBe('902114');
  });

  it('never mistakes a year or a plain word for a code', () => {
    expect(extractOtp({ text: 'Thanks for applying in 2026. Your code is pending review.', html: null }).code).toBeNull();
    expect(extractOtp({ html: '<p>Your security code is Greenhou</p>', text: null }).code).toBeNull();
  });

  it('finds a verification magic link and skips unsubscribe links', () => {
    const html = '<a href="https://example.com/unsubscribe?x=1">Unsubscribe</a><a href="https://wd3.myworkday.com/acme/verify?token=abc&amp;u=1">Verify your account</a>';
    expect(extractOtp({ html, text: null })).toEqual({ code: null, link: 'https://wd3.myworkday.com/acme/verify?token=abc&u=1' });
  });
});

describe('waitForOtp', () => {
  it('waits for a fresh email from the ATS domain and ignores old or foreign mail', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const since = new Date('2026-10-11T10:00:00Z');
    let t = since.getTime();
    gmail.receive({ threadId: 'old', from: 'Greenhouse <no-reply@greenhouse-mail.io>', subject: 'Security code', body: 'Your security code is 1aB2c3D4', at: new Date(since.getTime() - 10 * 60_000) });
    gmail.receive({ threadId: 'spam', from: 'Phisher <x@evil.example>', subject: 'code', body: 'Your verification code is 111111', at: new Date(since.getTime() + 1000) });
    let polls = 0;
    const p = waitForOtp(gmail, {
      fromDomains: ['greenhouse-mail.io'],
      since,
      pollMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        polls++;
        t += ms;
        if (polls === 2) gmail.receive({ threadId: 'new', from: 'Greenhouse <no-reply@greenhouse-mail.io>', subject: 'Security code', html: GREENHOUSE_HTML, body: '', at: new Date(t) });
      },
    });
    const r = await p;
    expect(r.code).toBe('8pKz2QxR');
    expect(polls).toBe(2);
  });

  it('times out with OtpTimeoutError', async () => {
    const gmail = fakeGmail('me@gmail.com');
    let t = 0;
    await expect(
      waitForOtp(gmail, { fromDomains: ['smartrecruiters.com'], since: new Date(0), timeoutMs: 30_000, pollMs: 10_000, now: () => t, sleep: async (ms) => void (t += ms) }),
    ).rejects.toBeInstanceOf(OtpTimeoutError);
  });
});

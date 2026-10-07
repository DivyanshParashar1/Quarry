import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pluginManifestSchema, rawPostingSchema } from '@jobforge/plugin-sdk';
import { collect, fakeGmail, testContext, testTarget } from '@jobforge/plugin-sdk/testing';
import plugin, { configSchema, parseAlertMessage, PARSERS, tokenize, tokenizeText } from './index.js';

const html = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');
const parser = (id: string) => PARSERS.find((p) => p.id === id)!;
const parse = (id: string, file: string, subject = 'Job alert') => parseAlertMessage(parser(id), { subject, html: html(file), text: null });

describe('tokenize', () => {
  it('splits text at blocks and spans, keeps link text, drops style/script', () => {
    const t = tokenize('<style>.a{}</style><p>Hi <b>there</b></p><a href="https://x.com/a?b=1&amp;c=2">Go<br>now</a><span>A</span>·<span>B</span>');
    expect(t).toEqual([
      { type: 'text', text: 'Hi there' },
      { type: 'link', href: 'https://x.com/a?b=1&c=2', text: 'Go' },
      { type: 'text', text: 'now' },
      { type: 'text', text: 'A' },
      { type: 'text', text: '·' },
      { type: 'text', text: 'B' },
    ]);
  });
  it('tokenizes plain-text bodies', () => {
    expect(tokenizeText('Backend Engineer: https://jobs.x.com/1.\nAcme\n')).toEqual([
      { type: 'link', href: 'https://jobs.x.com/1', text: 'Backend Engineer' },
      { type: 'text', text: 'Acme' },
    ]);
  });
});

describe('alert parsers', () => {
  it('linkedin: dedupes logo/title/button links, splits "Company · Location", canonical URLs', () => {
    const p = parse('linkedin', 'linkedin.html');
    expect(p).toEqual([
      {
        externalId: 'linkedin:4012345678',
        title: 'Software Engineer Intern - 2027',
        company: 'Walmart Global Tech India',
        location: 'Bengaluru, Karnataka, India',
        url: 'https://www.linkedin.com/jobs/view/4012345678/',
        remote: 'hybrid',
      },
      expect.objectContaining({ externalId: 'linkedin:4012399999', title: 'SDE Intern', company: 'Flipkart', location: 'Bengaluru, Karnataka, India' }),
      expect.objectContaining({ externalId: 'linkedin:4012311111', title: 'Graduate Engineer Trainee', company: 'Goldman Sachs', location: 'Hyderabad, Telangana, India' }),
    ]);
  });

  it('naukri: skips experience/salary lines when picking the location', () => {
    expect(parse('naukri', 'naukri.html').map((p) => [p.externalId, p.title, p.company, p.location])).toEqual([
      ['naukri:071025900123', 'Software Engineer', 'Target Corporation India', 'Bengaluru'],
      ['naukri:071025900456', 'Associate Software Developer', 'SAP Labs India', 'Pune, Mumbai'],
    ]);
  });

  it('wellfound, yc, instahyre, internshala, unstop', () => {
    expect(parse('wellfound', 'wellfound.html').map((p) => [p.externalId, p.title, p.company, p.location])).toEqual([
      ['wellfound:2891234', 'Backend Engineer', 'Razorpay', 'Bengaluru'],
      ['wellfound:2899999', 'Founding Engineer', 'Atlan', 'Remote'],
    ]);
    expect(parse('yc', 'yc.html').map((p) => [p.title, p.company, p.location])).toEqual([
      ['Software Engineer, Platform', 'Zepto', 'Mumbai, India'],
      ['New Grad SWE', 'Groww', 'Bengaluru, India / Remote'],
    ]);
    expect(parse('instahyre', 'instahyre.html').map((p) => [p.title, p.company, p.location])).toEqual([
      ['Software Engineer', 'Zeta', 'Bangalore'],
      ['SDE 1', 'Meesho', 'Bangalore'],
    ]);
    const intern = parse('internshala', 'internshala.html');
    expect(intern.map((p) => [p.title, p.company, p.location, p.remote])).toEqual([
      ['Software Development', 'CRED', 'Bangalore', null],
      ['Backend Development', 'Hasura', 'Work From Home', 'remote'],
    ]);
    expect(parse('unstop', 'unstop.html').map((p) => [p.externalId, p.company, p.location])).toEqual([
      ['unstop:1123456', 'Amazon', 'Hyderabad'],
      ['unstop:1123499', 'Myntra', 'Bengaluru'],
    ]);
  });

  it('returns nothing for an unknown template rather than throwing', () => {
    expect(parse('linkedin', 'linkedin-redesigned.html')).toEqual([]);
  });
});

describe('source-gmail-alerts plugin', () => {
  it('has a valid manifest (gmail read only, no network)', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toEqual({ domains: [], gmail: ['read'] });
  });

  it('reads every sender, skips non-alerts, reports unparseable alerts, never crashes', async () => {
    const gmail = fakeGmail('me@example.com');
    const at = new Date('2026-10-05T08:00:00Z');
    gmail.receive({ threadId: 't1', from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: 'Software engineer intern: Walmart and more', html: html('linkedin.html'), at });
    gmail.receive({ threadId: 't2', from: 'Naukri <jobalert@naukri.com>', subject: 'Jobs for you', html: html('naukri.html'), at });
    gmail.receive({ threadId: 't3', from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'Your verification code', html: html('linkedin-security.html'), at });
    gmail.receive({ threadId: 't4', from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: 'Your job alert', html: html('linkedin-redesigned.html'), at });
    gmail.receive({ threadId: 't5', from: 'Unstop <noreply@unstop.com>', subject: 'Jobs', html: html('unstop.html'), at });
    // old message, before the cursor
    gmail.receive({ threadId: 't6', from: 'Unstop <noreply@unstop.com>', subject: 'Old', html: html('unstop.html'), at: new Date('2026-09-01T00:00:00Z') });
    // a template that throws inside the parser path
    const broken = gmail.receive({ threadId: 't7', from: 'Wellfound <talent@wellfound.com>', subject: 'Weekly jobs', html: html('wellfound.html'), at });
    const getBody = gmail.getMessageBody!.bind(gmail);
    gmail.getMessageBody = async (id) => {
      if (id === broken.id) throw new Error('boom');
      return getBody(id);
    };

    const events: [string, Record<string, unknown>][] = [];
    const ctx = testContext(configSchema.parse({}), undefined, { gmail, emit: (k, d) => events.push([k, d]) });
    const postings = await collect(plugin.fetch(ctx, testTarget('inbox', 'n/a', { since: '2026-10-01T00:00:00Z' })));

    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);
    expect(postings.map((p) => p.externalId).sort()).toEqual(
      ['linkedin:4012311111', 'linkedin:4012345678', 'linkedin:4012399999', 'naukri:071025900123', 'naukri:071025900456', 'unstop:1123456', 'unstop:1123499'].sort(),
    );
    expect(postings.find((p) => p.externalId === 'linkedin:4012345678')).toMatchObject({
      companyName: 'Walmart Global Tech India',
      descriptionHtml: null,
      payload: { alert: 'linkedin' },
    });
    expect(events.map(([k, d]) => [k, d.parser])).toEqual([
      ['parse_empty', 'linkedin'],
      ['parse_failed', 'wellfound'],
    ]);
  });

  it('honours the sender allowlist', async () => {
    const gmail = fakeGmail();
    gmail.receive({ threadId: 't1', from: 'jobalerts-noreply@linkedin.com', subject: 'Job alert', html: html('linkedin.html') });
    gmail.receive({ threadId: 't2', from: 'jobalert@naukri.com', subject: 'Job alert', html: html('naukri.html') });
    const ctx = testContext(configSchema.parse({ senders: ['naukri'] }), undefined, { gmail });
    const postings = await collect(plugin.fetch(ctx, testTarget('inbox', 'n/a', { since: '2020-01-01T00:00:00Z' })));
    expect(new Set(postings.map((p) => (p.payload as { alert: string }).alert))).toEqual(new Set(['naukri']));
  });

  it('fails clearly without Gmail', async () => {
    await expect(collect(plugin.fetch(testContext(configSchema.parse({})), testTarget('inbox')))).rejects.toThrow(/jf gmail auth/);
  });
});

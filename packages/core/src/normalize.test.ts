import { describe, it, expect } from 'vitest';
import type { RawPosting } from '@jobforge/plugin-sdk';
import {
  fingerprint,
  htmlToMarkdown,
  inferSeniority,
  normalizeCompanyName,
  normalizePosting,
  normalizeTitle,
} from './normalize.js';

describe('normalizeTitle', () => {
  it.each([
    ['Sr. Software Engineer, Backend', 'senior software engineer backend'],
    ['Software Engineer (m/f/d)', 'software engineer'],
    ['Jr Frontend Dev', 'junior frontend developer'],
    ['C++ Engineer  ', 'c++ engineer'],
    ['SWE II', 'software engineer ii'],
  ])('%s -> %s', (input, out) => expect(normalizeTitle(input)).toBe(out));
});

describe('normalizeCompanyName', () => {
  it('drops legal suffixes and punctuation', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
    expect(normalizeCompanyName('ACME')).toBe('acme');
  });
});

describe('inferSeniority', () => {
  it.each([
    ['Software Engineering Intern', 'intern'],
    ['Senior Software Engineer', 'senior'],
    ['Sr. Backend Engineer', 'senior'],
    ['Staff Engineer, Infra', 'staff'],
    ['Engineering Manager', 'manager'],
    ['VP of Engineering', 'executive'],
    ['Software Engineer I', 'junior'],
    ['New Grad Software Engineer', 'junior'],
    ['Software Engineer', null],
  ])('%s -> %s', (title, level) => expect(inferSeniority(title)).toBe(level));
});

describe('fingerprint', () => {
  it('is stable across cosmetic differences', () => {
    expect(fingerprint('Acme Inc', normalizeTitle('Sr. Engineer'), 'San Francisco, CA')).toBe(
      fingerprint('ACME', normalizeTitle('Senior Engineer'), 'san francisco ca'),
    );
  });
  it('differs by location', () => {
    expect(fingerprint('acme', 'engineer', 'London')).not.toBe(fingerprint('acme', 'engineer', 'Berlin'));
  });
});

describe('htmlToMarkdown', () => {
  it('converts common description markup', () => {
    const md = htmlToMarkdown(
      '<div><h2>About</h2><p>We build <strong>things</strong> &amp; <a href="https://x.io">stuff</a>.</p>' +
        '<ul><li>One</li><li>Two</li></ul><p>Line<br>break</p><script>alert(1)</script></div>',
    );
    expect(md).toBe('### About\n\nWe build **things** & [stuff](https://x.io).\n\n- One\n- Two\n\nLine\nbreak');
  });
  it('does not confuse <br> with <b>', () => {
    expect(htmlToMarkdown('a<br/>b <b>c</b>')).toBe('a\nb **c**');
  });
});

describe('normalizePosting', () => {
  const raw: RawPosting = {
    externalId: '1',
    url: 'https://x.io/1',
    applyUrl: null,
    title: ' Senior  Engineer ',
    locations: ['Remote - US', 'remote - us', '', 'N/A'],
    remotePolicy: null,
    department: null,
    descriptionHtml: '<p>Hi</p>',
    postedAt: null,
    payload: {},
  };
  it('cleans fields, infers remote policy, and falls back to url for applyUrl', () => {
    const n = normalizePosting(raw, 'Acme');
    expect(n.title).toBe('Senior Engineer');
    expect(n.locations).toEqual(['Remote - US']);
    expect(n.remotePolicy).toBe('remote');
    expect(n.seniority).toBe('senior');
    expect(n.descriptionMd).toBe('Hi');
    expect(n.applyUrl).toBe('https://x.io/1');
    expect(n.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

import { describe, expect, it } from 'vitest';
import type { ProfileFact } from '@jobforge/plugin-sdk';
import { extractNumbers, extractProperTerms, validate } from './validator.js';

const facts: ProfileFact[] = [
  {
    id: 'exp-acme',
    kind: 'experience',
    content: 'Backend engineer at Acme (2022-2024). Built the payments ledger service in Go on Postgres, handling 2M transactions/day.',
    metrics: { transactions_per_day: 2_000_000, years: 2 },
    tags: ['go', 'postgres', 'payments'],
  },
  {
    id: 'proj-rank',
    kind: 'project',
    content: 'Shipped a ranking service in Python with Redis caching; cut p99 latency by 40%.',
    metrics: { latency_reduction_pct: 40 },
    tags: ['python', 'redis'],
  },
  { id: 'skill-go', kind: 'skill', content: 'Go (3 years)', metrics: {}, tags: ['go'] },
];

describe('extractors', () => {
  it('picks up proper terms, acronyms and camelCase', () => {
    const terms = extractProperTerms('Shipped Payments ledger using Kafka, DynamoDB and TypeScript');
    expect(terms).toEqual(expect.arrayContaining(['Payments', 'Kafka', 'DynamoDB', 'TypeScript']));
  });

  it('ignores common action verbs and stopwords', () => {
    const terms = extractProperTerms('Shipped and built the service for the team');
    expect(terms).not.toContain('Shipped');
    expect(terms).not.toContain('The');
  });

  it('extracts numbers with scale and percent suffixes', () => {
    expect(extractNumbers('Cut p99 by 40% while handling 2M requests at 99.9% uptime')).toEqual(
      expect.arrayContaining(['40%', '2m', '99.9%']),
    );
  });
});

describe('validate', () => {
  it('keeps bullets that only use terms from the cited fact', () => {
    const v = validate({
      bullets: [
        { factId: 'exp-acme', text: 'Built the Go payments ledger on Postgres handling 2M transactions/day.', section: 'Experience' },
      ],
      header: { summary: 'Backend engineer with Go and Postgres experience.', skills: ['Go', 'Postgres'] },
      facts,
    });
    expect(v.bullets).toHaveLength(1);
    expect(v.report[0]!.status).toBe('ok');
    expect(v.header.skills).toEqual(['Go', 'Postgres']);
  });

  it('drops bullets citing an unknown fact id', () => {
    const v = validate({
      bullets: [{ factId: 'exp-ghost', text: 'Did something.', section: 'Experience' }],
      header: { summary: '', skills: [] },
      facts,
    });
    expect(v.bullets).toHaveLength(0);
    expect(v.dropped).toHaveLength(1);
    expect(v.dropped[0]!.issues.map((i) => i.kind)).toContain('unknown_fact_id');
  });

  it('drops bullets that invent technologies not in the fact', () => {
    const v = validate({
      bullets: [{ factId: 'exp-acme', text: 'Built the payments ledger in Rust with Kafka.', section: 'Experience' }],
      header: { summary: '', skills: [] },
      facts,
    });
    expect(v.bullets).toHaveLength(0);
    expect(v.dropped[0]!.issues.map((i) => i.kind)).toContain('invented_term');
  });

  it('drops bullets that invent numbers not in the fact or metrics', () => {
    const v = validate({
      bullets: [{ factId: 'proj-rank', text: 'Shipped Python ranking service; cut latency by 80%.', section: 'Projects' }],
      header: { summary: '', skills: [] },
      facts,
    });
    expect(v.bullets).toHaveLength(0);
    expect(v.dropped[0]!.issues.map((i) => i.kind)).toContain('invented_number');
  });

  it('flags warnings but keeps long bullets', () => {
    const long = 'Built the Go payments ledger on Postgres handling transactions a '.repeat(6);
    const v = validate({
      bullets: [{ factId: 'exp-acme', text: long, section: 'Experience' }],
      header: { summary: '', skills: [] },
      facts,
      bulletMaxChars: 100,
    });
    expect(v.bullets).toHaveLength(1);
    expect(v.report[0]!.status).toBe('warning');
    expect(v.report[0]!.issues.map((i) => i.kind)).toContain('too_long');
  });

  it('strips invented skills from the header', () => {
    const v = validate({
      bullets: [],
      header: { summary: 'Engineer with experience in payments.', skills: ['Go', 'Haskell', 'Postgres'] },
      facts,
      allowedSkills: ['Go'],
    });
    expect(v.header.skills).toEqual(['Go', 'Postgres']);
    expect(v.headerIssues.find((i) => i.detail.includes('Haskell'))).toBeDefined();
  });
});

import { describe, expect, it } from 'vitest';
import { preferencesSchema, type Job } from '@jobforge/plugin-sdk';
import { applyHardFilters, eligibleBatches, requiredYears } from './filters.js';

const job = (o: Partial<Job> = {}): Job => ({
  id: 'j',
  companyId: 'c',
  company: 'Acme',
  title: 'Software Engineer',
  normalizedTitle: 'software engineer',
  locations: ['Bengaluru, India'],
  remotePolicy: null,
  seniority: null,
  descriptionMd: 'Build things.',
  applyUrl: null,
  postedAt: null,
  embedding: null,
  ...o,
});
const prefs = (o: Record<string, unknown> = {}) => preferencesSchema.parse(o);
const opts = { experienceSlackYears: 2 };
const check = (j: Partial<Job>, p: Record<string, unknown>) => applyHardFilters(job(j), prefs(p), opts);

describe('hard filters', () => {
  it('passes everything with empty preferences', () => {
    expect(check({}, {})).toBeNull();
  });

  it('exclusions: company, title keyword (word-bounded), description keyword', () => {
    expect(check({ company: 'Acme Corp' }, { exclusions: { companies: ['acme'] } })).toMatch(/Excluded company/);
    expect(check({ title: 'Sales Engineer' }, { exclusions: { title_keywords: ['sales'] } })).toMatch(/excluded keyword "sales"/);
    expect(check({ title: 'Wholesale Platform Engineer' }, { exclusions: { title_keywords: ['sales'] } })).toBeNull();
    expect(check({ descriptionMd: 'Requires active Security Clearance.' }, { exclusions: { description_keywords: ['security clearance'] } })).toMatch(
      /security clearance/,
    );
  });

  it('seniority: untagged titles count as mid', () => {
    expect(check({ seniority: 'senior' }, { seniority: ['junior', 'mid'] })).toMatch(/Level senior/);
    expect(check({ seniority: null }, { seniority: ['junior', 'mid'] })).toBeNull();
    expect(check({ seniority: 'junior' }, { seniority: ['junior', 'mid'] })).toBeNull();
  });

  it('location and remote policy', () => {
    const p = { locations: ['Bengaluru', 'Bangalore'], remote_policy: ['remote', 'hybrid'] };
    expect(check({ locations: ['Bangalore, KA'] }, p)).toBeNull();
    expect(check({ locations: ['San Francisco, CA'] }, p)).toMatch(/outside Bengaluru\/Bangalore/);
    expect(check({ locations: ['San Francisco, CA'], remotePolicy: 'remote' }, p)).toBeNull();
    expect(check({ locations: ['Bengaluru'], remotePolicy: 'onsite' }, p)).toMatch(/Onsite roles are not in remote\/hybrid/);
    expect(check({ locations: [] }, p)).toBeNull(); // unknown location: let the LLM judge
    expect(check({ locations: ['Remote'], remotePolicy: 'remote' }, { locations: ['Pune'], remote_policy: ['onsite'] })).toMatch(/Remote roles/);
  });

  it('batch eligibility', () => {
    expect(eligibleBatches('Open to 2024/25 batch graduates')).toEqual([2024, 2025]);
    expect(eligibleBatches('Class of 2026 only')).toEqual([2026]);
    expect(eligibleBatches('Candidates graduating in 2025 or 2026')).toEqual([2025, 2026]);
    expect(eligibleBatches('Founded in 2015, we have 300 people')).toEqual([]);
    expect(check({ descriptionMd: 'Hiring 2025 batch freshers' }, { graduation_year: 2023 })).toMatch(/2025 batch/);
    expect(check({ descriptionMd: 'Hiring 2025 batch freshers' }, { graduation_year: 2025 })).toBeNull();
  });

  it('experience requirements, with slack', () => {
    expect(requiredYears('You have 5+ years of professional software engineering experience and 2 years experience with Go.')).toBe(5);
    expect(requiredYears('3-5 years of experience')).toBe(3);
    expect(requiredYears('We are 10 years old')).toBeNull();
    expect(check({ descriptionMd: '8+ years of experience building APIs' }, { experience_years: 2 })).toMatch(/Asks for 8\+ years/);
    expect(check({ descriptionMd: '4+ years of experience' }, { experience_years: 2 })).toBeNull();
  });
});

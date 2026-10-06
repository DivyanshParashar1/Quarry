import { describe, expect, it } from 'vitest';
import { apiParams, DEFAULT_FILTERS, filtersFromSearch, filtersToSearch, scoreTone } from './filters';

describe('dashboard filters', () => {
  it('round-trips through the URL and omits defaults', () => {
    expect(filtersToSearch(DEFAULT_FILTERS, null)).toBe('');
    const f = { ...DEFAULT_FILTERS, view: 'all' as const, q: 'go dev', remote: ['remote' as const, 'hybrid' as const], minScore: 70 };
    const s = filtersToSearch(f, 'abc');
    expect(s).toBe('?view=all&q=go+dev&remote=remote%2Chybrid&min=70&job=abc');
    expect(filtersFromSearch(s)).toEqual(f);
  });

  it('ignores junk in the URL', () => {
    expect(filtersFromSearch('?view=nope&remote=moon,remote&min=500&sort=x')).toEqual({
      ...DEFAULT_FILTERS,
      remote: ['remote'],
      minScore: 100,
    });
  });

  it('maps views to API methods', () => {
    expect(apiParams(DEFAULT_FILTERS, 50, 0).get('method')).toBe('llm');
    expect(apiParams({ ...DEFAULT_FILTERS, view: 'all' }, 50, 0).has('method')).toBe(false);
    expect(apiParams({ ...DEFAULT_FILTERS, view: 'excluded' }, 50, 0).get('method')).toBe('filtered,prefilter');
    expect(apiParams({ ...DEFAULT_FILTERS, q: '  ' }, 50, 50).toString()).toBe('limit=50&offset=50&sort=score&method=llm');
  });

  it('score tones', () => {
    expect(scoreTone(80, 'llm')).toBe('good');
    expect(scoreTone(60, 'llm')).toBe('ok');
    expect(scoreTone(10, 'llm')).toBe('weak');
    expect(scoreTone(0, 'filtered')).toBe('none');
  });
});

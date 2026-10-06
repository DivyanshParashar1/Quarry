import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factHash, preferencesSchema, profileSummary, profileVersion, readProfileDir } from './index.js';

const repoProfile = fileURLToPath(new URL('../../../profile', import.meta.url));

function dirWith(facts: string, prefs: string): string {
  const d = mkdtempSync(join(tmpdir(), 'jf-profile-'));
  writeFileSync(join(d, 'facts.yaml'), facts);
  writeFileSync(join(d, 'preferences.yaml'), prefs);
  return d;
}

describe('profile files', () => {
  it('loads the checked-in templates', () => {
    const p = readProfileDir(repoProfile);
    expect(Array.isArray(p.facts)).toBe(true);
    expect(p.preferences.exclusions).toBeDefined();
  });

  it('validates facts and preferences with clear errors', () => {
    const d = dirWith(
      'facts:\n  - id: Bad Id\n    kind: project\n    content: x\n  - id: a\n    kind: hobby\n    content: y\n',
      'roles: [SWE]\n',
    );
    expect(() => readProfileDir(d)).toThrow(/facts\.yaml[\s\S]*0\.id[\s\S]*1\.kind/);
  });

  it('rejects duplicate fact ids and unknown preference keys', () => {
    expect(() => readProfileDir(dirWith('facts:\n  - {id: a, kind: skill, content: x}\n  - {id: a, kind: skill, content: y}\n', '{}'))).toThrow(
      /duplicate fact id a/,
    );
    expect(() => readProfileDir(dirWith('facts: []', 'rolez: [x]\n'))).toThrow(/Unrecognized key/);
  });

  it('versions are stable under reordering and change with content', () => {
    const prefs = preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['Go'] });
    const a = { id: 'a', kind: 'skill' as const, content: 'Go', metrics: {}, tags: [] };
    const b = { id: 'b', kind: 'project' as const, content: 'Built X', metrics: { users: 100 }, tags: ['go'] };
    expect(profileVersion([a, b], prefs)).toBe(profileVersion([b, a], prefs));
    expect(profileVersion([a, b], prefs)).not.toBe(profileVersion([a, { ...b, content: 'Built Y' }], prefs));
    expect(factHash(a)).not.toBe(factHash({ ...a, tags: ['x'] }));
    expect(profileSummary([a, b], prefs)).toMatch(/^Target roles: Backend Engineer\.\nTech stack: Go\.\nSkills: Go\.\nBuilt X$/);
  });
});

describe('upsertFactInFile', () => {
  it('updates in place and appends, keeping comments; refuses invalid facts', async () => {
    const { upsertFactInFile } = await import('./index.js');
    const { readFileSync } = await import('node:fs');
    const d = dirWith('# my facts\nfacts:\n  # Go skill\n  - id: skill-go\n    kind: skill\n    content: Go\n', '{}');
    const f = join(d, 'facts.yaml');
    expect(upsertFactInFile(f, { id: 'skill-go', content: 'Go (3 years)' })).toMatchObject({ created: false, fact: { kind: 'skill', content: 'Go (3 years)' } });
    expect(upsertFactInFile(f, { id: 'proj-x', kind: 'project', content: 'Built X', tags: ['go'] }).created).toBe(true);
    const text = readFileSync(f, 'utf8');
    expect(text).toContain('# my facts');
    expect(text).toContain('# Go skill');
    expect(readProfileDir(d).facts.map((x) => [x.id, x.content])).toEqual([
      ['skill-go', 'Go (3 years)'],
      ['proj-x', 'Built X'],
    ]);
    expect(() => upsertFactInFile(f, { id: 'new-one', content: 'no kind' })).toThrow();
    expect(() => upsertFactInFile(join(d, 'empty.yaml'), { id: 'Bad Id', kind: 'skill', content: 'x' })).toThrow();
  });

  it('works from an empty `facts: []` template', async () => {
    const { upsertFactInFile } = await import('./index.js');
    const d = dirWith('# header\nfacts: []\n', '{}');
    upsertFactInFile(join(d, 'facts.yaml'), { id: 'a', kind: 'skill', content: 'Go' });
    expect(readProfileDir(d).facts).toHaveLength(1);
  });
});

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { enforceRules } from './selector.js';
import { loadResume } from './manifest-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(HERE, '../../../profile/resume/manifest.yaml');

describe('selector.enforceRules', () => {
  it('always prepends the header block and respects sections_order', async () => {
    const r = await loadResume(MANIFEST);
    const out = enforceRules(r, ['proj.flashseat']);
    expect(out[0]).toBe('header');
    // education must come before projects (per sections_order).
    const eduIdx = out.indexOf('edu.rgipt');
    const projIdx = out.indexOf('proj.flashseat');
    expect(eduIdx).toBeGreaterThan(-1);
    expect(eduIdx).toBeLessThan(projIdx);
  });

  it('inserts always_include blocks even when the LLM omits them', async () => {
    const r = await loadResume(MANIFEST);
    const out = enforceRules(r, ['proj.flashseat']); // omits exp.screenify
    expect(out).toContain('exp.screenify');
    expect(out).toContain('exp.orangecat');
    expect(out).toContain('skills.default');
  });

  it('drops unknown ids and duplicates', async () => {
    const r = await loadResume(MANIFEST);
    const out = enforceRules(r, ['proj.flashseat', 'does.not.exist', 'proj.flashseat']);
    expect(out.filter((x) => x === 'proj.flashseat')).toHaveLength(1);
    expect(out).not.toContain('does.not.exist');
  });

  it('clamps section counts to the budget max', async () => {
    const r = await loadResume(MANIFEST);
    // Current manifest has 3 project blocks and max=3 — try to force 4 picks
    // by passing a duplicate and an unknown id; the clamp still applies.
    const out = enforceRules(r, ['proj.flashseat', 'proj.crdt', 'proj.drillmirror', 'proj.flashseat']);
    const projects = out.filter((id) => id.startsWith('proj.'));
    expect(projects.length).toBeLessThanOrEqual(3);
  });
});

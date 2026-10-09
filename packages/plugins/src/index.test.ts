import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '@jobforge/shared';
import { createRegistry } from './index.js';

const pluginsDir = join(import.meta.dirname, '..', '..', '..', 'plugins');

describe('createRegistry', () => {
  it('registers every plugin in plugins/', () => {
    const onDisk = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => JSON.parse(readFileSync(join(pluginsDir, d.name, 'package.json'), 'utf8')).name as string)
      .map((name) => name.replace('@jobforge/', ''))
      .sort();
    const registered = createRegistry()
      .list()
      .map((p) => p.manifest.id)
      .sort();
    expect(registered).toEqual(onDisk);
  });

  it('anchors the resume manifest at the repo root, whatever the cwd (the server runs from apps/server)', () => {
    const repo = join(import.meta.dirname, '..', '..', '..');
    const cwd = process.cwd();
    process.chdir(join(repo, 'apps', 'server'));
    try {
      const manifest = (createRegistry().get('tailor-resume-latex').config as { manifestPath: string }).manifestPath;
      expect(manifest).toBe(join(repo, 'profile', 'resume', 'manifest.yaml'));
      expect(existsSync(manifest)).toBe(true);

      const custom = createRegistry(parseAppConfig({ plugins: { 'tailor-resume-latex': { manifestPath: 'profile/resume/other.yaml' } } }));
      expect((custom.get('tailor-resume-latex').config as { manifestPath: string }).manifestPath).toBe(join(repo, 'profile', 'resume', 'other.yaml'));
    } finally {
      process.chdir(cwd);
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});

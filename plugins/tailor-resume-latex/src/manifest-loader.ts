import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resumeManifestSchema, type BlockMeta, type ResumeManifest } from '@jobforge/plugin-sdk';

export interface LoadedResume {
  manifestPath: string;
  rootDir: string;
  manifest: ResumeManifest;
  preamble: string;
  /** Fragment contents keyed by block id. */
  fragments: Map<string, string>;
  /** Fast lookup by block id. */
  blocksById: Map<string, BlockMeta>;
}

export async function loadResume(manifestPath: string): Promise<LoadedResume> {
  const absManifest = isAbsolute(manifestPath) ? manifestPath : resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const raw = await readFile(absManifest, 'utf8');
  const parsed = resumeManifestSchema.parse(parseYaml(raw));

  const preamblePath = resolve(rootDir, 'preamble.tex');
  const preamble = await readFile(preamblePath, 'utf8');

  const fragments = new Map<string, string>();
  const blocksById = new Map<string, BlockMeta>();
  for (const block of parsed.blocks) {
    if (blocksById.has(block.id)) throw new Error(`duplicate block id in manifest: ${block.id}`);
    blocksById.set(block.id, block);
    const abs = resolve(rootDir, block.file);
    fragments.set(block.id, await readFile(abs, 'utf8'));
  }

  if (!blocksById.has(parsed.header_block)) {
    throw new Error(`manifest.header_block "${parsed.header_block}" not found in blocks`);
  }
  for (const section of parsed.sections_order) {
    if (!parsed.sections[section]) throw new Error(`sections_order references unknown section "${section}"`);
  }
  for (const block of parsed.blocks) {
    if (block.section === 'header') continue;
    if (!parsed.sections[block.section]) {
      throw new Error(`block ${block.id} uses section "${block.section}" which has no wrapper in sections`);
    }
  }

  return { manifestPath: absManifest, rootDir, manifest: parsed, preamble, fragments, blocksById };
}

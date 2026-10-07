import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isMap, isSeq, parse as parseYaml, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { resumeManifestSchema, type BlockMeta, type ResumeManifest } from '@jobforge/plugin-sdk';

// Server-side read/write for profile/resume/manifest.yaml + blocks/*.tex.
// The schema is enforced on every write; path writes are confined to
// <resumeDir>/blocks/<id>.tex and the manifest file itself.

export class ResumeFileError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const BLOCK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Validate a user-supplied block id. Rejects anything that could escape blocks/. */
export function assertBlockId(id: string): void {
  if (!BLOCK_ID.test(id)) {
    throw new ResumeFileError(
      `invalid block id "${id}" — must be lowercase alnum with . _ - and start with alnum (max 64 chars)`,
    );
  }
}

export interface LoadedResumeFiles {
  manifest: ResumeManifest;
  fragments: Record<string, string>;
  preamble: string;
}

export function readResume(resumeDir: string): LoadedResumeFiles {
  const manifestPath = resolveManifestPath(resumeDir);
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const fragments: Record<string, string> = {};
  for (const block of manifest.blocks) {
    fragments[block.id] = readFileSync(blockPath(resumeDir, block), 'utf8');
  }
  const preamblePath = join(resumeDir, 'preamble.tex');
  const preamble = existsSync(preamblePath) ? readFileSync(preamblePath, 'utf8') : '';
  return { manifest, fragments, preamble };
}

export interface UpsertBlockInput {
  id: string;
  section: string;
  title?: string | undefined;
  tags?: string[] | undefined;
  always_include?: boolean | undefined;
  tech_stack_line?: string | undefined;
  bullets?: { id: string; tags?: string[] | undefined }[] | undefined;
  /** The raw LaTeX fragment contents (what used to live in blocks/<id>.tex). */
  latex: string;
}

/**
 * Create or update one block: writes blocks/<id>.tex, inserts/updates the
 * matching entry in manifest.yaml under `blocks:`. Preserves YAML comments.
 */
export function upsertBlock(resumeDir: string, input: UpsertBlockInput): { created: boolean; block: BlockMeta } {
  assertBlockId(input.id);
  const manifestPath = resolveManifestPath(resumeDir);
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'));

  const sections = doc.get('sections');
  if (!isMap(sections)) throw new ResumeFileError('manifest.sections is missing or malformed', 500);
  if (!sections.has(input.section)) {
    throw new ResumeFileError(`unknown section "${input.section}" — add it to sections first`);
  }

  const seq = doc.get('blocks');
  if (!isSeq(seq)) throw new ResumeFileError('manifest.blocks is missing or malformed', 500);
  const blocks = seq as YAMLSeq;
  blocks.flow = false;

  const idx = blocks.items.findIndex((it) => isMap(it) && (it as YAMLMap).get('id') === input.id);
  const file = `blocks/${input.id}.tex`;
  const payload: Record<string, unknown> = {
    id: input.id,
    file,
    section: input.section,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.always_include ? { always_include: true } : {}),
    ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    ...(input.tech_stack_line ? { tech_stack_line: input.tech_stack_line } : {}),
    ...(input.bullets && input.bullets.length ? { bullets: input.bullets.map((b) => ({ id: b.id, ...(b.tags?.length ? { tags: b.tags } : {}) })) } : {}),
  };

  if (idx >= 0) {
    const node = blocks.items[idx] as YAMLMap;
    // Replace with the new payload wholesale to drop retired keys.
    const fresh = doc.createNode(payload) as YAMLMap;
    blocks.items[idx] = fresh;
    void node;
  } else {
    blocks.add(doc.createNode(payload));
  }

  // Validate the whole document before touching the filesystem.
  const parsed = resumeManifestSchema.safeParse(doc.toJSON());
  if (!parsed.success) {
    throw new ResumeFileError(
      `manifest would become invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  // Write the fragment first, then the manifest. If the fragment write fails we
  // haven't touched the manifest; if the manifest write fails after we've written
  // the fragment the result is a stale fragment file that `readResume` will
  // simply ignore until the manifest references it.
  writeFileSync(blockPath(resumeDir, { file, id: input.id, section: input.section } as BlockMeta), input.latex);
  writeFileSync(manifestPath, doc.toString());

  const block = parsed.data.blocks.find((b) => b.id === input.id)!;
  return { created: idx < 0, block };
}

export function deleteBlock(resumeDir: string, id: string): { deleted: boolean } {
  assertBlockId(id);
  const manifestPath = resolveManifestPath(resumeDir);
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'));
  const blocks = doc.get('blocks');
  if (!isSeq(blocks)) return { deleted: false };
  const seq = blocks as YAMLSeq;
  const idx = seq.items.findIndex((it) => isMap(it) && (it as YAMLMap).get('id') === id);
  if (idx < 0) return { deleted: false };

  const parsed = resumeManifestSchema.safeParse({ ...(doc.toJSON() as object), blocks: (doc.toJSON() as { blocks: unknown[] }).blocks.filter((_, i) => i !== idx) });
  if (!parsed.success) {
    throw new ResumeFileError(
      `cannot delete ${id}: manifest would become invalid (${parsed.error.issues[0]?.message ?? ''})`,
    );
  }
  const file = ((seq.items[idx] as YAMLMap).get('file') ?? `blocks/${id}.tex`) as string;
  seq.items.splice(idx, 1);
  writeFileSync(manifestPath, doc.toString());
  const fragmentPath = join(resumeDir, file);
  if (existsSync(fragmentPath) && isConfined(resumeDir, fragmentPath)) unlinkSync(fragmentPath);
  return { deleted: true };
}

/**
 * Replace the order of blocks (within a section) by rewriting the manifest's
 * `blocks:` sequence so the given ids appear in the given order. Blocks not
 * mentioned in `orderedIds` keep their current order relative to each other
 * and are placed after the explicitly ordered ones in the same section.
 */
export function reorderBlocks(resumeDir: string, section: string, orderedIds: string[]): void {
  const manifestPath = resolveManifestPath(resumeDir);
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'));
  const seq = doc.get('blocks');
  if (!isSeq(seq)) throw new ResumeFileError('manifest.blocks is missing', 500);
  const items = (seq as YAMLSeq).items.slice() as YAMLMap[];
  const bySection = new Map<string, YAMLMap[]>();
  for (const it of items) {
    const s = String(it.get('section'));
    const list = bySection.get(s) ?? [];
    list.push(it);
    bySection.set(s, list);
  }
  const target = bySection.get(section);
  if (!target) throw new ResumeFileError(`no blocks in section "${section}"`);
  for (const id of orderedIds) assertBlockId(id);
  const known = new Set(target.map((m) => String(m.get('id'))));
  for (const id of orderedIds) {
    if (!known.has(id)) throw new ResumeFileError(`block "${id}" is not in section "${section}"`);
  }
  const ordered = [
    ...orderedIds.map((id) => target.find((m) => String(m.get('id')) === id)!),
    ...target.filter((m) => !orderedIds.includes(String(m.get('id')))),
  ];
  bySection.set(section, ordered);
  // Rebuild the sequence in the same section-group order as before.
  const result: YAMLMap[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const s = String(it.get('section'));
    if (seen.has(s)) continue;
    seen.add(s);
    result.push(...bySection.get(s)!);
  }
  (seq as YAMLSeq).items = result;

  const parsed = resumeManifestSchema.safeParse(doc.toJSON());
  if (!parsed.success) throw new ResumeFileError(`manifest would become invalid after reorder`, 500);
  writeFileSync(manifestPath, doc.toString());
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function parseManifest(raw: string): ResumeManifest {
  const parsed = resumeManifestSchema.safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) {
    throw new ResumeFileError(
      `manifest.yaml is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      500,
    );
  }
  return parsed.data;
}

function resolveManifestPath(resumeDir: string): string {
  const p = join(resumeDir, 'manifest.yaml');
  if (!existsSync(p)) throw new ResumeFileError(`manifest.yaml not found in ${resumeDir}`, 503);
  return p;
}

function blockPath(resumeDir: string, block: Pick<BlockMeta, 'file' | 'id'>): string {
  const abs = resolve(resumeDir, block.file);
  if (!isConfined(resumeDir, abs)) {
    throw new ResumeFileError(`block file path escapes resume dir: ${block.file}`);
  }
  return abs;
}

/** `child` must sit under `parent` after resolution. Catches ../ and absolute-path escapes. */
function isConfined(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return !!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`);
}

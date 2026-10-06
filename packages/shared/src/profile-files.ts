import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isSeq, parse as parseYaml, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from './errors.js';
import { factSchema, factsFileSchema, preferencesSchema, type Preferences, type ProfileFact } from './profile.js';

/** Read and validate profile/facts.yaml and profile/preferences.yaml. */
export function readProfileDir(dir: string): { facts: ProfileFact[]; preferences: Preferences } {
  return {
    facts: readYaml(join(dir, 'facts.yaml'), factsFileSchema),
    preferences: readYaml(join(dir, 'preferences.yaml'), preferencesSchema),
  };
}

function readYaml<S extends z.ZodTypeAny>(path: string, schema: S): z.output<S> {
  if (!existsSync(path)) throw new ConfigError(`missing ${path}`);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid ${path}:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Create or update one fact in facts.yaml, keeping the file's comments and
 * layout. The result is validated before anything is written.
 */
export function upsertFactInFile(
  path: string,
  fact: { id: string } & { [K in Exclude<keyof ProfileFact, 'id'>]?: ProfileFact[K] | undefined },
): { created: boolean; fact: ProfileFact } {
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : 'facts: []\n');
  let facts = doc.get('facts');
  if (!isSeq(facts)) {
    doc.set('facts', doc.createNode([]));
    facts = doc.get('facts');
  }
  const seq = facts as YAMLSeq;
  seq.flow = false;
  const idx = seq.items.findIndex((it) => isMap(it) && it.get('id') === fact.id);
  const current = idx >= 0 ? ((seq.items[idx] as YAMLMap).toJSON() as Record<string, unknown>) : {};
  const merged = factSchema.parse({ ...current, ...stripUndefined(fact) });
  if (idx >= 0) {
    const node = seq.items[idx] as YAMLMap;
    for (const [k, v] of Object.entries(stripUndefined(fact))) node.set(k, doc.createNode(v));
  } else {
    seq.add(doc.createNode(merged));
  }
  const all = factsFileSchema.safeParse(doc.toJSON());
  if (!all.success) throw new ConfigError(`facts.yaml would become invalid: ${all.error.issues[0]?.message ?? ''}`);
  writeFileSync(path, doc.toString());
  return { created: idx < 0, fact: merged };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Remove one fact from facts.yaml by id. Returns false if the id wasn't present. */
export function deleteFactInFile(path: string, id: string): { deleted: boolean } {
  if (!existsSync(path)) return { deleted: false };
  const doc = parseDocument(readFileSync(path, 'utf8'));
  const seq = doc.get('facts');
  if (!isSeq(seq)) return { deleted: false };
  const idx = seq.items.findIndex((it) => isMap(it) && it.get('id') === id);
  if (idx < 0) return { deleted: false };
  (seq as YAMLSeq).items.splice(idx, 1);
  const all = factsFileSchema.safeParse(doc.toJSON());
  if (!all.success) throw new ConfigError(`facts.yaml would become invalid: ${all.error.issues[0]?.message ?? ''}`);
  writeFileSync(path, doc.toString());
  return { deleted: true };
}

/**
 * Overwrite preferences.yaml with a validated Preferences object. Comments are
 * preserved at the file level (parseDocument is used so top-of-file comments
 * survive), but inline key comments are lost — document the trade-off.
 */
export function writePreferencesFile(path: string, incoming: Preferences): Preferences {
  const parsed = preferencesSchema.parse(incoming);
  const existing = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : parseDocument('');
  // Replace each top-level key in-place so file-level comments / ordering is kept.
  const data = parsed as unknown as Record<string, unknown>;
  const keys = Object.keys(data);
  for (const k of keys) existing.set(k, existing.createNode(data[k]));
  // Drop any keys no longer in the schema (e.g. renamed) to avoid confusion.
  if (isMap(existing.contents)) {
    const existingKeys = (existing.contents as YAMLMap).items.map((it) => String((it.key as { value?: unknown }).value ?? ''));
    for (const k of existingKeys) {
      if (!keys.includes(k)) existing.delete(k);
    }
  }
  writeFileSync(path, existing.toString());
  return parsed;
}

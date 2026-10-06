import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from './errors.js';
import { factsFileSchema, preferencesSchema, type Preferences, type ProfileFact } from './profile.js';

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

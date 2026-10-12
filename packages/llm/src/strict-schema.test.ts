import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchema } from './json-schema.js';
import { restoreOptional, toStrictSchema } from './strict-schema.js';

describe('strict schema (Codex --output-schema)', () => {
  const schema = z.object({
    name: z.string(),
    note: z.string().optional(),
    maybe: z.string().nullable(),
    tags: z.array(z.object({ k: z.string(), v: z.number().default(1).optional() })),
  });
  const json = toJsonSchema(schema);

  it('requires every key, makes optional ones nullable, and drops `default`', () => {
    const s = toStrictSchema(json)!;
    expect(s.required).toEqual(['name', 'note', 'maybe', 'tags']);
    expect(s.additionalProperties).toBe(false);
    const item = (s.properties as { tags: { items: Record<string, unknown> } }).tags.items;
    expect(item.required).toEqual(['k', 'v']);
    expect(JSON.stringify(s)).not.toContain('"default"');
  });

  it('round-trips strict output back through the zod schema', () => {
    const out = { name: 'a', note: null, maybe: null, tags: [{ k: 'x', v: null }] };
    const restored = restoreOptional(out, json);
    expect(restored).toEqual({ name: 'a', maybe: null, tags: [{ k: 'x' }] });
    expect(schema.safeParse(restored).success).toBe(true);
  });

  it('gives up on open objects', () => {
    expect(toStrictSchema(toJsonSchema(z.object({ m: z.record(z.string()) })))).toBeUndefined();
  });
});

// OpenAI structured outputs (Codex's --output-schema) accept only "strict"
// schemas: every object lists all its keys in `required` and sets
// `additionalProperties: false`, and a few keywords are rejected. Optional
// keys become nullable instead, and `restoreOptional` turns those nulls back
// into missing keys so the zod schema still validates.

type Json = Record<string, unknown>;

const DROP = new Set(['default', 'format', '$schema']);

/** The strict form of `schema`, or undefined when it has open objects (records, passthrough) strict mode can't express. */
export function toStrictSchema(schema: Json): Json | undefined {
  try {
    return strictify(schema);
  } catch {
    return undefined;
  }
}

function strictify(node: unknown): Json {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (DROP.has(k)) continue;
    if (k === 'properties' || k === 'required' || k === 'additionalProperties') continue;
    if (k === 'items') out.items = Array.isArray(v) ? v.map(strictify) : strictify(v);
    else if (k === 'anyOf' || k === 'oneOf' || k === 'allOf')
      out.anyOf = (v as unknown[]).map(strictify);
    else out[k] = v;
  }
  const n = node as Json;
  const isObject = n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'));
  if (isObject) {
    if (n.additionalProperties !== undefined && n.additionalProperties !== false)
      throw new Error('open object');
    const props = (n.properties ?? {}) as Record<string, unknown>;
    const required = new Set((n.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, sub]) => [
        key,
        required.has(key) ? strictify(sub) : nullable(strictify(sub)),
      ]),
    );
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function allowsNull(s: Json): boolean {
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  return Array.isArray(s.anyOf) && (s.anyOf as Json[]).some(allowsNull);
}

function nullable(s: Json): Json {
  return allowsNull(s) ? s : { anyOf: [s, { type: 'null' }] };
}

/** Undo `toStrictSchema`'s optional→nullable for keys the original schema left optional and non-nullable. */
export function restoreOptional(data: unknown, schema: Json): unknown {
  if (Array.isArray(data)) {
    const items = schema.items;
    return items && typeof items === 'object' && !Array.isArray(items)
      ? data.map((d) => restoreOptional(d, items as Json))
      : data;
  }
  if (!data || typeof data !== 'object') return data;
  const variants = Array.isArray(schema.anyOf)
    ? (schema.anyOf as Json[]).filter((v) => v.properties)
    : [];
  if (!schema.properties && variants.length === 1) return restoreOptional(data, variants[0]!);
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const out: Json = {};
  for (const [k, v] of Object.entries(data as Json)) {
    const sub = props[k];
    if (v === null && sub && !required.has(k) && !allowsNull(sub)) continue;
    out[k] = sub ? restoreOptional(v, sub) : v;
  }
  return out;
}

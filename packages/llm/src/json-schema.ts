import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Inline JSON Schema for a zod schema: no $ref indirection, no $schema header. */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const out = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

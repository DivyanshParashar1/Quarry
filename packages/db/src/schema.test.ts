import { describe, expect, it } from 'vitest';
import { ATS_TYPES } from '@quarry/shared';
import { atsTypeEnum } from './schema.js';

describe('schema', () => {
  // schema.ts keeps its own literal list (drizzle-kit loads it without the workspace's TS resolution).
  it('ats_type enum matches the shared ATS_TYPES', () => {
    expect(atsTypeEnum.enumValues).toEqual([...ATS_TYPES]);
  });
});

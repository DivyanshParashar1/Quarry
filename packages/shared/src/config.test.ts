import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnv, resetEnvCache } from './config.js';

describe('loadEnv', () => {
  beforeEach(() => resetEnvCache());

  it('parses valid env', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3000);
    expect(env.LLM_PROVIDER).toBe('claude-code');
    expect(env.MODE).toBe('dev');
  });

  it('throws on missing DATABASE_URL', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid LLM_PROVIDER', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        LLM_PROVIDER: 'nope',
      } as NodeJS.ProcessEnv),
    ).toThrow(/LLM_PROVIDER/);
  });
});

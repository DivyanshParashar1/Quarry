import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadAppConfig, parseAppConfig } from './app-config.js';

describe('config.yaml', () => {
  it('defaults when the file is missing', () => {
    expect(loadAppConfig('/nonexistent/config.yaml')).toEqual({
      llm: { tasks: {} },
      embeddings: { model: 'Xenova/bge-small-en-v1.5' },
      outreach: { dailyCap: 20, perCompanyPerWeek: 2, spacingMinutes: [4, 11], followupDays: [5, 7], maxFollowups: 2 },
      resume: { name: '', contact: '', headline: '' },
      plugins: {},
    });
  });

  it('parses the checked-in example', () => {
    const c = loadAppConfig(fileURLToPath(new URL('../../../config.example.yaml', import.meta.url)));
    expect(c.llm.tasks.match).toEqual({ model: 'claude-haiku-4-5' });
    expect(c.plugins['matcher-default']).toMatchObject({ llmTopK: 150 });
  });

  it('rejects unknown providers and keys', () => {
    expect(() => parseAppConfig({ llm: { tasks: { match: { provider: 'gpt' } } } })).toThrow(/llm\.tasks\.match\.provider/);
    expect(() => parseAppConfig({ llm: { tasks: { summarize: {} } } })).toThrow(/Unrecognized key/);
  });
});

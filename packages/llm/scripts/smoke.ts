// Manual smoke test against a REAL provider. Never run in CI; costs a little.
//   pnpm --filter @jobforge/llm smoke -- --provider claude-code [--model haiku]
//   pnpm --filter @jobforge/llm smoke -- --provider openrouter [--model openai/gpt-4o-mini]
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createLogger, loadEnv, LLM_PROVIDERS, type LLMProviderName } from '@jobforge/shared';
import { checkClaudeCli, createLLMFromConfig } from '../src/index.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { provider: { type: 'string' }, model: { type: 'string' } },
});
const env = loadEnv();
const provider = (values.provider ?? env.LLM_PROVIDER) as LLMProviderName;
if (!LLM_PROVIDERS.includes(provider)) throw new Error(`--provider must be one of ${LLM_PROVIDERS.join(', ')}`);

if (provider === 'claude-code') {
  const status = await checkClaudeCli(env.CLAUDE_CLI_PATH);
  console.log('claude CLI:', status);
  if (!status.ok) process.exit(1);
}

const client = createLLMFromConfig(
  { ...env, LLM_PROVIDER: provider },
  { llm: { tasks: values.model ? { extract: { model: values.model } } : {} }, embeddings: { model: '' }, plugins: {} },
  { log: createLogger({ level: 'debug' }), onCall: (rec) => console.log('llm_calls row:', rec) },
);

const schema = z.object({
  company: z.string(),
  title: z.string(),
  remote: z.boolean(),
  skills: z.array(z.string()).max(5),
});
const started = Date.now();
const res = await client.generate({
  task: 'extract',
  system: 'You extract structured fields from job postings.',
  prompt:
    'Acme Corp is hiring a Senior Backend Engineer (fully remote, India). You will build Go and Postgres services on Kubernetes.',
  schema,
  maxTokens: 300,
});
console.log(`\nOK in ${Date.now() - started}ms via ${res.provider}/${res.model}`);
console.log(res.data);
console.log(res.usage);

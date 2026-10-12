// Manual smoke test against a REAL provider. Never run in CI; costs a little.
//   pnpm --filter @quarry/llm smoke -- --provider claude-code [--model haiku]
//   pnpm --filter @quarry/llm smoke -- --provider openrouter [--model openai/gpt-4o-mini]
//   pnpm --filter @quarry/llm smoke -- --provider codex [--model gpt-5-codex]
//   pnpm --filter @quarry/llm smoke -- --provider antigravity [--model <slug from `agy models`>]
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createLogger, loadEnv, LLM_PROVIDERS, parseAppConfig, type LLMProviderName } from '@quarry/shared';
import { checkAntigravityCli, checkClaudeCli, checkCodexCli, createLLMFromConfig } from '../src/index.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { provider: { type: 'string' }, model: { type: 'string' } },
});
const env = loadEnv();
const provider = (values.provider ?? env.LLM_PROVIDER) as LLMProviderName;
if (!LLM_PROVIDERS.includes(provider)) throw new Error(`--provider must be one of ${LLM_PROVIDERS.join(', ')}`);

const cliCheck = {
  'claude-code': () => checkClaudeCli(env.CLAUDE_CLI_PATH),
  codex: () => checkCodexCli(env.CODEX_CLI_PATH),
  antigravity: () => checkAntigravityCli(env.ANTIGRAVITY_CLI_PATH),
}[provider as string];
if (cliCheck) {
  const status = await cliCheck();
  console.log(`${provider} CLI:`, status);
  if (!status.ok) process.exit(1);
}

const client = createLLMFromConfig(
  { ...env, LLM_PROVIDER: provider },
  parseAppConfig({ llm: { tasks: values.model ? { extract: { provider, model: values.model } } : {} } }),
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

#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Echoes what it was given so tests can
// assert on args, stdin, and cwd; FAKE_CLAUDE_MODE picks the reply.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== '0' }));
  process.exit(0);
}
const stdin = readFileSync(0, 'utf8');
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
const model = args[args.indexOf('--model') + 1];
if (mode === 'hang') setTimeout(() => {}, 60_000);
else if (mode === 'crash') {
  process.stderr.write('boom\n');
  process.exit(3);
} else {
  const isError = mode === 'error';
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      result: isError ? 'rate limited' : '',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
      modelUsage: { [`resolved-${model}`]: {} },
      structured_output: isError ? undefined : { echo: { args, stdin, cwd: process.cwd(), schemaType: schema.type } },
    }),
  );
}

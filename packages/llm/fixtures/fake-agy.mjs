#!/usr/bin/env node
// Stand-in for the Antigravity `agy` CLI in tests: prints the headless
// `--output-format json` envelope. FAKE_AGY_MODE picks the reply.
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('agy 9.9.9');
  process.exit(0);
}
const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const schema = JSON.parse(at('--json-schema'));
const echo = { args, prompt: at('-p'), cwd: process.cwd(), schemaType: schema.type };
const usage = {
  input_tokens: 100,
  output_tokens: 30,
  thinking_tokens: 10,
  cache_read_tokens: 50,
  total_tokens: 140,
};
const out = (e) =>
  console.log(JSON.stringify({ conversation_id: 'c1', duration_seconds: 1.2, num_turns: 1, ...e }));

if (mode === 'hang') setTimeout(() => {}, 60_000);
else if (mode === 'silent') process.exit(0);
else if (mode === 'waiting') out({ status: 'WAITING', response: '' });
else if (mode === 'error') {
  out({ status: 'ERROR', error: 'unknown model' });
  process.exit(1);
} else if (mode === 'no-structured')
  out({ status: 'SUCCESS', response: JSON.stringify({ echo }), usage });
else
  out({
    status: 'SUCCESS',
    response: JSON.stringify({ echo }),
    structured_output: { echo },
    json_schema: schema,
    usage,
  });

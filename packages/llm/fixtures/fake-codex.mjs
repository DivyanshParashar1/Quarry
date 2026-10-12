#!/usr/bin/env node
// Stand-in for the `codex` CLI in tests: emits the `codex exec --json` JSONL
// events, echoing args/stdin/cwd/schema. FAKE_CODEX_MODE picks the reply.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login') {
  console.log(
    process.env.FAKE_CODEX_LOGGED_IN === '0' ? 'Not logged in' : 'Logged in using ChatGPT',
  );
  process.exit(process.env.FAKE_CODEX_LOGGED_IN === '0' ? 1 : 0);
}
const stdin = readFileSync(0, 'utf8');
const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const schemaPath = at('--output-schema');
const schema = schemaPath ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null;
const emit = (e) => console.log(JSON.stringify(e));

if (mode === 'hang') setTimeout(() => {}, 60_000);
else if (mode === 'fail') {
  emit({ type: 'thread.started', thread_id: 't1' });
  emit({ type: 'turn.failed', error: { message: 'usage limit reached' } });
  process.exit(1);
} else {
  emit({ type: 'thread.started', thread_id: 't1' });
  emit({ type: 'turn.started' });
  if (args.includes('web_search="live"'))
    emit({ type: 'item.completed', item: { id: 'i0', type: 'web_search', query: 'x' } });
  const answer =
    mode === 'nulls'
      ? { a: 'x', opt: null }
      : { echo: { args, stdin, cwd: process.cwd(), schema } };
  const text =
    mode === 'fenced'
      ? 'Here you go:\n```json\n' + JSON.stringify(answer) + '\n```'
      : JSON.stringify(answer);
  if (mode === 'file-only') writeFileSync(at('-o'), text);
  else emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 30,
      reasoning_output_tokens: 5,
    },
  });
}

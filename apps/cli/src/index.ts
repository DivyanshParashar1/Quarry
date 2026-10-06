#!/usr/bin/env tsx
// `jf` CLI — commands added in Phase 1 (companies import, fetch, jobs list).
import { createLogger } from '@jobforge/shared';

const log = createLogger();

async function main(argv: string[]) {
  const [cmd] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    log.info('jf — JobForge CLI (scaffold). Commands land in Phase 1.');
    return;
  }
  log.warn({ cmd }, 'unknown command');
  process.exit(2);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});

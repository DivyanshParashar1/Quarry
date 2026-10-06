import { canConnect, DEFAULT_ADMIN_URL, prepareTemplate, setTestDbAdminUrl } from '@jobforge/db/testing';

/**
 * Builds one migrated template database for the run; each DB test file clones
 * it. If Postgres isn't up, DB tests are skipped (with a warning) unless
 * JOBFORGE_REQUIRE_DB=1, which turns that into a failure.
 */
export default async function setup() {
  const url = process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
  if (!(await canConnect(url))) {
    if (process.env.JOBFORGE_REQUIRE_DB === '1') throw new Error(`Postgres not reachable at ${url}`);
    console.warn(`\n[jobforge] Postgres not reachable; skipping DB tests. Run \`docker compose up -d\`.\n`);
    return;
  }
  await prepareTemplate(url);
  setTestDbAdminUrl(url);
}

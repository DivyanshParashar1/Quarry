import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';

export const TEMPLATE_DB = 'jobforge_test_template';
export const DEFAULT_ADMIN_URL = 'postgres://jobforge:jobforge@localhost:5432/jobforge';

const ADMIN_URL_ENV = 'JOBFORGE_TEST_DB_ADMIN_URL';

/** Set by the vitest global setup once the template is ready; workers inherit it. */
export function setTestDbAdminUrl(url: string): void {
  process.env[ADMIN_URL_ENV] = url;
}

/** The admin URL for DB tests, or null when Postgres wasn't reachable (tests skip). */
export function testDbAdminUrl(): string | null {
  return process.env[ADMIN_URL_ENV] || null;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Returns false (rather than throwing) when Postgres isn't reachable. */
export async function canConnect(adminUrl: string): Promise<boolean> {
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** (Re)build a migrated template database. Run once per test session. */
export async function prepareTemplate(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await sql.end();
  }
  await runMigrations(withDatabase(adminUrl, TEMPLATE_DB));
}

export interface TestDb extends DbHandle {
  url: string;
  drop(): Promise<void>;
}

/** An isolated, already-migrated database cloned from the template. */
export async function createTestDb(adminUrl: string): Promise<TestDb> {
  const name = `jobforge_test_${randomBytes(4).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();
  const url = withDatabase(adminUrl, name);
  const handle = createDb(url, 5);
  return {
    ...handle,
    url,
    async drop() {
      await handle.close();
      const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

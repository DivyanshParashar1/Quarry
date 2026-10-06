import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(url: string, log: (msg: string) => void = () => {}): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // pgvector extension — required before any vector columns exist in later migrations.
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector;');
    log(`Running migrations from ${migrationsFolder}`);
    await migrate(drizzle(client), { migrationsFolder });
    log('Migrations complete');
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url, console.log).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  // pgvector extension — required before any vector columns exist in later migrations.
  await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector;');

  console.log(`Running migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  await client.end();
  console.log('Migrations complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

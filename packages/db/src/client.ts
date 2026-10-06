import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

let singleton: { client: postgres.Sql; db: DB } | null = null;

export function getDb(url: string = process.env.DATABASE_URL ?? ''): DB {
  if (!url) throw new Error('DATABASE_URL is required');
  if (!singleton) {
    const client = postgres(url, { max: 10 });
    singleton = { client, db: drizzle(client, { schema }) };
  }
  return singleton.db;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.client.end();
    singleton = null;
  }
}

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: DB;
  close(): Promise<void>;
}

/** A fresh pool. Prefer this in tests and short-lived commands. */
export function createDb(url: string, max = 10): DbHandle {
  const client = postgres(url, { max, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

let singleton: DbHandle | null = null;

export function getDb(url: string = process.env.DATABASE_URL ?? ''): DB {
  if (!url) throw new Error('DATABASE_URL is required');
  singleton ??= createDb(url);
  return singleton.db;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

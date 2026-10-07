export * as schema from './schema.js';
export { EMBEDDING_DIM } from './schema.js';
export { getDb, closeDb, createDb, type DB, type DbHandle } from './client.js';
export { runMigrations } from './migrate.js';
export * from './repos.js';
export * from './profile-repo.js';
export * from './match-repo.js';
export * from './llm-repo.js';
/** Re-exported so callers build raw SQL with the same drizzle-orm instance as the schema. */
export { sql } from 'drizzle-orm';
export * from './contacts-repo.js';
export * from './outreach-repo.js';
export * from './resume-repo.js';
export * from './discovery-repo.js';
export * from './referral-repo.js';

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://jobforge:jobforge@localhost:5432/jobforge',
  },
  strict: true,
  verbose: true,
} satisfies Config;

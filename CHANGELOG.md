# Changelog

## [Phase 0] — Scaffold

- pnpm monorepo with workspaces (`apps/*`, `packages/*`, `plugins/*`).
- TypeScript strict (NodeNext, ES2023), ESLint flat config, Prettier, Vitest.
- `docker-compose.yml` with `pgvector/pgvector:pg16`.
- `packages/db` — Drizzle schema for `companies`, `company_sources`, `jobs`, `raw_postings`, `plugin_runs`, `events`; migrator that enables the `vector` extension.
- `packages/shared` — zod-validated env loader (`loadEnv`), pino logger, typed error classes.
- `packages/plugin-sdk`, `packages/core`, `packages/llm`, `packages/embeddings` — type stubs so workspace imports are stable before Phase 1 fills them in.
- `apps/server`, `apps/cli`, `apps/mcp`, `apps/web` — scaffolds.
- `.env.example`, `.gitignore`, `.nvmrc` (Node 22), `CLAUDE.md`.

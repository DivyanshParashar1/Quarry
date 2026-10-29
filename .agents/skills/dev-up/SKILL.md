---
name: dev-up
description: Bring the local dev stack up (Docker Postgres + migrations) and verify it. Use when the user says "start the stack", "bring up postgres", "run migrations", "is the db up", or when a task needs the DB and nothing is listening on 5432.
---

# dev-up

Local dev depends on one container: `pgvector/pgvector:pg16` from `docker-compose.yml`, exposed on `5432`. The migrator in `packages/db` enables the `vector` extension before running Drizzle migrations.

## Steps (run in order, stop on first failure)

1. **Check Docker daemon.** `docker info >/dev/null 2>&1`. If it fails, tell the user to start Docker Desktop and stop — do not try to launch Docker Desktop yourself.
2. **Start Postgres.** `docker compose up -d`. Wait for the healthcheck: `docker compose ps` should show `healthy` (poll a few times, up to ~30s).
3. **Env.** If `.env` is missing, copy `.env.example` to `.env`. Don't overwrite an existing `.env`.
4. **Migrate.** `pnpm db:migrate`. First run will enable the `vector` extension and apply `0000_*.sql`.
5. **Smoke test.** `pnpm test`. All green = stack is good.

## When something is wrong

- Port 5432 already in use → ask the user whether to stop the other process; do not kill it unilaterally.
- Migration says "already applied" → fine, that's idempotent.
- `relation does not exist` after a schema change → user forgot `pnpm db:generate` before `pnpm db:migrate`. Run both.
- `extension "vector" is not available` → the image is wrong. Check `docker-compose.yml` is pinned to `pgvector/pgvector:pg16`, not plain `postgres:16`.

## Tearing down

- `docker compose down` — stops the container, keeps data in `./pgdata`.
- `docker compose down -v` or deleting `./pgdata` — wipes the DB. **Confirm with the user before doing this.**
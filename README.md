# Timekeeper Work

Geofence-based workforce attendance for multi-tenant organizations (first tenant: **310**).

- Product requirements: [`docs/Timekeeper_Work_PRD.md`](docs/Timekeeper_Work_PRD.md)
- Technical architecture: [`docs/Timekeeper_Work_Architecture.md`](docs/Timekeeper_Work_Architecture.md)

## Repository layout

```
apps/
  api/        NestJS backend: REST API (src/main.ts) and background worker (src/worker.ts)
  web/        Next.js admin web app (Tailwind CSS)
  mobile/     React Native app — scaffolded after Phase 0 Spike 1 (see apps/mobile/README.md)
packages/
  domain/     Pure TypeScript attendance rules (no framework, no database); tested with Vitest
infra/
  docker/     Local PostgreSQL (docker compose)
  terraform/  Cloud infrastructure (Singapore) — added after Spike 3
docs/         PRD and architecture
```

## Requirements

- Node.js 22 (`.nvmrc`)
- pnpm 10 (`corepack enable` picks the version from `package.json`)
- Docker (optional, for local PostgreSQL)

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm db:up            # local PostgreSQL on :5432 (also creates timekeeper_test)
export DATABASE_URL=postgres://timekeeper:timekeeper@localhost:5432/timekeeper
pnpm --filter @timekeeper/api db:migrate && pnpm --filter @timekeeper/api db:seed
pnpm build            # builds packages/domain first, then apps
pnpm dev              # api :3001, web :3000, domain in watch mode
curl localhost:3001/v1/health
```

## Common commands

| Command                                       | What it does                                 |
| --------------------------------------------- | -------------------------------------------- |
| `pnpm test`                                   | Unit tests for all packages (Vitest)         |
| `pnpm lint` / `pnpm typecheck`                | ESLint / TypeScript across the workspace     |
| `pnpm format` / `pnpm format:check`           | Prettier                                     |
| `pnpm build`                                  | Production builds (Turborepo caches results) |
| `pnpm --filter @timekeeper/domain test:watch` | Watch mode for the rules engine              |

## Conventions

- **Business rules live in `packages/domain`** as pure functions with golden tests that cite the PRD
  section they implement (e.g. `classifyArrival` = PRD 6.2). The API and worker call them; they never
  re-implement rules.
- Backend modules own their tables and talk to each other through services (Architecture Section 3).
- Every tenant table has Row-Level Security (Architecture Section 5.2).
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, …). CI (`.github/workflows/ci.yml`) runs
  format check, lint, typecheck, test and build on every push and pull request.

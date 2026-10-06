# Repository Guidelines

## Project Overview

DUGate is a self-hosted Document Understanding API Gateway that converts Word/PDF files into AI-ready Markdown. It exposes six async API endpoints (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`), backed by Next.js 14 (App Router), a BullMQ worker, PostgreSQL + Drizzle ORM, and Redis.

## Project Structure

| Path | Purpose |
|---|---|
| `app/` | Next.js App Router: UI pages and API routes (`api/v1/` public, `api/internal/` admin) |
| `components/` | Shared React UI components — no business logic |
| `lib/` | Business logic: endpoints, parsers, pipelines, queue, storage, db |
| `tests/` | Jest tests: `*.test.ts` (unit) and `tests/e2e/*.e2e.test.ts` (integration) |
| `worker.ts` | Standalone BullMQ worker (bundled to `worker.js`) |
| `mock-service/` | Mock API for offline development and testing |
| `drizzle/` | SQL migration files |
| `docs/`, `docs-site/` | Markdown docs and VitePress site (auto-deployed to GitHub Pages) |

## Development Commands

Prerequisites: Node.js 20+, PostgreSQL, Redis, Pandoc, Ghostscript.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, NEXTAUTH_SECRET, ENCRYPTION_KEY
npm run dev                 # Next.js app on http://localhost:2023
npm run worker:dev          # BullMQ worker in watch mode
npm run seed                # seed admin credentials
npm run build               # production build
npm run lint                # ESLint
npm test                    # unit tests (jest, ts-jest)
npm run test:e2e            # e2e tests (mock service)
```

Docker: `docker compose up -d` starts the app, worker, PostgreSQL, Redis, and mock-service.

## Coding Style

- **TypeScript strict** — no `any`, no implicit types; use the `@/` path alias.
- **Layering** — `app/api/` holds thin HTTP handlers that delegate to `lib/`; `components/` contains UI only.
- **Formatting** — 2-space indentation, single quotes (TypeScript conventions). Run `npm run lint` before committing.

## Testing Guidelines

- **Framework**: Jest + ts-jest (node environment). Unit tests in `tests/`; e2e tests in `tests/e2e/` use the mock service to avoid real AI costs.
- **Naming**: `*.test.ts` for unit, `*.e2e.test.ts` for e2e.
- **Coverage**: Add tests for new logic in `lib/`; e2e coverage required for API endpoint changes.

## Commit & Pull Request Guidelines

- Use Conventional Commits: `feat`, `fix`, `refactor`, `chore`, `docs`, `perf`, with optional scope, e.g. `feat(pipelines): add prompt wizard`.
- One logical change per commit; keep PRs focused on a single feature or fix.
- Branch naming: `feat/your-feature` or `fix/your-bug`; open PRs against `main`.
- PR description: what changed, why, and how it was tested; link the related issue; include screenshots for UI changes.

## Security & Configuration

- Never commit `.env` — copy from `.env.example` and change `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, and seed credentials.
- Don't log API keys or secrets; use `lib/logger.ts` for structured logging.
- New AI or connector endpoints should respect profile-driven override routing in `lib/pipelines/`.



## Coordinator role boundary (2026-10-06)

Agents acting as coordinator must follow [COORDINATOR-CONTRACT.md](du-rework/coordination/COORDINATOR-CONTRACT.md). Antigravity is the single dispatcher. Coordinator writes plan/coordination metadata only, never product code/tests, including legacy files. Requests to split tasks require actual worker delivery and independent verification. Explicit repo scope/canonical plan required; never implement personally or infer functional success from exit codes.

# Gate: workspace-ready — **READY**

- Date: 2026-09-20
- Owner: Claude (platform lane)
- Root: `du-rework/` — pnpm workspace, single `pnpm-lock.yaml` at root, no nested lockfiles.

## Evidence (actual commands + results)

```
cd du-rework
pnpm install
→ Scope: all 8 workspace projects
→ Packages: +351 … Done in 16.7s
→ WARN 4 deprecated subdependencies (cron-parser@4.9.0, glob@10.5.0, glob@7.2.3, inflight@1.0.6) — non-blocking

pnpm ls -r --depth -1     → all 8 projects resolve (list below)
find . -name "*lock*" -not -path "*/node_modules/*"
→ ./pnpm-lock.yaml        (single lockfile, root only)
```

Workspace projects:

| Package | Path |
|---|---|
| `@du/contracts@0.1.0` | `packages/contracts` |
| `@du/observability@0.1.0` | `packages/observability` |
| `@du/worker-sdk@0.1.0` | `packages/worker-sdk` |
| `@du/document-kit@1.0.0` | `packages/document-kit` |
| `@du/connector-client@0.1.0` | `packages/connector-client` |
| `@du/connector` | `services/connector` |
| `@du/document-core@1.0.0` | `businesses/document-core` |
| `du-rework@0.0.0` (root) | `.` |

Per-package test evidence (each: `npx tsc --noEmit -p tsconfig.json` exit 0, then `pnpm test`):

```
@du/contracts      Test Suites: 5 passed / Tests: 70 passed
@du/observability  Test Suites: 1 passed / Tests: 16 passed
@du/worker-sdk     Test Suites: 1 passed / Tests: 23 passed
```

## Package manager decision: pnpm (not npm)

- npm rejects the `workspace:*` protocol used by peer manifests (`EUNSUPPORTEDPROTOCOL`); pnpm resolves it natively via `pnpm-workspace.yaml` (`packages/*`, `services/*`, `businesses/*`).
- Documented as ADR-13 in `du-rework/docs/15-decisions.md` (decision log).
- Root scripts: `pnpm build|test|lint|clean` (recursive). Node >= 20, pnpm >= 9.
- Only the platform lane (Claude) runs root installs / touches the lockfile. Do not create nested lockfiles; route dependency needs through `coordination/requests/<lane>.md`.

## Root overrides applied (unblocking peer manifests without editing peer files)

`package.json` → `pnpm.overrides`:

1. `"@types/mammoth": "npm:empty-npm-package@1.0.0"` — `@types/mammoth` does not exist on npm (deprecated stub; mammoth ships its own types). **Action for Antigravity**: remove the devDependency from `packages/document-kit/package.json` at your next edit; the override is then a no-op.
2. `"pdf-lib@^1.17.9": "^1.17.1"` — requested range has no matching version (latest is 1.17.1). **Action for Antigravity**: pin `^1.17.1` in document-kit. Note: pdf-lib 1.17.1 emits `%PDF-1.7` headers — relevant to the four failing PDF-split assertions in the rebalance packet.

## Dependencies resolved from peer requests

- Antigravity (`requests/antigravity.md`): mammoth ^1.8.0, xlsx, pdf-lib (→1.17.1 via override), zod ^3.23.8, jest/ts-jest/@types stack — all present in the root lockfile.
- Copilot (`requests/copilot.md`): `pg`/`@types/pg` and `ioredis` are **not yet added** — requested only "for concrete runtime wiring after the workspace gate". Reply: add these declarations to `services/connector/package.json` + a requests note, and Claude will resolve at the next root install (single-lockfile rule).

## Remaining limitations

- `services/orchestrator` package does not exist yet (implementation next, per WORKLOAD-REBALANCE-01); it will join the same workspace glob automatically.
- Integration test infra (isolated Postgres :5433 / Redis :6380 / MinIO via docker) is planned under `infra/` for the runtime gate; not required for the unit-level evidence above.

# W-VAULT01-BIND-1 — implementation receipt

**Task:** VAULT-01 trusted Connector revision binding  
**Source identity:** `7811298844450f373687c478d08d1edfa53ae124` plus uncommitted worktree changes  
**Working directory:** `D:\Git\dugate\du-rework`  
**Environment:** offline unit/typecheck/build only; no PostgreSQL, Redis, Vault, or `DU_LIVE_INFRA`  
**Status:** IMPLEMENTED; offline VERIFIED at the listed test scope; NOT ACCEPTED

| Time (UTC, 2026-09-25) | Command | Result | Raw output |
|---|---|---|---|
| 17:40:31 | `pnpm --filter @du/connector typecheck` | Exit 0 | [Connector typecheck](W-VAULT01-BIND-1-connector-typecheck.log) |
| 17:40:40 | `pnpm --filter @du/contracts test -- --runTestsByPath tests/vault-ref.test.ts` | 1 suite, 59 passed, 0 failed/skipped; Exit 0 | [Contracts tests](W-VAULT01-BIND-1-contract-test.log) |
| 17:40:46 | `pnpm --filter @du/contracts build` | Exit 0 | [Contracts build](W-VAULT01-BIND-1-contract-build.log) |
| 17:45:08 | `pnpm --filter @du/connector test:unit --runTestsByPath tests/revision-binding.db.test.ts tests/revision-binding.schema.test.ts tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts` | 4 suites, 66 passed, 0 failed/skipped; Exit 0 | [Connector tests](W-VAULT01-BIND-1-connector-tests.log) |

The focused Connector suite uses the migration-aware fake database. Migration 008 was not applied to PostgreSQL, and no real Vault policy was exercised. The Orchestrator credential HTTP adapter still sends only `credentialSource`; it must send the separate tenant/account binding fields before the full writer path can pass. Keep VAULT-01 and G-SEC open; no task row was marked accepted.

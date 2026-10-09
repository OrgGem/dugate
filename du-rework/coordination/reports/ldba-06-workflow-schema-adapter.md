# LDBA-06 R4 workflow schema adapter receipt

Task ID: LDBA-06-R4
Request ID: LDBA-06-R4-2026-10-09
Date: 2026-10-09
Repository root: D:\Git\dugate
Canonical plan: du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md, sections 4.1 and 4.6 reread
Result: IMPLEMENTED with focused owner smoke; independent verification and acceptance remain open

## R4 decisions applied

R3 stopped correctly on the empty connector map and empty approved origins conflict. R4 resolves that conflict by using the production catalog writer. The adapter does not construct an envelope, allocate connector slots, compute a digest, seal metadata, or issue a catalog INSERT itself.

The adapter calls `provisionLegacyWorkflowSchema` with `expectedRevision: null`, after checking for an active row. It catches `SCHEMA_REVISION_CONFLICT` and reports a skip. It then calls the production `resolveLegacyWorkflowSchema` on the same injected database and compares the returned schema, slot map, origins, tenant, revision, and digest against the writer result.

Tenant resolution uses the logical name `legacy-default`. Preflight with no match returns `PREFLIGHT_TENANT_PENDING` without seeding. Execute seeds only the name, resolves the generated UUID, rejects multiple matches as `DUPLICATE_TENANT_NAME`, and rejects a non-UUID or unresolved result. No UUID fallback is used.

The source selector keeps the greatest `updatedAt`; ties use greatest UTF-8 byte-order key. Every losing candidate is returned with `OLDER_UPDATED_AT` or `TIED_UPDATED_AT_LOWER_KEY`. `appSettings.key` is unique at `lib/db/schema.ts:146-150`.

Egress URL collection follows the contracts reader shape and recurses through parallel branches. Static HTTPS URLs without userinfo contribute their normalized origin. Dynamic, malformed, non-HTTPS, userinfo-bearing, or fragment-bearing URLs skip the entire schema with a reason. Egress with no configured URL or no derived origin also skips. More than 16 distinct origins skips. No origin is invented.

The route and loader were not changed. The v1 route remains on `appSettings` as specified.

## Files in the R4 write set

- `du-rework/orchestrator/services/orchestrator/src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts` — injected source reader and `Db` sink, tenant resolver, deterministic candidate selector, egress derivation, skip/report mapping, production writer call, and production reader round-trip check.
- `du-rework/orchestrator/services/orchestrator/tests/legacy-workflow-schema-backfill-adapter.test.ts` — offline acceptance coverage using a shared fake database.
- `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md` — this receipt, overwriting R3.

## Offline crypto and database boundary

Tests use the production `MetadataCrypto`, production `VaultTransitProvider`, and production `adaptKeyProviderForMetadata`. The provider uses an injected local in-memory Transit HTTP emulator that wraps and unwraps DEKs with AES-256-GCM. This exercises the real provider and metadata crypto code without contacting Vault. The production writer and reader use the same fake `Db` instance in round-trip cases.

No PostgreSQL, Redis, Vault endpoint, production database, or legacy database was contacted. No migration was run. No fixture was read from a live database.

## Acceptance evidence

| Case | Result |
|---|---|
| Connector schema | Production writer allocated `document.extractor` to `legacy-connector-00`; production reader returned the same pin. The catalog row contains a sealed envelope and not the inline prompt. |
| Static HTTPS egress | URLs in nested parallel branches round-tripped with `https://files.example.test` and `https://hooks.example.test`. |
| Dynamic egress | Skipped as `DYNAMIC_EGRESS_URL`; no catalog row written. |
| Non-HTTPS egress | Skipped as `NON_HTTPS_EGRESS_URL`; no catalog row written. |
| URL userinfo and fragment | Skipped as `EGRESS_URL_USERINFO` and `INVALID_EGRESS_URL`; no catalog row written. |
| Unsealed catalog row | Production reader rejected plaintext with `SCHEMA_CRYPTO_UNAVAILABLE`. |
| Idempotency | First run wrote revision 1; second run skipped as `ACTIVE_ROW_EXISTS`; no revision 2 was created. |
| Provision race | An active row appearing after the pre-check produced `SCHEMA_REVISION_CONFLICT`, reported as a skip. |
| Tenant semantics | Missing preflight tenant did not seed; execute generated and resolved a UUID after name-only seed; duplicate names failed closed. |
| Updated-at tie | Synthetic selector candidates chose the greatest byte-order key and listed both the tied loser and older loser with reasons. |

Focused command and environment:

- CWD: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`
- Runtime: Node v24.21.0
- Command: `npm run test:unit -- --runTestsByPath tests/legacy-workflow-schema-backfill-adapter.test.ts`
- Result: 1 suite passed, 7 tests passed, 0 failed, exit code 0

The test suite uses synthetic fixtures only. A live legacy source inventory was not run, so actual source slug, loser, skip, and origin totals remain unknown.

## Scope and checks

Scoped `git status --porcelain` reports exactly these three authorized paths as untracked. No other path was edited by this task. The wider shared worktree contains unrelated dirty paths; they were left untouched.

`git diff --check` exit code: 2. It reported existing trailing whitespace in the out-of-scope file `du-rework/orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx` at lines 445 and 599. No change was made to that file. Direct checks of the adapter, test, and receipt found zero double-quote characters and zero trailing-whitespace lines.

No commit, git add, push, gate tick, migration, route change, loader change, contract change, catalog change, or crypto source change was made.

## Open items

1. Independent verification of this source and test, followed by the required coordinator or reviewer acceptance. No `VERIFIED`, `ACCEPTED`, or `IMPLEMENTED` gate was ticked by this receipt.
2. Actual legacy source counts and a real database backfill remain unperformed under the R4 offline-only boundary. Any operational run requires its own approved window and execution packet.

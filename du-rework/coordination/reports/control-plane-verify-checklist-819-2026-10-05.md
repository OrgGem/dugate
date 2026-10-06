# CONTROL-PLANE-VERIFY-CHECKLIST-819

**Purpose:** independent acceptance checklist for CONTROL-PLANE-IMPL-818 (A3 metadata plaintext-read control plane).
**Scope:** verification plan only. This receipt does not certify 818 as complete and makes no source, test, commit, or task-tick changes.
**Evidence read:** `encmeta-window-design-808-2026-10-05.md` and `verify-window-doc-817-2026-10-05.md`.

## Reviewer evidence rules

- Do not accept the implementer's summary as the only evidence. A second reviewer must inspect the cited code and independently rerun the focused negative tests from the same source snapshot.
- Do not accept “green” without the exact command, literal exit code, test-suite/test counts, skipped-test count, and raw output. A skipped PG16 test is not a pass.
- Bind evidence to a snapshot: record `git rev-parse HEAD`; record `git status --short -- services/orchestrator/src services/orchestrator/tests services/orchestrator/package.json package.json pnpm-lock.yaml`; and record SHA-256 for every modified or untracked source, test, package/config, and migration file in scope. Recheck hashes after the run. Any hash drift invalidates the attached results until rerun.
- Keep raw logs for each command. Never substitute a receipt or a prose assertion for the command output. A reviewer may not sign off if a required test is absent, if its scope cannot be mapped to an acceptance condition, or if only positive cases were exercised.
- All paths below are relative to `du-rework/`. Run commands from that directory. If implementation chooses a different test filename, the owner must record the exact replacement and map its assertions to every acceptance condition below; an omitted assertion is a failure.

Suggested snapshot commands (run before and after verification):

```powershell
git rev-parse HEAD
git status --short -- services/orchestrator/src services/orchestrator/tests services/orchestrator/package.json package.json pnpm-lock.yaml
git diff --check
```

For each path returned by `git status`, hash the working file, including untracked files:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '<each exact changed path>'
```

The before/after file hashes must match; the final receipt must list the paths, hashes, command exit codes, and Jest totals.

## Corrected source inventory

808 reports six literal-`true` sites. 817 directly checked eight. The following eight call arguments are the required inventory to reconcile against the final implementation; line numbers are the 817/source snapshot anchors and must be re-inventoried after 818 lands.

| # | Source site | Stored value / purpose |
|---:|---|---|
| 1 | `services/orchestrator/src/modules/runtime/runtime.ts:481` | `openMetadata` TEXT branch |
| 2 | `services/orchestrator/src/modules/runtime/runtime.ts:483` | `openMetadata` parsed/object branch |
| 3 | `services/orchestrator/src/modules/runtime/runtime.ts:1236` | child `tasks.result_ref` |
| 4 | `services/orchestrator/src/modules/runtime/runtime.ts:1848` | sibling `tasks.result_ref` |
| 5 | `services/orchestrator/src/http/routes/public.ts:542` | public `GET /operations/:id/result` |
| 6 | `services/orchestrator/src/modules/operations/mappers.ts:70` | operation `input_ref` |
| 7 | `services/orchestrator/src/modules/operations/mappers.ts:145` | operation `result_ref`; omitted by 808, whose `mappers.ts:103` anchor is stale |
| 8 | `services/orchestrator/src/modules/operations/ingestion-consumer.ts:704` | root task `payload_ref`; omitted from the 808 list entirely |

Do not close 818's inventory with “six sites replaced.” All eight must be accounted for, with their original `(tenantId, slot, refId)` binding preserved. Also check that the design's item 5 is expanded from two to three HTTP/mapper calls and that the consumer call is added to the shared-policy wiring or explicitly proven to have an equivalent policy path.

The strict-`false` boundary is four independent paths with five literal arguments. Keep all of them outside the compatibility window:

| Strict path | Source anchors | Required invariant |
|---|---|---|
| prompt-overrides carrier | `runtime.ts:358-362` | carrier open stays `false` and keeps its no-seam guard |
| dispatch source URL | `operations/ingestion-consumer.ts:336-340` | envelope-only open stays `false` |
| authenticated census | `encryption/metadata-auth-counter.ts:287-305` (`false` at `:291` and `:297`) | both TEXT and JSONB reader calls stay strict |
| nested envelope open | `runtime/metadata-crypto.ts:427` | decoding a parsed envelope stays strict |

The eight `METADATA_SLOTS` at `runtime/metadata-crypto.ts:44-62` comprise three TEXT columns and five JSONB columns. Among the six non-`result_ref` slots, `step_checkpoints.output_ref` is TEXT and the other five are JSONB (`metadata-auth-counter.ts:81-90`). Do not describe all six as JSONB or implement only the two `result_ref` slots as if that were full eight-slot coverage.

## Ten acceptance checks (the ten 808 checklist items)

### 1. Reuse the bounded-window primitives; implement one policy/reader

**Inspect:** `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts:492-541` and the new `modules/encryption/metadata-read-policy.ts`.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/legacy-payload-migration.test.ts tests/metadata-read-policy.test.ts
```

`metadata-read-policy.test.ts` (or an identified equivalent) must prove the closed `window | forbid` type/runtime enum, coherent mode/window construction, the existing inclusive-start/exclusive-expiry rule, the 14-day maximum via `createBoundedDualReadWindow`, sealed values always use the authenticated decoder, and plaintext reads are allowed only when the policy says so. There must be one shared policy/reader; do not add another independent window implementation. Expected: exact focused suites and assertions run, zero failures, zero unexplained skips, exit 0.

### 2. Parse one operator mode at boot; fail closed on invalid or absent mode

**Inspect:** `modules/encryption/boot-options.ts:26-31`, the mode parser/builder, `src/main.ts`, and `src/app/bootstrap/create-app.ts`. Verify the environment key's spelling is the same in the parser, `.env.example`, Compose/deployment config, tests, and operator docs. The current source constant is `DU_METADATA_PLAINTEXT_READ_MODE`; do not silently substitute the design prose name `METADATA_PLAINTEXT_READ_MODE`.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/encryption-boot-options.test.ts tests/metadata-read-policy-boot.test.ts
```

The required boot tests must start the real boot composition path (or a faithful boot harness) and prove: missing mode fails startup; an unknown value such as `enabled`, `true`, or a misspelling throws a named boot error; no branch silently defaults to `window` or `forbid`; `window` requires valid start/end values within the cap; and `forbid` is built without an open legacy window. Confirm the error occurs before serving requests. Existing `encryption-boot-options.test.ts` alone does not establish this new behavior. Expected: every negative boot case rejects; valid `window` and `forbid` cases reach composition; exit 0.

### 3. Construct once and inject into runtime and submission services

**Inspect:** `app/bootstrap/create-app.ts:302-325` and `modules/operations/submission.ts:104,178-192`; compare the instance identity passed into runtime, submission, the ingestion consumer, and any route dependencies. `create-app.ts` must build the policy/reader once next to the metadata crypto seam, not once per service.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-read-wiring.test.ts tests/crx01-metadata-wiring.test.ts tests/submission-metadata-crypto-e2e.test.ts
```

The wiring test must prove one policy controls all relevant services and the effective mode is the same at boot, runtime reads, and submission/consumer reads. A test that only asserts a constructor received a non-null object is insufficient. Expected: shared-instance identity or equivalent single-construction proof, no independent per-service fallback, exit 0.

### 4. Replace the four runtime `true` decisions

**Inspect the corrected inventory rows 1-4 above**, including the actual branches at `runtime.ts:481,483,1236,1848` in the 817 snapshot. Confirm each call uses the shared reader/policy and retains its tenant, slot, and row reference binding. The final source must contain no compatibility decision hidden in a helper that bypasses the injected reader.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-read-wiring.test.ts tests/runtime-encryption-metadata.test.ts tests/enc-meta-sentinel-runtime-refs.test.ts
```

Require the wiring suite to enumerate these exact four consumers and exercise both plaintext-in-window and plaintext-forbidden/expired behavior, plus sealed-valid and sealed-invalid behavior. Expected: all four follow the same decision table, with bindings unchanged and strict-`false` paths unchanged; exit 0.

### 5. Correct and complete the HTTP/mapper inventory; include the omitted consumer

**Inspect corrected inventory rows 5-8 above:** `public.ts:542`, `mappers.ts:70,145`, and `ingestion-consumer.ts:704`. 808's item 5 says two HTTP/mapper sites; 817 found three there, plus the omitted ingestion consumer. All four must be governed by the policy or have a documented, tested equivalent. Preserve route DTOs and each original `(tenantId, slot, refId)` tuple.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-read-wiring.test.ts tests/runtime-encryption-metadata.test.ts tests/submission-metadata-crypto-e2e.test.ts
```

Require per-consumer tests for public result, mapper input, mapper result, and root task payload. The test must fail if any one remains a literal `true`, is skipped when the seam is absent, or binds a different row. Expected: all four use the same allow/deny decision; no route payload shape regression; exit 0.

### 6. Thread the reader through route context

**Inspect:** `http/route-context.ts:79-84` and all route-context construction sites in `app/bootstrap/create-app.ts`. The current snapshot carries `metadataCrypto`; the final context must carry the control-plane reader/policy needed by route consumers without creating another instance.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-read-wiring.test.ts tests/crx01-metadata-wiring.test.ts
```

Assert a real route harness receives the boot-created reader and that public route plus mappers use it. Expected: no direct route-level literal decision, same policy identity, exit 0.

### 7. Add an explicit production backfill CLI; never auto-run it on boot

**Inspect:** `modules/encryption/legacy-payload-migration.ts:324-490,771-875`, the package script, and the proposed `src/backfill-metadata-cli.ts`. The 817 review found no production caller, no CLI file, and no `backfill:metadata` script at that snapshot. Require an explicit invocation, a required database setting, before/after count-only inventories, resumable per-row failure reporting, and a nonzero result unless unresolved count is zero and backup sign-off is true. A pure `canRetireLegacyPayloads` predicate is not a caller or authorization mechanism.

**Run (mocked/disposable only):**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/backfill-metadata-cli.test.ts tests/encmeta-enc09-kind.test.ts tests/legacy-payload-migration.test.ts
```

The CLI test must prove boot does not invoke backfill, an explicit command does, payload contents/secrets never appear in logs, a failed row keeps the run incomplete/resumable, and incomplete/unresolved/no-backup states exit nonzero. Do not run the production CLI against the project `DATABASE_URL` as part of this offline checklist. Expected: mocked/disposable tests exercise each exit condition; exit 0.

### 8. Extend backfill/storage coverage to all eight slots and keep the tenant gate complete

**Inspect:** `runtime/metadata-crypto.ts:44-62`, `encryption/metadata-auth-counter.ts:58-90,215-224,322-388`, and `legacy-payload-migration.ts:639-647,771-875`. Correct 808's type error: the six slots remaining after the two result refs include one TEXT (`step_checkpoints.output_ref`) and five JSONB. Require correct slot-specific tenant/refId bindings and storage codecs for all eight, or an explicit documented block on retirement until unsupported slots are covered.

The gate invocation must include `expectedTenantIds` from an independent full-visibility census. Missing/empty/duplicate/invalid expected IDs, missing tenants, unexpected tenants, RLS-hidden tenants, any failed slot, or incomplete coverage must produce `FAIL`, never a vacuous `PASS`. Also record the separate `outbox.payload`/source-URL duplicate census: it is not automatically covered by the eight `METADATA_SLOTS` (`verify-window-doc-817`, claim analysis and bypass-audit reference).

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-backfill-all-slots.test.ts tests/encmeta-enc09-kind.test.ts tests/legacy-payload-migration.test.ts tests/gate-authenticate-808.test.ts
```

For the real PostgreSQL behavior test, use only a newly created disposable PG16 and its dedicated `GATE_AUTH_PG_URL` (the existing test is skipped without it):

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/gate-authenticate-808-pg16.test.ts
```

Expected: all eight slots are enumerated exactly once; no wrong-type or wrong-ref binding; RLS-hidden/missing-tenant and incomplete-coverage fixtures fail the gate; the disposable PG16 suite is reported separately from ordinary offline Jest runs. Exit 0 for the tests does not certify project-DB coverage.

### 9. Add policy/reader unit tests that pin strict and compatibility truth tables

**Inspect:** `tests/metadata-read-policy.test.ts` (required or equivalent) alongside `tests/legacy-payload-migration.test.ts`, `tests/runtime-encryption-metadata.test.ts`, and the wiring suite. Unit coverage must include plaintext in-window, at the inclusive start, exactly at exclusive expiry, after expiry, `forbid`, valid sealed reads in both modes, malformed/tampered sealed values, absent crypto seam, and the strict special paths below.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-read-policy.test.ts tests/legacy-payload-migration.test.ts tests/runtime-encryption-metadata.test.ts tests/metadata-read-wiring.test.ts
```

In the same suite (or a dedicated assertion suite), explicitly verify all four strict paths / five false arguments in the strict-boundary table. These must remain `false` after the eight compatibility sites are replaced. Expected: all truth-table and strict-boundary cases execute and pass; a single strict argument changed to true makes a test fail; exit 0.

### 10. Run focused and regression suites; typecheck/build the exact reviewed snapshot

**Run:**

```powershell
pnpm --filter @du/orchestrator test
pnpm --filter @du/orchestrator typecheck
pnpm --filter @du/orchestrator build
```

Capture exact exit codes and Jest totals for each invocation, including skipped suites/tests. Resolve new failures before sign-off; any claimed pre-existing failure must have an independent same-snapshot A/B result and must not be counted as green. Expected: full test, typecheck, and build all exit 0, then source/test/config hashes remain identical to the pre-run manifest.

## Additional blocking checks from 817 and the requested A3 criteria

### Closed enum and boot failure, not fallback

The two legal values are exactly `window` and `forbid`. Empty, absent, case-changed, typo, and arbitrary strings must throw a boot error. `window` without a bounded window and `forbid` with a legacy window must fail construction. A boot integration test must observe startup rejection, not only call a parser directly. A `switch` default to `window`, `true`, or “compatibility mode” is a blocker.

### All eight `true` sites replaced while all strict paths stay strict

Require an AST-backed inventory assertion (or equivalent direct source inspection plus call-site tests) to compare the final tree to the eight-row inventory. It must prove zero remaining `true` compatibility arguments at those eight sites, every site reaches the single policy, and all four independent strict paths/five false arguments remain false. A grep alone is supplementary because calls are multiline and unrelated `true` values exist nearby.

### Two-gate retirement and full-visibility tenant census

The backfill/retirement result and authenticated gate are separate mandatory checks: (1) inventory unresolved references is zero and backup sign-off is true; and (2) authenticated gate blockers are zero, all eight slots are scanned, and a nonempty independently sourced `expectedTenantIds` census matches observed tenants. The 808 example `countUnsealedWithAuth({ db, crypto })` is incomplete under the current API and must not be accepted. A local PG16 fixture with a deterministic test key proves gate logic only; it does not prove production rows or production RLS visibility.

### Metrics and close authorization must be executable

The prose in 808 is not evidence. Require actual metric registration/emission and tests that invoke readers/backfill and observe changed metric samples for `metadata_read.sealed_total`, `metadata_read.plaintext_total`, `metadata_read.blocked_total`, `metadata_read.mode`, `backfill.migrated`, `backfill.verified`, `backfill.failed`, `backfill.unresolved`, and `backfill.state`. Verify at least one read of each outcome increments the correct registered instrument and the mode metric exposes the configured window bounds without payload or secret values.

Require an executable closure/authorization path: an authorized operator can approve/configure the window and an early `forbid` flip only through the documented authorized channel; unauthorized attempts fail, and the actor/decision/time are auditable. The fixed expiry must close plaintext reads on every governed path at the exclusive deadline, emit the blocked metric, and cannot be extended or bypassed by a metric, scheduler, or missing env. The 808 text says both that expiry is automatic and that both closure paths need an env change/restart; implementation and docs must resolve this contradiction, and tests must pin the chosen behavior. If authorization exists only as prose or an env variable with no protected deployment/audit path, mark this criterion **FAIL / live authorization evidence required**.

**Run:**

```powershell
pnpm --filter @du/orchestrator exec jest --runInBand --runTestsByPath tests/metadata-read-observability.test.ts tests/metadata-read-policy.test.ts tests/metadata-read-policy-boot.test.ts
```

Those named tests (or mapped equivalents) must assert registered metric values and authorized/unauthorized closure outcomes, not merely search for metric strings or test a pure policy object. A live deployment scrape/alert and deployment authorization audit remain separate evidence.

## Offline-provable vs live-only

| Evidence | Offline / disposable proof | Live-only proof |
|---|---|---|
| Policy enum, boot rejection, single instance injection, all eight call sites, strict-false boundaries, per-slot binding, expiry boundary, metric increment logic | Unit/integration tests with deterministic fixtures; source/hash review | Production deployment reflects the same reviewed artifact/config |
| Slot coverage, RLS visibility, `expectedTenantIds` mismatch behavior, backfill transaction semantics | Disposable PG16 fixture, dedicated database only; synthetic rows and deterministic test key | Full production census under an independently verified role that sees every tenant/slot; actual unresolved-row counts |
| Authenticated envelope reads | Offline deterministic crypto seam proves logic and tamper/context rejection | Real Vault key/provider opens every non-null production envelope using each row's actual tenant/slot/refId binding |
| Backfill and retirement gate | Mocked CLI and disposable PG16; no project DB URL | Explicitly approved production run after signed backup, operator decision, before/after inventories, and exit/result evidence |
| Metrics and operator authorization | Test registry/sample increments, authorization logic and audit-record shape | Actual deployment scrape/alert plus access-control/deployment approval record tied to the mode/window change |

Do not mark target-data readiness, backup sign-off, full tenant visibility, or real Vault readability as offline-proven. A production read/migration/flip stays outside this checklist until a user-approved live window.

## Snapshot observation at checklist drafting

The workspace HEAD observed during drafting was `b088eececcb5f3df0b4edbe073a29401dafda624`. At that snapshot the eight `true` call arguments were still present at the corrected locations above; the new policy module and mode env constants existed, but the route context still carried only `metadataCrypto`, and no metric emitter or production backfill CLI/script was found. This is baseline context only, not a test verdict; re-inventory and hash the final 818 tree before applying this checklist.

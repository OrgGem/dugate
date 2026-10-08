# WFA Section 8 — Independent Security Review (schema execution + security)

- Reviewer: OpenCode 4 (`oc_4`) — reviewer of record for this gate.
- Date: 2026-10-08 (Asia/Saigon, UTC+7).
- Mode: **READ-ONLY** — no product source/test edits, no commit/push, no `docs/21-openapi.json` edits, no plan edits, **no gate tick / no VERIFIED / no ACCEPTED**. Only this receipt + raw logs created.
- Scope: `du-rework` only.
- Basis: WFA plan `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §8 ("Independent review of schema execution/security is required before release; no cutover in this task").
- Prior reviewer `term_cefb27a0` died on quota before writing a receipt; its findings are not credited here. This review starts from the code.

## RESUME POINT

**VERDICT: SAFE-WITH-FINDINGS** (finalized — see full findings table + not-covered list below). No HIGH/UNSAFE finding; harness runs green (15/15 reference, 49/49 full dir). Gate NOT ticked.

## Status log (incremental)

- Receipt created before deep review begins (quota protection, as instructed).
- Stage A done: WFA plan §6/§8 read; T26/T27 lane receipts read; runtime.ts SQL interpolation scan; workflow-schemas module + migration 0037 read; claim/failTask fencing read.

## Area 1 — Schema provisioning/validation on a fresh DB (WFA-T37)

Evidence reviewed: `migrations/0037_legacy_workflow_schema_catalog.sql`, `src/modules/workflow-schemas/workflow-schemas.ts`, `tests/workflow-api/schema-catalog.postgres.test.ts`.

- Migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and fail-closed by construction: PK `(tenant_id, slug, revision)`, CHECK on slug regex/revision/digest format/`jsonb_typeof(schema_ref)='object'`, tenant FK, and a partial unique index enforcing **one active revision** per tenant+slug (`0037:15-17`).
- `provisionLegacyWorkflowSchema` (`workflow-schemas.ts:205-337`) validates the schema via `parseLegacyWorkflowSchema` before any write, seals the envelope (schema + connectorSlotMap + approvedEgressOrigins) **outside** the tx with tenant AAD + `refId=slug:revision` (`:294-298`), then CAS-checks the observed active revision under `pg_advisory_xact_lock` + `FOR UPDATE` (`:300-316`), retires the old row and inserts the new one atomically (`:317-326`). Plaintext is never stored; crypto absence → `SCHEMA_CRYPTO_UNAVAILABLE` (`:109-114`).
- `resolveLegacyWorkflowSchema` (`:152-199`) is tenant-fenced in SQL (`WHERE tenant_id=$1 AND slug=$2`), opens with tenant AAD, and re-validates envelope shape + recomputed digest + `row.tenant_id === requestedTenantId` before returning (`:124-126`); retired rows are distinguishable (`SCHEMA_NOT_ACTIVE`) and unknown revisions return null.
- Preliminary: **no HIGH finding**. One INFO/LOW observation: the advisory lock uses `hashtext($1), hashtext($2)` (`:360`), so unrelated (tenant, slug) pairs can collide into the same lock key — worst case a transient cross-tenant block, not a data leak. Test coverage pending (run below).

## Area 2 — SQL construction and tenant fences in the workflow runtime

- `src/modules/runtime/runtime.ts` scan for `${…}` in SQL: the only SQL-fragment interpolation is the conditional cursor clause (`:1848-1849`), gated on a boolean, never on user input; all other `${…}` matches are error messages/delivery ids. No string interpolation of caller data into SQL found in this file.
- `claimTask` (`:546-624`): `SELECT … FOR UPDATE OF t`, business-identity check before any mutation (`:567-569`), terminal + `PENDING_INGESTION` gates, lease-owner check, epoch increment under the same tx. `failTask` (`:942-1063`) writes RETRY_PENDING/FAILED/CANCELLED only with `t.lease_epoch=$n AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()` and a business fence (`($n::text IS NULL OR o.business_id=$n)`); fenced writes return `LEASE_LOST` (`:989, :1010, :1051`). The WFA-T27 `hasCancelSignal` branch (`:979-997`) converts an acknowledged cancel into `CANCELLED` in the same fenced update.
- Finding (INFO, currently dead surface): `listOperations` cursor subquery `(SELECT created_at FROM operations WHERE id=$2)` (`:1848`) is **not tenant-fenced**; the outer query still filters `tenant_id=$1`. No caller of `.listOperations(` exists anywhere in `du-rework` (grep), so it is an unused surface today; if it gains a caller, add `AND tenant_id=$1` to the subquery. No cross-tenant row exposure found.
- Open sub-check: `workerBusinessId ?? null` in `failTask`/`retry` (`:987, :1008, :1049`) skips the business fence when null. Who can invoke the runtime route with a null business id (legacy compat vs authenticated worker) is being checked in Area 3.

## Area 3 — AuthN/AuthZ on the public workflow surface (WFA-T29..T32)

- `resolveApiKey` (`src/http/routes/api-key-auth.ts:10-22`): missing key → 401; lookup `WHERE hash=$1 AND status='ACTIVE'` — only ACTIVE keys resolve, no fallback (comment `:13-14`, R08-01). Legacy mount resolves identity only through this (`public.ts:331-337`), never from headers/body.
- `bodyApiKeyId` mismatch denied on **both** workflow routes: schema branch `legacy-http-mount.ts:530-532`, named branch `:563-565` → 403 `Forbidden`. Match logic `:465-473` accepts only the caller's own key id or the exact presented key.
- Tenant scoping on reads: legacy operation row load filters `tenant_id=$2 AND deleted_at IS NULL` (`legacy-host-adapter.ts:584-589`); operation detail/download re-check `op.tenant_id !== apiKey.tenantId → 404` (`public.ts:527`); artifact reads join with tenant fence (`public.ts:630-642`). Workflow submits carry `principal.tenantId` from the resolved key end-to-end (`legacy-host-adapter.ts:95-109,114-228`).
- Test evidence: reference harness run below exercises the key fences (T29-T32 side-harvest inside the 15 tests, incl. wrong-key 401 and no ADMIN fallback), all green.
- Known pre-existing defect (INFO, not introduced by WFA): unauthenticated/incorrect-key **legacy read** routes answer 500 instead of 401 (`rv01-loopback-http-offline.test.ts:1506-1520`, pinned `it.failing` RV01-F4; a wrong key returning 500 is pinned as current behavior). It is a legacy-read surface issue, out of the workflow-submit path.

## Area 4 — SSRF, bounds, redaction (WFA-T33..T36)

- Egress: both URL nodes resolve through `requireApprovedHttpsOrigin(pin, url, nodeType)` before any socket (`legacy-schema-runtime.ts:925-929` for `file_url_download`, `:980-993` for `callback`); `validateStaticHttpsUrl` (`:1325-1336`) requires a literal HTTPS URL with no credentials/hash; `:1338-1340` requires the origin to be in the pin's administrator-approved `approvedEgressOrigins`; fetch uses `createPinnedFetch` from `@du/egress` (DNS pinning, private-network denial by default; harness leaf tests assert `LEGACY_WORKFLOW_EGRESS_URL_INVALID` fail-closed).
- Bounds: multipart 64 MiB cap + boundary/header caps (`legacy-multipart.ts:70-75`), `TOO_MANY_FILES → 413` (`legacy-http-mount.ts:422-424`); JSON 1 MiB / blob 64 MiB ingress caps (`http/ingress.ts:28-29,55-61`); archive `maxTotalBytes ≤ MAX_ARTIFACT_BYTES` and `maxEntries ≤ 64` (`legacy-schema-runtime.ts:1094-1103`); legacy download bytes capped (`public.ts:361-362`).
- Redaction: transport failures use fixed redacted text (`http/errors.ts:90-91`); schema-catalog errors are mapped to fixed messages (`legacy-http-mount.ts:439-447`); worker error frames shown in harness diagnostics are explicitly “messages redacted”. Observation (LOW, missing-test gap): `workflowHostErrorResponse` forwards `HttpError.message` into the legacy detail for mapped statuses (`:432-434`); no test pins that a 5xx/upstream message can never leak there. No concrete leak found in review.

## Area 5 — Lease/claim fencing and cancel semantics (WFA-T25..T28)

- Terminal writes are fenced: `failTask` requires `lease_epoch` match + `state='RUNNING'` + `lease_expires_at > clock_timestamp()` + business fence, else `LEASE_LOST` (`runtime.ts:979-997, 999-1040, 1042-1063`); `claimTask` checks business identity before exposing the snapshot or mutating (`:567-569`), refuses terminal/ingestion-gated rows, and only a non-expired foreign lease blocks (`:592-604`).
- T27 `hasCancelSignal` branch turns an acknowledged cancel into `CANCELLED` for task + operation in the same fenced tx (`:979-997`); T26 fixed the lease-loss vs real-cancel distinction (`worker-sdk/src/task-context.ts:348` abort-with-reason, `connector-invoker.ts:171` notify-cancel only for `reason==='cancel'`). Attribution A/B is recorded in `wfa-t26-lease-recovery-2026-10-08.md` and `wfa-t27-attribution-2026-10-08.md`.
- Observation (LOW/INFO): the business fence in `failTask`/retry is skipped when `workerBusinessId` is undefined (`($n::text IS NULL OR …)`, `:987,1008,1049`). No caller in the reviewed surface reaches it without an authenticated worker identity (runtime route passes the authenticated worker business id; legacy compat uses lifecycle, not failTask). Flagged for the coordinator, not demonstrated exploitable.
- Harness isolation gap (MED, **test-infra, not product**): per `wfa-t26-lease-recovery-2026-10-08.md` §7, the WFA harness never creates the connector schema (`connectorIsolationContext.dbSchema` not `CREATE SCHEMA`), so `connector_invocations` rows share the `public` schema across runs — cross-run interference risk for ledger-based tests/attribution.

## Test evidence (this review, Node v24.21.0, cwd `D:\Git\dugate\du-rework`)

| Command (via `tests/workflow-api/run-jest.cjs`) | Exit | Literal summary |
|---|---:|---|
| `… wfa-section8-reference-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts` | **0** | `Test Suites: 1 passed, 1 total` / `Tests: 15 passed, 15 total` |
| `… wfa-section8-fulldir-2026-10-08.log` (all workflow-api suites) | **0** | `Test Suites: 10 passed, 10 total` / `Tests: 49 passed, 49 total` (log 1,338,169 B) |

Raw: `coordination/reports/raw/wfa-section8-security-review-2026-10-08/{reference-run.txt,fulldir-run.txt}`; harness logs `tests/workflow-api/logs/wfa-section8-{reference,fulldir}-2026-10-08.log`. No red hidden: these are the literal summaries; no test was skipped or edited.

Note: the raw directory also contains pre-existing artifacts from the terminated prior reviewer session (`01-worker-full.txt`, `http-worker.integration.console.retry.log`, `egress-boundaries-node24.console.log`, etc.). They are **not** used as evidence in this review and are not credited to me.

## Findings

| # | Severity | Where | Why it matters | Type |
|---|---|---|---|---|
| F1 | INFO | `runtime.ts:1848` cursor subquery lacks tenant fence | `created_at` oracle if a caller is ever added; **no caller exists today** (dead surface), outer query still tenant-fenced | Product defect (latent, unused) |
| F2 | LOW | `workflow-schemas.ts:360` `hashtext()` advisory lock | Unrelated (tenant, slug) pairs can collide → transient cross-tenant blocking, no data impact | Product defect (cosmetic/robustness) |
| F3 | MED | WFA harness connector ledger not schema-isolated (`wfa-t26-…md` §7) | Ledger rows shared in `public` across runs → flaky/interfering attribution evidence | Test-infra / missing-test gap |
| F4 | LOW | `legacy-http-mount.ts:432-434` forwards `HttpError.message` to legacy detail | Potential future leak if an upstream message ever becomes an HttpError message; no test pins redaction for 5xx | Missing-test gap |
| F5 | INFO | `worker-sdk` 12 red + `document-core` 11 red pre-existing (per T26 receipt §5) | Known reds outside this review's runs; still open evidence debt | Pre-existing, not WFA-introduced |
| F6 | INFO | RV01-F4 legacy unauthenticated read 500 vs 401 (`rv01…:1506`) | Pre-existing known defect on legacy read surface (not workflow submit) | Pre-existing, pinned `it.failing` |

No HIGH finding. No UNSAFE condition found in the reviewed surface.

## Not covered by this review

- Legacy root `D:\Git\dugate` outside `du-rework`, and nocobase (out of scope by instruction).
- Live/browser/deployment gates, real Vault/DB production paths, and the DB-window protocol.
- Full monorepo test sweep: worker-sdk/document-core pre-existing reds (F5) were not re-run here; only the WFA harness was run (all green).
- Dedicated WFA-T33..T36 vector matrix beyond what the harness runs (I reviewed code + existing scaffold/egress tests; did not build new probes).
- Rate limiting/DoS, dependency CVEs, and OpenAPI generation (WFA-T38).
- Gate tick / VERIFIED / ACCEPTED — deliberately not written; that is the coordinator's and the user's call.

## RESUME POINT

**VERDICT: SAFE-WITH-FINDINGS.** The reviewed workflow API surface (schema catalog, SQL construction, auth fencing, SSRF/bounds/redaction, lease/cancel) shows no HIGH/UNSAFE defect; all executed WFA harness suites are green (15/15 reference; 49/49 full dir). Open items are LOW product nits (F1, F2), one MED test-infra isolation gap (F3), one LOW missing-redaction-test gap (F4), and pre-existing reds/defects (F5, F6). Section 8 gate is **NOT ticked** — decision belongs to the coordinator/user.

### Status log (continued)

- Stage B done: Areas 3–5 code review + auth/bounds/redaction checks.
- Stage C done: reference + full-dir harness runs (exit 0), raw saved.
- Receipt finalized; no further stages planned.


> **Second independent review filed separately (lane OC-b, 2026-10-08).** This path already held the in-progress review of record by `oc_4`; the second leg did **not** overwrite it. Full second review: [`wfa-section8-security-review-oc-b-2026-10-08.md`](wfa-section8-security-review-oc-b-2026-10-08.md) (read-only; per-area PASS/GAP verdicts; no gate ticks; T26/T27 first-hand 15/15). Raw legs share `raw/wfa-section8-security-review-2026-10-08/` — second-leg full-suite log is `01-worker-full.txt` (exit 0, 2026-10-08 08:54).

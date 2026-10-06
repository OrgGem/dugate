# VFY-CB-01 / C3 and C4 OpenAPI recount verification — 2026-10-06

- Owner: codex_arch; direct user verification packet, cwd `D:\Git\dugate\du-rework`.
- Audit input: [Claude r4 review](claude-audit-review-r4-2026-10-06.md), Group C close-out.
- Scope: initial read-only inspection/test harness/PG metadata probe, followed by user-authorized **C4 generator/validator reconciliation and generated artifact refresh**. No runtime product-source edits, migration apply, deployment, commit or push.
- **Latest verdict: C4 recount / NO-DROP / structural validation / provenance PASS; C4-PROV-01 RESOLVED by reconciliation below. C3 dispatcher seams VERIFIED-OFFLINE; production wiring/applied r4 DB/live acceptance OPEN. VFY-CB-01 is not fully closed.**

## C4 — actual artifact recount and baseline

Recount parses `docs/21-openapi.json` directly and counts only HTTP method keys (get/post/put/patch/delete/head/options/trace), independently of the generator's printed counts.

| Check | Observed |
|---|---|
| Artifact version / exact inventory | **v1.4.0 / 58 paths / 62 operations / 51 schemas** |
| Current artifact SHA-256 after C4 reconciliation | `1388add7b1a30b535228f9acc1e04e23123de1aaeda9e17cb9e3057339c5c89c` |
| OpenAPI 3.0 structural validation | `openapi-spec-validator 0.9.0`: **0 errors** |
| Existing canonical validator | exit 0; 37 SC/CB model projections match, local refs resolve, declared operation IDs unique; 23 example probes PASS |
| Baseline | `HEAD:4308cc54eda32cfcca54e0c55554fc85d720a43b:du-rework/docs/21-openapi.json` — same 58/62/51 |
| Semantic diff vs baseline | No added/dropped paths, operations or schemas. Only **POST `/admin/api/secrets`** changed: implemented BFF create dispatch/body/errors instead of unconditional 405. **NO-DROP relative to HEAD and pre-reconcile artifact: paths 0 / operations 0 / schemas 0** |
| Baseline raw blob SHA-256 | `d1cf79721220ae89c7ddf37bf45a8e5c0bf955168168dcb51a804e75a023a646`; pre-reconcile working artifact `7f0afb86c151e5ee204e82cc75c4dda3cfca1f14c51cf6ab403b51da26a46840` was semantically identical to HEAD. Reconciled artifact now differs semantically at POST create as stated above |

This HEAD already contains v1.4.0, so this verification does not portray it as a pre-SC/CB 1.3 baseline. The earlier [SC-04/CB-05 owner receipt](sc-04-cb-05-openapi-sync-2026-10-06.md) recorded successful generation/no-drop at its source snapshot; those historical runs are separate from the fresh check below.

### Generator provenance / C4-PROV-01 resolution

Provenance is `tools/openapi/gen_openapi.py` + `tools/openapi/catalog_callback_schemas.cjs`, canonical `secret-catalog.ts` / `profile-callback.ts` / `public-api.ts` and router source. Latest generator SHA-256: `a6978f58039a101cfbb6cffcb5e025dc21319d40f4907d0abd72f85d791856aa`; validator: `52c76829dc45d736fcf5d4b9132322f090edaf37f0137d23f8e98bc99038af6f`; projection helper unchanged: `0856b29a6c2c26880960267457d02423fbdd0f72d3b6f867cc547e79443c5a60`. BFF source hash at reconciliation: `e843a77165f4725ef1a489320f95e996d4a6d86037cdec5d341b8ad30d42801d`.

Temporary generation changes **only the `OUT` assignment in an in-memory AST**, preserves canonical `__file__`/source resolution, and seeds temp output with the prior actual artifact for NO-DROP guards. Temp spec is structurally and canonically validated **before** canonical regeneration. Canonical `docs/21-openapi.json` is then written only by `python tools/openapi/gen_openapi.py`; no JSON hand-edit.

**Historical finding retained:** initial isolated run exited 1 (`Secret method routing changed: reconcile create availability before generating`) because `bff/secrets.ts:85-96` had effectiveRoute GET-list/POST-create while generator required old list-only method gate. Original failure evidence remains in the parent raw folder; it is superseded by the passing reconciliation evidence below.

**Fix:** generator guards now require the effectiveRoute dispatch and validation/upstream path fragments and reject a reintroduced list-only gate. POST create carries canonical create properties with body tenantId optional only because BFF can inject resolved query scope; body/query tenant mismatch remains denied. Platform-admin session/CSRF, bounded body, idempotency-key forwarding and upstream 404/503 limitations are documented. Upstream catalog API is still absent; removing unconditional BFF 405 does not claim repository/storage availability. Validator checks create DTO fields/required keys/CSRF/errors and removes the obsolete 405-only expectation; `--spec` supports temporary artifact validation.

| Reconciliation command / cwd `du-rework` | Result |
|---|---|
| Isolated generator seeded with pre-reconcile artifact | exit 0; **NO-DROP paths=0 operations=0** |
| `python tools/openapi/validate_openapi.py --spec <temp absolute path>` | exit 0; canonical model parity, refs/IDs and 23 example probes PASS |
| OpenAPIV30SpecValidator on temp spec | **0 structural errors**, exit 0 |
| `python tools/openapi/gen_openapi.py` | exit 0; canonical artifact matches validated temp output byte-for-byte |
| Isolated generator repeat | exit 0; byte-identical output (deterministic) |
| `python tools/openapi/validate_openapi.py` | exit 0 on canonical artifact |
| Independent pre/post inventory and operation diff | 58/62/51, 0 dropped paths/operations/schemas; only POST `/admin/api/secrets` changed; component schemas unchanged |

Reproducible runner: `python coordination/reports/raw/vfy-cb01-openapi-recount-2026-10-06/c4-reconcile/verify-provenance.py`. [Latest summary](raw/vfy-cb01-openapi-recount-2026-10-06/c4-reconcile/run-summary.json) and [latest source/evidence hashes](raw/vfy-cb01-openapi-recount-2026-10-06/c4-reconcile/SHA256SUMS.txt) bind this PASS; prior raw hashes/logs remain historical. No C3 tests or PG probe were repeated for this spec-only reconciliation. **C4 provenance PASS / C4-PROV-01 RESOLVED**; build owner must refresh bundled OpenAPI on the candidate and reviewer must assess the refreshed artifact. Codex Arch authored the generator; this close-out does not replace Claude's independent code-review verdict.

## C3 — dispatcher mode → auth → send → receipt evidence

Fresh focused command:

`pnpm --filter @du/orchestrator exec jest --config jest.unit.config.cjs --runInBand tests/vfy-cb01-dispatch-matrix.test.ts tests/cb-02-webhook-result-delivery.test.ts tests/cb-03-outbound-auth.test.ts`

**3 suites / 51 passed / 0 failed / 0 skipped, exit 0**. New independently written matrix contributes 8 cases; existing CB-02/CB-03 contribute 23/20. Local Windows Node 22.16.0 / pnpm 10.18.3 emitted the expected Node24 engine warning; this is not candidate Node24 runtime verification.

| Mode | Auth seam checks | Send / receipt / snapshot evidence |
|---|---|---|
| notification_only | none, configured_headers, OAuth2 client_credentials; missing resolver negative | Real dispatcher invoked with scripted SQL + injected DNS/HTTP. Auth headers checked, HMAC valid, deliveryId stable, canonical legacy body; successful SQL receipt path becomes DELIVERED with one attempt. OAuth2 401 → token reacquire → 204, two wire calls with same body hash; no payload rewrite |
| notification_with_result | Same three methods and missing resolver negative | Canonical result-envelope parse, valid HMAC, stable deliveryId, immutable serialized result snapshot; configured header checked; OAuth2 token POST/redirect denial and 401 reacquire checked; DELIVERED receipt path, no payload rewrite |

The matrix uses synthetic test-only credentials internally and does not log them. Fake IdP uses injected fetch returning deterministic JSON; no HTTPS socket/real IdP involved. Fake SQL records executed queries and status changes, **not a real persisted receipt**. It verifies dispatcher wiring under injected seams, not production bootstrap or PostgreSQL semantics. For both modes, missing resolver produces `WEBHOOK_AUTH_UNAVAILABLE`, zero sends and FAILED at exhausted budget.

Additional current-suite evidence: CB-03 fake-clock expiry/no-cache, single-flight, token-response validation and bounded retry; CB-02 configured-header auth, immutable at-least-once replay, projection bounds/omissions, approved-destination negatives, terminal timestamp pin, idempotent scheduling and policy-copy checks. These were rerun, not inferred only from owner receipts.

### Current source wiring and production gap

- `webhooks.ts:156-208`: parse admission pin → select mode → project result or legacy notification → INSERT payload/mode/policy with `ON CONFLICT (operation_id,state_version,destination_url) DO NOTHING`; legacy deliveryId stamped once after insert in the same client transaction.
- `webhooks.ts:633-680`: parse delivery pin → authorize credential destination → require secret resolver → construct outbound auth session. `:683-736`: build/encrypt body before HMAC → stable send closure → `dispatchWithAuth` or none → 2xx outcome → receipt/status update later in dispatcher.
- `app/bootstrap/create-app.ts:1034-1045`: production timer calls `deliverWebhooks` with HMAC secret, drain/network/encryption options, **no `resolveCallbackSecret` or `oauth2Options`**. Helper integration exists inside dispatcher, but credential-bearing production delivery still fails closed without resolver. Profile/admission callback policy plumbing remains unproven; offline seeded operation pins do not demonstrate it.

## Migration 0035 applied-state / immutable snapshot

Read-only probe on the available earlier live-local stack:

- PG: `arch-phase-b-20261006-postgres-1`, `postgres:16-alpine`.
- Running Orchestrator: `du-orchestrator:local`, image ID `sha256:f54750fb8e510207685a38f39b068e238f5a29059d5339cfc0d98e12f54633e7` — **not evidence of candidate r4 deployment**.
- `BEGIN READ ONLY` → `schema_migrations`: **max sequence 33, count 33**; ledger query for ≥34 returns 0 rows.
- `information_schema.columns` for `operations.callback_policy`, `webhook_deliveries.mode`, `webhook_deliveries.callback_policy`: **0 rows**.
- Probe exit 0 and COMMIT; no application rows, credentials or customer data selected.

**Applied-state finding C3-MIG-01: 0035 NOT APPLIED on this inspected old stack; candidate r4 DB applied-state remains NOT VERIFIED.** File existence/hash is not applied proof. Migration SHA-256 `ac769d1b51130e51582466a7c96025ac5c2771032182184f61f0ce413ca8bd61` matches CB-02 receipt.

0035 adds the three columns with IF NOT EXISTS; mode is non-null default notification_only. It does **not** add a database payload-immutability trigger or a rollback script. Application scheduling/retry tests establish freeze/dedup behavior under scripted SQL. Migration 0034 separately protects terminal timestamps/state, but it is also absent on this old stack. Neither behavior has been demonstrated against the r4 database in this packet.

Rollback note: no reverse migration supplied or executed. Dropping callback columns would discard pinned policies/modes and invalidate queued deliveries; production rollback cannot be treated as a harmless reversal. Existing operations/deliveries require an owner-reviewed compatibility/data-retention plan. No DDL or destructive cleanup performed here.

## Evidence / next gate

Raw directory: [run-summary.json](raw/vfy-cb01-openapi-recount-2026-10-06/run-summary.json), [baseline diff](raw/vfy-cb01-openapi-recount-2026-10-06/baseline-diff.json), [generator failure](raw/vfy-cb01-openapi-recount-2026-10-06/generator-isolated.log), [dispatcher run](raw/vfy-cb01-openapi-recount-2026-10-06/dispatcher-tests.log), [applied-state SQL](raw/vfy-cb01-openapi-recount-2026-10-06/applied-state.sql) and [probe output](raw/vfy-cb01-openapi-recount-2026-10-06/applied-state.log). Each command has its literal exit file. Source/evidence hashes in [SHA256SUMS.txt](raw/vfy-cb01-openapi-recount-2026-10-06/SHA256SUMS.txt).

C4-PROV-01 is resolved at generator/artifact boundary by the reconciliation above. Coordinator routes C3 production resolver/admission/migration work to existing integrators. After packaging refresh, independent verification needs exact candidate/DB attribution, 0035 ledger + column state, real PG schedule/receipt persistence and authorized HTTPS token/receiver tests (including expiry/401/replay). Claude adjudicates the new evidence and remaining holds; this receipt does not overturn r4 CHANGES_REQUIRED or close parent/release gates. No commit/push performed.

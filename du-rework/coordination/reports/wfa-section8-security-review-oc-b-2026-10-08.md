# WFA Section 8 — Independent security review, second leg (lane OC-b) — 2026-10-08

- **Task:** coordinator dispatch 2026-10-08 — "WFA Section 8 INDEPENDENT REVIEW of schema execution/security". Basis: WFA plan `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §8.
- **Mode:** READ-ONLY — no product source/test edits, no commit/add/push, no plan/OpenAPI edits, **no gate tick / no VERIFIED / no ACCEPTED**. Only this receipt + raw logs created.
- **Coordination note:** the instructed receipt path `coordination/reports/wfa-section8-security-review-2026-10-08.md` **already holds an IN-PROGRESS review by `oc_4` (reviewer of record)** — to avoid clobbering a live artifact, this second independent review is filed here and pointered from that file after its `APPEND HERE` marker. Raw logs share `coordination/reports/raw/wfa-section8-security-review-2026-10-08/`; this lane's first-hand run log is `01-worker-full.txt`.
- **Environment:** Windows; shell Node v22.16.0; first-hand suite run with Node **v24.21.0** (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`); isolated containers `du-wfa-20261007-55498-pg` / `-56398-redis` (up).

## Verdicts overview (review verdict per area — no gate ticks)

| # | Area | Verdict |
|---|---|---|
| 1 | Fail-closed auth, runtime + connector routes | **PASS** |
| 2 | SQL injection / unbounded queries / tenant scoping (hot paths) | **PASS** (1 LOW oracle observation; 1 unauth-skip sub-check resolved) |
| 3 | SSRF / URL validation (`file_urls`, workflow URL nodes, connector/provider URLs) | **PASS (fences)** · success-path fetch **NOT VERIFIED** · 1 LOW parity gap (`file_urls` no-fetch, undocumented rejection) |
| 4 | Secrets in logs / error messages | **PASS** |
| 5 | Lease/epoch fencing (stale worker writes) | **PASS** |
| 6 | Cancel/deadline terminal semantics incl. T26/T27 | **PASS** (first-hand T26/T27 green + webhook parity) |
| 7 | BusinessJobV1 validation, malformed payloads | **PASS** (with scope note: queue rejection is consumer-edge, not HTTP 422) |

## First-hand run (strongest evidence)

Command (cwd `du-rework`, Node v24.21.0): `node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand tests/workflow-api/http-worker.integration.test.ts`
**Exit 0 — `Tests: 15 passed, 15 total`** including:
`√ recovers an expired lease without repeating the completed provider stage (WFA-T26) (5904 ms)` and
`√ cancels an operation while a provider stage is in flight and aborts that stage (WFA-T27) (1218 ms)`.
Raw: `raw/wfa-section8-security-review-2026-10-08/01-worker-full.txt`. (Cross-ref: qwen lane's three clean wrapper runs 08:48–08:49, same counts, `tests/workflow-api/logs/wfa-muc5-wrapper-clean-run1..3-2026-10-08.log`.)

## Revision reviewed (SHA-256, prefix…suffix)

`runtime.ts c735d18e7ce7…5851468b3c86` · `runtime-route.ts 9da90a584faf…1077958382b2` · `worker-identity.ts d8f830e0dc77…8b68cdae1350` · `connector-invoker.ts cc8aca7e54d4…12334b7bc221` · `task-context.ts f56c6a3a75e7…5e23698601e3` · `worker.ts 35f12d458a27…1403d6d6ff2b` · `connector/services.ts 55aa2043111c…587ddb2f0a6a` · `connector/invoke.ts 8967a6b71e70…f1e8e7b411bc` · `connector/identity.ts 15189f460b9f…c17f92c1a1f2` · `legacy-schema-runtime.ts 552a2c31120c…4f601a2fe0de` · `legacy-host-adapter.ts f827afeecd51…051f23a22a7d`.

## 1. Fail-closed auth — PASS

**Runtime routes** (`orchestrator/services/orchestrator/src/http/routes/runtime.ts`):
- `assertRuntimeAuth` (`:21-27`) → 401 unless `isAuthorizedRuntimeBearer` (platform token or a per-business worker token); per-task/artifact business fence: `assertTaskRuntimeAuth:38-48`, `assertArtifactRuntimeAuth:50-59`, `assertBodyTaskRuntimeAuth:61-69` → 404/403.
- Every route branch is guarded — verified by scanning all branches: `:188, 199-200, 209-210, 226, 242, 258`, usage ingress `:174-179` (separate `usageToken`, 401/403), platform register `:342`, heartbeat `:359-365`, claim `:374-385`, heartbeat/saveStep/progress/complete/fail/children/wait/workspace `:400-508`.
- Identity resolver (`modules/runtime/worker-identity.ts`): constant-time compares (`:16-21`), worker token → business exclusively (`:41-51`), 403 on business mismatch (`:54-64`), boot-time uniqueness vs platform creds (`:79-101`).

**Connector routes** (`orchestrator/services/connector/src/http/server.ts`, `src/identity.ts`):
- `requireServiceIdentity` on **all non-health routes** (`server.ts:185-193`); scope split `connector:manage` (paths `/connectors*`) vs `connector:invoke` (`:192`). Fail-closed composition: `resolveIdentityVerifier:87-108` throws unless a verifier is wired or the **explicit test-runner-gated** carve-out is opted in (warning logged; `isRecognizedTestRuntime:110-114`).
- HMAC bearer: HS256 header, required `exp`, `aud=connector`, scope membership, constant-time HMAC (`identity.ts:19-72`); invalid → `GRANT_INVALID` (401), scope missing → `BINDING_DENIED` (403) with fixed messages (`:56-70`).

No unauthenticated path found outside `/health/*` and the explicit test carve-out.

## 2. SQL injection / unbounded queries / tenant scoping — PASS (hot paths)

- **Injection:** grep `(SELECT|UPDATE|INSERT|DELETE).*${` = **0 hits** in `runtime.ts`, `dispatcher.ts`, and all of `connector/src`. Manual scan of `runtime.ts` found exactly one SQL-fragment interpolation — the cursor clause `runtime.ts:1848-1849` `${cursor ? 'AND created_at < (SELECT created_at FROM operations WHERE id=$2)' : ''}` — a **static literal gated on a boolean**, never caller text. (This coincides with oc_4's live finding candidate; verified independently here.)
- **Tenant scoping / fences:** claim reads scoped by task+operation joins (`:547-560`); failTask/retry/cancel writes carry `t.lease_epoch=$n AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()` + business predicate (`:983-987, 1004-1008, 1045-1049`); workspace-reference scoped `o.tenant_id=$1` (`:1835`); connector revision lookup scoped `{tenantId: claims.tenantId}` (`connector/src/services.ts:93-97`); tenant-list roster scoped in SQL (reviewed in a prior receipt: `admin-read/tenant-list.ts:123,153-156`).
- **Bounded queries:** dispatcher sweep is `LIMIT $1` + `FOR UPDATE SKIP LOCKED` in one tx (`queue/dispatcher.ts:35-46`); recovery sweep default `limit=50` + `SKIP LOCKED` (`runtime.ts:1632-1645`); claim/heartbeat/step/complete/fail are single-row `FOR UPDATE` ops; children/wait single-row.
- **LOW observation (shared with oc_4, not a blocker):** the `listOperations` cursor subquery `(SELECT created_at FROM operations WHERE id=$2)` (`runtime.ts:1848`) is **not tenant-fenced**. Outer rows remain fenced by `tenant_id=$1`; worst case is a single-timestamp oracle for a known foreign operation UUID. Same class as the tenant-roster boundary subquery (reported in `tenant-verify-independent-2026-10-08.md`, OBS-1). Recommend `AND tenant_id=$1` inside the subquery when owner next touches this path.
- **Sub-check resolved:** `workerBusinessId ?? null` skips the business predicate only when the caller is the **platform runtime identity** (`runtime-route.ts:38-40,52` return `undefined` only for that path; worker tokens always resolve a business). Platform runtime = trusted service credential (token compare `worker-identity.ts:32-38`), so this is scoped by design; no worker path reaches the null branch.

## 3. SSRF / URL validation — PASS (fences) · success-path NOT VERIFIED · LOW parity gap

- **Egress core** (`orchestrator/packages/egress/src/pinned-fetch.ts`): single DNS resolution shared by adjudication and dial (`:10-17, 196-221`); `adjudicateUrlDestination` (`contracts/src/ip-policy.ts:244-279`): http(s)-only, **userinfo denied**, IP-literal + numeric host forms, blocked ranges, narrow `allowPrivateNetworks` opt-in; **every** resolved answer must be allowed (`:213-218`); redirect hops re-adjudicated and internal targets destroyed+denied (`:244-286`); no global-fetch fallback, unknown body shapes rejected (`:19-28, 81-95`); TLS verification + SNI on original hostname (`:149-162`); timeout/abort destroy the socket (`:302-324`).
- **Workflow nodes** (`businesses/document-core/.../legacy-schema-runtime.ts`): `file_url_download`/`callback` URLs must match the admission-pinned `approvedEgressOrigins` (https origins) — `:925, :993`, `requireApprovedHttpsOrigin :1340`; validation helpers invoked at admission (`:12-13, 379-389`); fail-closed `LEGACY_WORKFLOW_EGRESS_URL_INVALID` proven by the T19/T21 fence tests (worker evidence recorded in the qwen handover §3).
- **Connector provider URLs** (`connector/src/adapters/transport.ts`): `validateProviderUrl` before send (`:50-59, 139+`); pinned fetch with `allowHosts` from `PROVIDER_ALLOW_HOSTS` — **IP-literal opt-ins only, domains still resolved+adjudicated** (`entrypoint.ts:23-24`, `composition.ts:123`); `redirect:'manual'` + 3xx rejected (`:69, 75-77`); content-length pre-check + streaming cap 10 MiB (`:78-82, 100-137`); sanitized transport error texts.
- **`file_urls` (legacy)**: decode validates URL parse only (`compat/legacy-input-decoders.ts:495-515`, same rule `legacy-wire-decoders.ts:407-421`); submission does a **pre-network** profile-extension policy check (`operations/submission.ts:1204-1225, 1238-1251`); **there is no handler-side fetch** (no SSRF surface). The old direct-download path is not reimplemented; `businesses/document-core/docs/compatibility-matrix.md:82,105` records "Direct worker downloading is not the path used… `file_urls` rejection: REAL PRODUCT GAP (test-only)… needs rejection test or written discontinued-by-design decision". → **GAP (LOW, parity/documentation):** no security exposure found; the missing explicit rejection test/decision belongs to the compat owner.
- **NOT VERIFIED:** success-path fetch (approved HTTPS origin) for `file_url_download`/`callback` — cannot be exercised in the isolated offline run (private-network denied by design); remains OPEN per the qwen handover scope note.

## 4. Secrets in logs / error messages — PASS

- Redaction engine exists and is applied before serialization: `packages/observability/src/redaction.ts:1-52` (sensitive-key, URL, URL-credentials, token-query, Bearer, JWT, provider-key (sk-/xox/gh/AKIA/AIza/hvs), PEM, assignment patterns; `safeErrorForLog` = class-only). Confirmed in the live run: the harness log line `"message":"[REDACTED]"`.
- Connector errors are fixed-text and never echo token material (`identity.ts:16` threat-model note; `:66,69`; `server.ts:126` generic fallback; `transport.ts:58,73,76,80,89` fixed messages — no upstream body/URL echo).
- SDK invoker bounds remote text to 1024 chars + flattens newlines so a remote message cannot forge log lines (`connector-invoker.ts:86-87, 114-115`); no grant/token in any thrown message (auth errors carry only the code, `:204-213`).
- Runtime module contains **no logger/console calls at all** (`runtime.ts` grep = 0), so it has no leak surface; route errors use fixed text + ids. `legacy-schema-runtime.ts` also has zero logger/console usage (grep = 0).
- Connector management read redacts configured provider headers (`redactConnectorRevision`, exercised by `connector/tests/runtime-foundations.test.ts:60`).

## 5. Lease/epoch fencing — PASS (stale worker cannot write)

- Claim: idempotent per (task, deliveryId) (`runtime.ts:593-594`); refuses terminal task/op (`:571-577`) and `PENDING_INGESTION` (`:588-590`); busy-lease conflict (`:598-604`); epoch bump + lease set in the same tx (`:606-613`).
- Every worker write is epoch-fenced: heartbeat `:667-676` (+cancel re-check, `:673`), saveStep `:819`, complete/fail including the T26/T27 cancel branch `:983-987` and retry branch `:1004-1008`, terminal fail `:1045-1049`, children/wait `:1250, :1412`; guards `assertLeaseEpoch :175-177` (LEASE_LOST) and `assertActiveLease :179-186` (410 terminal / LEASE_LOST).
- Recovery: sweep only `state='RUNNING'` + expired lease + **non-terminal op** (`:1639-1642`); bumps epoch, clears lease, emits a stable `deliveryId` (`:1663-1678`) — so the superseded delivery's later writes fail the epoch fence. Consequence verified end-to-end: T26 replayed delivery reused the stable invocation identity and the provider was called **exactly once** (test asserts `['generate_disbursement_report']`, `http-worker.integration.test.ts:1214-1216`).

## 6. Cancel / deadline terminal semantics — PASS (T26/T27 complete in tree; first-hand green)

- Public cancel → `lifecycle.cancelOperation` (`modules/lifecycle/lifecycle.ts:32-74`): idempotent terminal replay (`:42-45`); ops `CANCELLED` + `cancel_requested` (`:47-50`); tasks `CANCELLED` (`:52-56`); open human waits `CANCELLED` in the same tx (`:64-68`); **terminal webhook scheduled in the same tx** (`maybeScheduleWebhook :69-70`) with event type `operation.cancelled` (`webhooks/webhooks.ts:60-61`), insert idempotent per terminal revision (`:205`).
- Deadline sweep (`lifecycle.ts:76-108`): `TIMED_OUT` + tasks cancelled + waits `EXPIRED` + webhook (`operation.timed-out`, `webhooks.ts:62-63`). **Webhook close parity: present for both cancel and timeout.**
- Worker-side propagation: heartbeat refuses extension under cancel and returns `cancelRequested=true` (`runtime.ts:650-658, 667-696`); SDK aborts with reason `cancel` (`worker.ts:369-381`); invoker aborts the socket **and** sends a best-effort `POST /invocations/{id}/cancel` **only for reason==='cancel'** (never for lease-lost, to keep T26 replay valid) — `connector-invoker.ts:147-178`; connector cancel endpoint requires the invocation grant and aborts the in-flight provider dispatch + releases quota (`server.ts:376-383`, `services.ts:180-204`, `invoke.ts:60-73`).
- T27 terminal write: the acknowledged cancel is the outcome — fenced `tasks→CANCELLED` + `operations→CANCELLED` + webhook (`runtime.ts:979-997`).
- Retry-after-cancel: retry requires `FAILED|CANCELLED|TIMED_OUT` and creates a **fresh operation** (`operations/retry.ts:15-17, :63-100`) — the cancelled operation is never resurrected; claim on a cancelled task is fenced 410/409 (`runtime.ts:571-577`). `file_urls`/deadline unaffected.
- Legacy compat cancel path intentionally keeps `CANCEL_REQUESTED` while a live lease exists (`compat/legacy-host-adapter.ts:274-288`) — documented divergence from the old fake-terminal cancel; parity shape maintained otherwise.
- **First-hand:** full suite 15/15 incl. T26/T27 (above); cross-ref `verify-t26-t27-independent-codex-2026-10-08.md` (leg 1) and in-progress `verify-t26-t27-independent-oc2-2026-10-08.md`. No gap found in this review.

## 7. BusinessJobV1 validation / malformed payloads — PASS

- Envelope contract is **strict** and secret-free by design: `packages/contracts/src/queue.ts:12-25` (`z.object(...).strict()`, `contractVersion: z.literal('1')`, ids/uuid; comment `:3-9`: no bytes/raw prompts/provider secrets/long-lived URLs). Rejection of extra keys (`secretPrompt`) and wrong version is covered by `contracts/tests/queue.test.ts:22-37`.
- Consumer validates **before any work**: `worker.ts:95-100` `BusinessJobV1Schema.safeParse(job.data)` → on failure throws immediately ("Malformed payload: transport-level rejection, no business effect", `:96-98`); no runtime HTTP call, hence **zero SQL** on the orchestrator for a malformed queue payload.
- **HTTP 422-before-SQL (where the 422 exists):** claim route order is auth(401, no SQL) → `ClaimTaskRequestSchema.safeParse` → 422 fixed text (`http/routes/runtime.ts:374-378`) → worker-claim auth (config-only) → task-business SQL → `claimTask`. `workspace-reference` identically validates query before the runtime call (`:487-499`).
- Scope note: there is **no HTTP 422 path for the queue envelope** — jobs are produced internally by typed code (`retry.ts:93-100`, runtime spawn paths) and the dispatcher forwards the stored payload unchanged (`dispatcher.ts:60-68`); malformed payloads can only appear via queue tampering and are rejected at the consumer edge. This is fail-closed; recorded as an info note, not a gap.

## Scope limits / NOT VERIFIED (honest)

- **NOT VERIFIED:** `file_url_download`/`callback` success path against a real approved-HTTPS origin (fences only, offline run); no paid/real provider calls (loopback mock only); no browser/DOM verification.
- SQL review is targeted to the hot paths listed (runtime/claim/writes, dispatcher, connector, tenant roster); it is not an exhaustive audit of every module in the tree.
- `listOperations` timestamp-oracle observation (LOW) and oc_4's Area-1/2 findings are recorded here only where independently observed; oc_4 remains reviewer of record for the designated receipt.
- Adjacent, NOT adjudicated by this review: `fix-section8-med2-existence-oracle-2026-10-08.md` (a 404-text oracle fix on public routes) exists; it was not re-verified by this leg.
- **No gate ticks:** this receipt asserts review verdicts only — no VERIFIED/ACCEPTED, no plan edits, no OpenAPI edits.

## Raw logs

`coordination/reports/raw/wfa-section8-security-review-2026-10-08/01-worker-full.txt` (this lane; cwd/node/command + full output + `Tests: 15 passed, 15 total`, exit 0).

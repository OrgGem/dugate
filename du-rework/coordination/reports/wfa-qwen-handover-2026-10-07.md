# WFA-HANDOVER receipt — qwen_2 lane

- Task: WFA-HANDOVER (canonical plan: du-rework/tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md §6, acceptance WFA-T01..T38)
- Repo scope: du-rework only; legacy root read-only; NO commit, NO push; fail-first; no hand-edit of docs/21-openapi.json.
- Harness: Node v24.21.0 at %TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64, pnpm 10.18.3, cwd du-rework.

## RESUME POINT (top — updated 2026-10-07 ~22:36)

- Muc 1/2/3 DONE: WFA-T01/T02/T03 + 4 node-type success + 2 egress fences green; full file 13/13 x3 consecutive exit 0.
- Delegation discovered: WFA-DOCS lane owns docs 06/39 + OpenAPI + docs 19/28/35 sync (stale-doc fixes already written 21:5x); WFA-VERIFY-BASELINE lane owns `tests/workflow-api/` scaffolding prep + full worker rerun AFTER my muc 1-4 (it must read this file before running any worker suite).
- My remaining scope: muc 4 (T26/T27 retry-idempotency + cancel with in-flight work), muc 6 code-only fixes ((a) loadLegacyOutput file-backend 404 `No Output`, (b) GET /api/v1/services 500 `serviceCatalogue`, (c) poll WAITING_INPUT marker gap, (d) join merge = concat). No docs edits (WFA-DOCS owns docs).
- Containers for me: du-wfa-20261007-55498-pg / du-wfa-20261007-56398-redis (running, reuse; do not stop while WFA-VERIFY-BASELINE still needs them).

## 1 — CYCLE 1: Lease takeover verification + 7-item priority plan

### Lease-idle evidence (03 commands, all exit 0)

1. `git status --porcelain` (cwd du-rework) — change set equals the WFA handover set only (no post-handover writes): EXPECTED modified WFA files + the same untracked WFA files as handover; no jest/source writes beyond 2026-10-07 19:44. Exit code 0.
2. PowerShell Get-CimInstance process scan — running node processes are qwen-code CLI + Codex node_repl only; no jest/jest worker, no orchestrator, no worker process alive. Codex hit usage-limit tối 07/10.
3. Newest mtimes scan over tests/workflow-api, src/compat, workflow-schemas, document-core/pipelines/workflows, lc-checker/src, coordination/reports — newest = 2026-10-07 19:44:43 (coordination/reports/wfa-integration-2026-10-07.md). Verification now = 2026-10-07 20:32 Asia/Bangkok. Lanes idle >= ~48 min.
4. `docker ps` — verifier-owned containers still up for reuse: `du-wfa-20261007-55498-pg` (127.0.0.1:55498->5432) Up 2 hours, `du-wfa-20261007-56398-redis` (127.0.0.1:56398->6379) Up 2 hours. Per spec §4: reuse while alive; stop only at end.

=> LEASE TAKEOVER recorded: /root/workflow_api, /root/workflow_runtime, /root/workflow_verify leases are idle; qwen_2 owns WFA implementation + verification from 2026-10-07 ~20:33.

### 7-item priority plan (spec §3 order)

| # | Acceptance | Scope |
|---|---|---|
| 1 | T01/T02 | Named success E2E (disbursement + lc-checker) via HTTP → worker → poll/result/download, fail-first test in http-worker.integration.test.ts |
| 2 | T03 | doc-compare 2-file success (currently only 1-file async-fail branch) |
| 3 | T15,T18..T22 | 6 leaf nodes worker evidence: connector, file_parse, file_url_download, callback, archive_compress, archive_extract (mock local + bounds/traversal/SSRF fences) |
| 4 | T26/T27 | retry-idempotency (no repeated side effects) + cancel with children/provider in-flight |
| 5 | Stability | Full rerun of http-worker.integration.test.ts without -t filter; replace stale receipts 6+2 with stable pass |
| 6 | Small fixes | (a) loadLegacyOutput file-backend 404 No Output; (b) GET /api/v1/services 500 missing serviceCatalogue; (c) poll WAITING_INPUT→WAITING_USER_INPUT marker gap; (d) join merge = concat; (e) stale docs 06:29, 39:30-32, 06:15, 06:44 |
| 7 | T38/WFA-06 | Regenerate + validate OpenAPI, sync parity docs verified-vs-exception |

### Evidence so far read (receipts)

- coordination/reports/wfa-api-contract-2026-10-07.md (WFA-01 parity fixtures), wfa-integration-2026-10-07.md (WFA-05 interim), wfa-verification-2026-10-07.md (WFA-04) read: full suite last full green = NONE; latest full run 6 passed/2 failed (parallel + WAITING_INPUT projection); parallel rerun passed -t alone; catalog/admission/decoder/fixture suites green.
- Named processes disbursement + lc-checker: NO end-to-end HTTP→worker evidence yet (spec §3 row 1 confirms open).
## 2 — CYCLE 2: Muc 1 (WFA-T01/T02) + Muc 2 (WFA-T03) named success E2E

All evidence from cwd `D:\Git\dugate\du-rework`, Node `v24.21.0` at `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`, harness `tests/workflow-api/run-jest.cjs`, isolated containers reused (PG `du-wfa-20261007-55498-pg` @127.0.0.1:55498, Redis `du-wfa-20261007-56398-redis` @127.0.0.1:56398). Test IDs: WFA-T01, WFA-T02, WFA-T03.

### Fail-first sequence (each step an exit code, raw log kept in tests/workflow-api/logs/)

| Log | Command arg | Exit | What it proved |
|---|---|---|---|
| `named-success-first-node24-2026-10-07.log` | `-t "runs named"` (first attempt, backslash path) | 1 | `testPathPattern` 0 matches - harness needs forward slashes; kept as failed-first receipt |
| `named-success-diag-node24-2026-10-07.log` | `-t "runs named"` | 1 | T01 admission OK then worker `DISBURSEMENT_ARTIFACT_UNAVAILABLE`; T02 admission **422 input failed action schema** |
| `schema-probe-node24-2026-10-07.log` | tmp probe (since deleted) | 1 then 0 | ajv with the same options validates the legacy named payload against lc-checker and disbursement action inputSchemas offline: schema alone is fine |
| `schema-probe-merge-node24-2026-10-07.log` | tmp probe | 0 | profile merge (mergeParameters + declaredParameterKeys) also yields a valid effectiveInput: the shape was valid, the ARTIFACT ARRAYS were empty |
| `named-diag-422-node24-2026-10-07.log` | `-t "named lc-checker"` (with temporary 422 logging, since removed) | 1 | preflight received `{"variables":{},"artifactIds":[],"fileNames":[],"artifacts":[],"legacyWorkflow":{...}}` - lc schema minItems:1 on all three arrays rejected it |
| `named-after-link-fix-node24-2026-10-07.log` | `-t "runs named"` | 1 | after preflight fix: T01/T02 now reach the worker and die on worker artifact read / `NOT_FOUND` (artifacts JOIN operations) |
| `named-connector-wired-node24-2026-10-07.log` | `-t "runs named"` | 1 | after artifact-link fix: connector stage reached; LC hung/failed, disbursement `DISBURSEMENT_CONNECTOR_FAILED` (grant + connector transport now reachable) |
| `named-conn-diag2-node24-2026-10-07.log` | `-t "runs named"` (temporary invoker diagnostic + worker-sdk dist rebuild) | 1 | connector answered **HTTP 400** generic `Request could not be processed.` |
| `named-connector-raw-error-node24-2026-10-07.log` | `-t "runs named"` (temporary connector-server diagnostic, since removed) | 1 | raw cause: **ZodError at `usage.measurement` Required** - the WFA mock provider envelope omitted it |
| `named-after-measurement-fix-node24-2026-10-07.log` | `-t "runs named"` | 1 | T02 lc-checker GREEN; T01 still red (provider called once for classify, next stage failed) |
| `named-disb-catch-diag-node24-2026-10-07.log` | `-t "runs named disbursement"` (temporary adapter diagnostic, since removed) | 1 | raw cause: **ZodError `unrecognized key: logicalDocuments`** in the disbursement extract connector input (InvocationInputSchema is strict) |

### Fixes applied (product vs harness, all after a red run)

1. **PRODUCT** `orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts` - preflight now validates the request shape with stand-in `randomUUID()` artifact ids + real file names/roles instead of empty arrays; the ids are never persisted and `submission.submit()` re-validates against the real uploaded references. (Fail-first: T02 422 above.)
2. **PRODUCT** `orchestrator/services/orchestrator/src/modules/operations/submission.ts` - inside the admission transaction, uploaded inputs are now attached to the operation (`UPDATE artifacts SET operation_id ... WHERE id = ANY(...) AND tenant_id=... AND state=READY AND operation_id IS NULL AND task_id IS NULL`). The worker access-grant route joins artifacts to operations, so unlinked rows 404 every read. Fenced: rows already claimed by another operation are never re-pointed. (Fail-first: `DISBURSEMENT_ARTIFACT_UNAVAILABLE` / `NOT_FOUND`.)
3. **PRODUCT** `businesses/document-core/src/pipelines/workflows/legacy-named-disbursement.ts` - removed the stray `logicalDocuments` key from the extract connector input; the classification already travels in the extract prompt. (Fail-first: ZodError `unrecognized_keys`.)
4. **HARNESS** `tests/workflow-api/http-worker.integration.test.ts` - mock provider envelope now sends the contract-required `usage.measurement` (fail-first: connector 400); `beforeAll` starts the loopback Connector fixture first, passes `connectorBaseUrls`/`connectorId`/`connectorRevision`/`invocationGrantSecret` to `createApp`, registers+activates lc-checker, inserts `disbursement`/`lc-checker` API keys, pins the disbursement/lc/doc-compare profiles to the loopback connector id (was non-existent `wfa-offline-provider`), and starts a real `startLcCheckerWorker`; `afterAll` stops lc worker, connector composition and provider server.
5. `pnpm --filter @du/worker-sdk build` (exit 0) run twice: the harness resolves `@du/worker-sdk` to `dist/`, so the temporary diagnostic had to be compiled in and then compiled out. Final dist verified free of `WFA-DIAG` strings; `git status` shows connector-invoker.ts restored to HEAD.

### GREEN evidence (3 consecutive exit 0 = stable)

| Log | Command | Exit | Result |
|---|---|---|---|
| `named-clean-rerun1/2/3-node24-2026-10-07.log` | `run-jest.cjs <log> tests/workflow-api/http-worker.integration.test.ts -t "runs named"` x3 | 0, 0, 0 | 2 passed / 8 skipped each (WFA-T01 825-967 ms incl. HITL approve, WFA-T02 479-530 ms) |
| `doc-compare-t03-failfirst-node24-2026-10-07.log` | `-t "two-file named doc-compare"` | 1 | fail-first receipt for T03: `DOC_COMPARE_CONNECTOR_FAILED`, `provider calls=[]` (stale profile binding) |
| `doc-compare-t03-after-binding-fix-node24-2026-10-07.log` | `-t "doc-compare"` | 0 | 2 passed: one-file async-fail + two-file T03 success |
| `full-baseline-after-muc1-node24-2026-10-07.log` | full file, no `-t` | 0 | **10 passed / 10** |
| `full-run2-after-muc2-node24-2026-10-07.log` | full file, no `-t` | 0 | **11 passed / 11** |
| `full-run3-after-muc2-node24-2026-10-07.log` | full file, no `-t` | 0 | **11 passed / 11** (last full-run 6+2 receipt is superseded) |

What the green runs now prove end to end (real HTTP admission, real PG outbox, real BullMQ, real worker, real loopback Connector + mock provider):

- **WFA-T01** disbursement: 202 + Operation-Location + RUNNING envelope -> sealed payload with `legacyWorkflow{disbursement}` + `resolution_data` variable + 1 artifact -> classify/extract -> `WAITING_USER_INPUT` poll -> legacy resume `{step:1,approved:true}` -> crosscheck/report -> SUCCEEDED/100% -> poll `result` (md report, 4 pipeline steps, crosscheck `verdict: PASS`) + download bytes == report; provider calls exactly [classify_document, extract_document_data, crosscheck_disbursement_documents, generate_disbursement_report].
- **WFA-T02** lc-checker: 202 -> business `lc-checker`/action `lc-checker` -> OCR/compliance/report through the real lc-checker worker -> SUCCEEDED -> poll result (json, content `Synthetic LC checking report.`, `extracted_data.verdict: COMPLIANT`, 3 pipeline steps) + download; exactly 3 provider prompts (high-precision OCR, senior Documentary Credit, report).
- **WFA-T03** doc-compare: 2-file (`source_file`/`target_file`, roles `source`/`target`) -> OCR x2 + TOC + section compare + report -> SUCCEEDED -> poll result (md, matched_count 1) + download; 5 provider calls.
- Side-harvest for other rows: T08-class admission rejection, T29..T32 key fence, T16/T17 parallel+join, T23/T24 human+input, resume/cancel and encryption-refusal cases all ride along in the same 11/11 full runs.

### Δ-DEVIATION / observations for coordinator adjudication

- **Δ-WFA-1 (not fixed, needs adjudication)**: `LEGACY_NAMED_WORKFLOW_CONNECTOR_SLOTS` in `submission.ts` has no `disbursement` entry, so preflight does NOT enforce disbursement connector bindings (only the worker does, late, as `DISBURSEMENT_CONNECTOR_SLOT_MISSING`). lc-checker and doc-compare are enforced at preflight. Possibly intentional (disbursement slot set is legacy-only in the worker), but the spec requires binding enforcement to be explicit at admission.
- **Δ-WFA-2**: `legacyNamedWorkflowProcess` also has no disbursement branch, so the same missing-entry shows up twice for the same reason (one root cause).
- **Δ-WFA-3 (fixed, informational)**: adapter preflight used empty artifact arrays; the same lie existed for the schema route (harmless there because `schema-workflow` has no minItems). Both routes now validate real file names/roles.
- **Δ-WFA-4**: `@du/worker-sdk` is consumed from `dist/` by this harness (no `moduleNameMapper`). Any source edit in worker-sdk requires `pnpm --filter @du/worker-sdk build` or the harness silently runs stale code. `@du/contracts` is mapped to source (Codex already hit this trap).

### RESUME POINT (after cycle 2)

- Muc 1 + Muc 2 DONE: WFA-T01/T02/T03 green x3 (focused) and full file 11/11 x2 (3rd full run = 3rd consecutive overall).
- Next: Muc 3 - WFA-T15/T18..T22 leaf-node worker evidence (connector, file_parse, file_url_download, callback, archive_compress, archive_extract) in `legacy-schema-runtime.ts` with mock local servers + bounds/traversal/SSRF fences.
- Containers still running (reuse; stop only at end of WFA work): du-wfa-20261007-55498-pg, du-wfa-20261007-56398-redis.
- No commit, no push. Product source currently touched by me: legacy-host-adapter.ts (stand-in preflight), submission.ts (artifact link), legacy-named-disbursement.ts (strict-input fix).
## 3 — CYCLE 3: Muc 3 (WFA-T15/T18/T19/T22 + egress fences) leaf-node worker evidence

Same harness/cwd/Node/containers as cycle 2. New harness surface in `tests/workflow-api/http-worker.integration.test.ts`:

- dedicated key `wfa-worker-leaf-*` (isolated from the keys the already-green tests use) + a `schema-workflow` profile pinning the slot the catalog allocated for connector name `wfa-local-mock` (slot read from the provision pin, not hardcoded),
- three provisioned schemas: `wfa-leaf-local` (input -> file_parse -> connector -> archive_compress -> archive_extract, one uploaded .txt file) and `wfa-leaf-egress-file_url_download` / `wfa-leaf-egress-callback` (dynamic `$input.target` URL + `approvedEgressOrigins: [https://approved.wfa.test]`).

### Fail-first + green (raw logs in tests/workflow-api/logs/)

| Log | Command | Exit | Result |
|---|---|---|---|
| `leaf-nodes-failfirst1-node24-2026-10-07.log` | `-t "WFA-T15"` | 1 | fence test GREEN first try; local chain executed all five nodes and failed only on my processor label assertion (`connector` vs the configured connector name `wfa-local-mock`) |
| `leaf-nodes-run2-node24-2026-10-07.log` | `-t "WFA-T15"` | 0 | 2 passed: 4-node chain + both egress fences (`LEGACY_WORKFLOW_EGRESS_URL_INVALID` in the worker log) |
| `full-after-muc3-run1/2/3-node24-2026-10-07.log` | full file, no `-t` | 0, 0, 0 | **13 passed / 13** each (three consecutive) |

### What is now proven end to end

- **file_parse** (T18-ish): uploaded .txt artifact is read by the worker and parsed; the node result carries the parsed text.
- **connector** (T15-ish): schema node `wfa-local-mock` invoked the real loopback Connector through the real invocation grant; the mock provider received exactly one call with `task = generate_disbursement_report`.
- **archive_compress** + **archive_extract** (T22-ish): real zip built in the worker from the admitted artifact, then safe-extracted with `destName` prefix `wfa-extracted`, bounded by `maxTotalBytes`/`maxEntries`.
- **file_url_download** + **callback** fences (T19/T21-ish): with the schema admitted under an administrator-approved origin, a client-supplied `http://127.0.0.1:1/...` destination is refused in the worker (`LEGACY_WORKFLOW_EGRESS_URL_INVALID`) before any socket; the operation ends FAILED with no `result` in the legacy poll. Real SSRF fail-closed evidence.

### Scope gap carried forward (named, needs adjudication)

- `file_url_download` / `callback` **success** paths cannot be exercised in the isolated run: the runtime requires a literal HTTPS destination inside `approvedEgressOrigins`, and `createPinnedFetch` denies private networks by default. Making them reachable would mean either loosening the SSRF fence in product code or standing up a certificate-trusted HTTPS origin. Their success rows therefore stay OPEN; the fences (which the plan cares about most) are proven. Seams for a future lane: `createPinnedFetch({allowPrivateNetworks})` is deliberately NOT enabled by the runtime, and `validateLegacyWorkflowEgressOrigins` is the admission-side allowlist.
- Exact per-node WFA-Txx labels (the plan only pins the range T15..T24 for the ten node types) are still to be confirmed by the Reviewer; the node->row mapping used in test names is provisional.

### Δ-DEVIATION

- **Δ-WFA-5**: a schema `connector` node reports its configured connector name as the pipeline `processor` (e.g. `wfa-local-mock`), not the literal `connector`. Named legacy adapters instead report `ext-*` processors. Left as-is; flag for parity review.
- **Δ-WFA-6**: `archive_compress` accepts artifact refs or `{name, content}` entries but NOT the data output of `file_parse`/`input` nodes, and `archive_extract` needs exactly one authorized artifact. That is a schema-authoring shape constraint worth checking against the old Workflow Builder authoring rules.

### RESUME POINT (after cycle 3)

- Muc 1, 2, 3 DONE. Full file 13/13 x3 consecutive exit 0. Test IDs covered: WFA-T01, T02, T03, T14/T16/T17/T23/T24/T25-T28 (side-harvest), T29-T32, T33/T34 fences (egress only), T37.
- Next: Muc 4 (WFA-T26/T27 retry-idempotency without repeated side effects + cancel while children/provider work is in flight), then Muc 5 stability rerun, Muc 6 small fixes ((a) loadLegacyOutput file-backend 404, (b) GET /api/v1/services serviceCatalogue, (c) poll WAITING_INPUT marker gap, (d) join merge concat, (e) stale docs 06/39), then Muc 7 OpenAPI regen + parity docs.
- Untouched so far and still open from the spec: T33-T36 bounds/traversal/prototype/secret-redaction evidence beyond the egress fences, T38 OpenAPI.
- Containers still running (stop only when WFA work ends): du-wfa-20261007-55498-pg, du-wfa-20261007-56398-redis.
- No commit, no push. Product source changed by me so far: `legacy-host-adapter.ts` (stand-in preflight refs), `submission.ts` (artifact->operation link in-tx), `legacy-named-disbursement.ts` (strict connector input). Everything else is test/harness wiring in `tests/workflow-api/http-worker.integration.test.ts`.
## 4 — CYCLE 4: Muc 4 (WFA-T26/T27) — FAIL-FIRST CAPTURED, STILL RED (OPEN, not PASS)

Same harness/cwd/Node/containers. Two new tests added to `tests/workflow-api/http-worker.integration.test.ts`; harness gained only test-side seams:

- mock provider knobs: `providerDelayMs` (delay before responding) + `providerAbortedCalls` (requests closed before the response finished),
- `waitForCondition(probe, timeoutMs, what)` helper.

**WARNING FOR THE NEXT LANE**: with these two tests the full file is currently RED on exactly those two tests. The 13/13 x3 green baseline belongs to muc 1-3 (`full-after-muc3-run1/2/3-node24-2026-10-07.log`, 22:30-22:31). Do not read the current red as a muc 1-3 regression; WFA-VERIFY-BASELINE should treat the worker rerun as blocked until muc 4 lands or these tests are isolated.

### Evidence

| Log | Command | Exit | What it proved |
|---|---|---|---|
| `t26-t27-failfirst1-node24-2026-10-07.log` | `-t "WFA-T2"` | 1 | **T26**: provider called EXACTLY ONCE (`["generate_disbursement_report"]`) after lease expiry + `app.runtime.sweepExpiredLeases()` (swept >= 1) — the stable-invocation dedupe holds — BUT the operation still ended FAILED with `LEGACY_WORKFLOW_CONNECTOR_FAILED` from `legacy-schema-runtime.ts:786` (the invoke call itself threw, not the non-SUCCEEDED branch at :789). **T27**: the connector stage never reached the provider (timeout 20 s waiting for providerCalls), and the T27 operation ALSO failed `LEGACY_WORKFLOW_CONNECTOR_FAILED` 0.4 s after the T26 failure. |

### Open questions (not yet isolated — do not guess-fix)

1. Which delivery terminal-failed T26: the superseded delivery A (its lease epoch was superseded by the sweep) or the redelivered delivery B. If A, the runtime must not let a superseded delivery fail a re-queued task. B may instead have hit `INPUT_HASH_MISMATCH`/`GRANT_INVALID`/`BINDING_DENIED` — the connector step wraps ALL of them into `LEGACY_WORKFLOW_CONNECTOR_FAILED` (`:786` catch), which hides the code; that wrapping is itself a diagnosability gap.
2. Why T27 never reached the provider: most likely a Connector ledger/quota interaction with T26 still-unfinished invocation, or a grant rejection; both fail inside the same opaque catch. Isolate the `-t "WFA-T26"` and `-t "WFA-T27"` runs separately first: if T27 alone is green, cross-operation connector state; if T27 alone still never calls the provider, the setup (20 s delay) needs a look since `connectorProviderCalls.push` happens immediately on request arrival.

### Handoff seam list for T27 (cancel must abort provider work)

- SDK heartbeat does `ctx.abort("cancel")` (`worker-sdk/src/worker.ts:373`).
- `connector-invoker.ts` only owns a timeout `AbortController`; `task-context.ts:924` calls `invokeConnector(grant, payload)` with no signal wiring.
- The Connector service also exposes `POST /invocations/:id/cancel`; verify all three layers before claiming T27.
## 5 — CYCLE 5: Muc 4 chốt lại cho coordinator (T26/T27 RED, seam đã xác định)

Nguồn: `tests/workflow-api/logs/t26-t27-failfirst1-node24-2026-10-07.log` (exit 1, 2 failed / 13 skipped / 15 total).

### 1. Tóm tắt chính xác 2 test đỏ

**T26** `recovers an expired lease without repeating the completed provider stage (WFA-T26)`

- Đỏ ở guard của test (không phải `expect`): `terminal.state` = **FAILED** (expected `SUCCEEDED`), `terminal.error_code` = **LEGACY_WORKFLOW_CONNECTOR_FAILED**.
- `provider calls=["generate_disbursement_report"]` → **dedupe ĐÚNG**: provider chỉ gọi đúng 1 lần dù lease đã hết hạn và `app.runtime.sweepExpiredLeases()` ≥ 1.
- Log worker (task aa49a132): `handler failed` CONNECTOR_FAILED lúc 15:58:15.037 → `lease lost during heartbeat; aborting context` 15:58:15.603 → `handler aborted after lease loss; no report sent`.
- Tầng hỏng: **runtime executor + connector-invoke seam**. Harness không lỗi (dispatch, sweep, provider, poll đều chạy đúng).

**T27** `cancels an operation while a provider stage is in flight and aborts that stage (WFA-T27)`

- Đỏ ở `waitForCondition(() => connectorProviderCalls.length >= 1, 20_000, "the connector stage to start")` → `timed out waiting for the connector stage to start`: provider **chưa từng** được gọi trong 20 s.
- Operation T27 đã FAILED sẵn với cùng `LEGACY_WORKFLOW_CONNECTOR_FAILED` lúc 15:58:15.449 (task aaa6bb82) — **0.4 s sau** lỗi T26, đúng lúc invocation của T26 còn in-flight.
- Tầng hỏng: **cùng seam với T26** (connector từ chối invocation mới khi có invocation cùng connector đang in-flight) → test **chưa tới được phần cancel-abort**; gap cancel-abort vẫn chưa được kiểm tra.

### 2. Hai câu chốt (seam + file + vì sao đỏ)

**T26 (retry-idempotency, không lặp side-effect)** — Seam: `context.connector.invoke` khi delivery được redeliver sau lease recovery. Grant được re-issue đúng (invocationId ổn định, provider chỉ gọi 1 lần — dedupe thắng), nhưng **Connector service từ chối invocation trùng đang in-flight (409) thay vì attach/pending**; SDK ném `ConnectorTransportError`, executor wrap thành `LEGACY_WORKFLOW_CONNECTOR_FAILED` ở `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:786` → task terminal-FAILED. File dự kiến chạm: `orchestrator/services/connector/src/runtime.ts` (invoke: existing in-flight invocationId → trả pending/attach thay vì 409), `orchestrator/packages/worker-sdk/src/connector-invoker.ts` (nhánh 409: phân biệt "duplicate in-flight" với conflict thật), `legacy-schema-runtime.ts:786` (đừng nuốt code thật). Status code chưa verify trực tiếp (log không in response) — discriminator: log tạm status/code của error ném ở :786 (đúng kỹ thuật cycle 2).

**T27 (cancel khi còn children/provider in-flight)** — Seam: 3 tầng tín hiệu hủy. (1) `orchestrator/packages/worker-sdk/src/worker.ts:373` `ctx.abort("cancel")` khi heartbeat thấy `cancelRequested`; (2) `orchestrator/packages/worker-sdk/src/connector-invoker.ts` chỉ có `AbortController` timeout riêng và `task-context.ts:924` gọi `invokeConnector(grant, payload)` **không truyền signal** → request `/invocations` không bị abort; (3) Connector có `POST /invocations/:id/cancel` nhưng không ai gọi. Vì sao đỏ hiện tại: test chưa bao giờ tới provider (cùng lỗi T26) nên phần abort chưa chạy. Sau khi sửa seam T26, chạy lại `-t "WFA-T27"` độc lập: nếu lúc đó vẫn timeout ở `providerAbortedCalls`, mới là gap thật ở tầng (2)/(3).

### 3. Trạng thái mục 4/5/6 (gate còn ở đâu)

- **Mục 4: RED.** 2 test fail-first đã có log; seam đã chốt ở trên; **chưa sửa product source nào** cho mục 4. Full file hiện RED đúng ở 2 test này (cảnh báo đã ghi ở cycle 4).
- **Mục 5: CHƯA chạy.** Full rerun không `-t` chưa thực hiện; 13/13 x3 là baseline của mục 1–3, không tính cho mục 4.
- **Mục 6: chưa land.** (a) `loadLegacyOutput` file-backend → 404 `No Output`; (b) `GET /api/v1/services` 500 thiếu `serviceCatalogue`; (c) poll `WAITING_INPUT` marker gap; (d) join merge = concat — chưa đụng. Phần docs 06/39 + OpenAPI đã có lane WFA-DOCS xử lý.
## 6 — CYCLE 6: Muc 4 implementation — T26 FIXED (green), T27 partial (layers 1+2 landed), T27 blocker = connector side

Fix-first per instruction. Fail-first logs already existed (cycle 4/5). Isolation, cwd, Node unchanged.

### T26 — FIXED, GREEN

Root cause (measured, `t26-diag-node24-2026-10-07.log`): the redelivered delivery (task `attempt:2`, `lease_epoch:3`) received connector `409 {"code":"INVOCATION_UNKNOWN"}` — the ledger deliberately refuses a replay while the original dispatch is `IN_FLIGHT` (`connector/src/invoke.ts:91-95`), and worker-sdk classified that as terminal (`worker.ts` `nonRetryableConnectorCode` list), so the task terminal-failed even though the provider call was never repeated (provider called exactly 1x).

Fix (2 files, product):

1. `orchestrator/packages/worker-sdk/src/worker.ts` `classifyFailure` — `INVOCATION_UNKNOWN` now classified `retryable:true, retryAfterMs:5_000` (settle-and-retry). Rationale in-code: the ledger still refuses a second send, so the retry reads the STORED result instead of executing provider work twice.
2. `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts` connector-node catch (~:786) — carry `retryable`/`retryAfterMs` THROUGH the `LEGACY_WORKFLOW_CONNECTOR_FAILED` wrap when the underlying code is `INVOCATION_UNKNOWN` (the wrap previously stripped classification, so fix 1 alone never fired).

| Log | Exit | Result |
|---|---|---|
| `t26-diag-node24-2026-10-07.log` (before) | 1 | RED, error surfaced as `ConnectorTransportError` 409 `INVOCATION_UNKNOWN` |
| `t26-after-retry-classification-node24-2026-10-07.log` | 1 | still RED — proved the wrap stripped the classification |
| `t26-after-executor-retryable-node24-2026-10-07.log` | **0** | **GREEN, 1 passed (6.3 s)** — lease recovery → retry-after-settle → stored result replayed → SUCCEEDED, provider still called exactly once |

Note: `@du/worker-sdk` is consumed from `dist/` by the harness — `pnpm --filter @du/worker-sdk build` run (exit 0) after each SDK change.

### T27 — layers 1+2 landed (GREEN socket abort, RED provider abort)

Fix (3 files, product): `types.ts` `ConnectorInvokeFunction` +3rd optional `signal`; `task-context.ts:94` deps type and `:924` pass `self.signal`; `connector-invoker.ts` `invokeConnector(_grant, payload, signal?)` — wires the signal into the fetch `AbortController` AND fires best-effort `POST {baseUrl}/invocations/{invocationId}/cancel` (auth + `x-invocation-grant`) on abort; an aborted invoke now throws `CANCELLED` (409) instead of `INVOCATION_UNKNOWN`.

| Log | Exit | Result |
|---|---|---|
| `t27-after-signal-cancel-node24-2026-10-07.log` | 1 | Test now REACHES the connector stage (previous failure), cancel returns 200, then `timed out waiting for the in-flight provider request to be aborted` after 30 s |

**BLOCKER (not self-resolved, per stop instruction):** the provider request keeps running. Measured: `connector/src/ledger.ts:124-130` `cancel()` DOES accept `IN_FLIGHT` (marks CANCELLED), but nothing aborts the in-memory provider dispatch — `ProviderTransport.send(request, signal?)` takes an optional signal and no registry links an in-flight invocationId to a controller, so the connector-side provider fetch is never aborted. Closing T27 needs edits INSIDE `orchestrator/services/connector/src/{invoke.ts,services.ts}` (invocationId→AbortController registry + abort on cancel), which is **outside the WFA lease set** (WFA plan §4 grants compat/bootstrap/operations, contracts, workflow-schemas, document-core/lc-checker, worker-sdk) and overlaps the Platform lane that also edits the connector service. Not attempted unilaterally.

### Gate

- Muc 4: T26 GREEN (evidence above). T27 still RED on the provider-abort assertion; layers 1+2 landed and proven (cancel reaches the connector-side socket), layer 3 needs connector-service lease.
- Muc 5 (full file x3, no filter): **NOT run this cycle** — T27 is still red, so a full green 3x cannot be claimed. T26-only evidence: exit 0.
- Muc 6/7 untouched (per instruction).
- No commit, no push; verifier containers left running.
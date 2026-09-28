Model: gpt-6-luna max; cwd: D:/Git/dugate.

This is the new ChatGPT Codex agent for W42-CX2. It is NOT the previous "Ra soat va chinh plan" session.

## W47-C2X2 - declaration-line citation correction

- Packet audit time: `2026-09-24T22:24:15+07:00` (the actual timestamp of the grep execution; the same time is recorded above its output).
- Purpose: correct every W47-C2X1 test citation to the physical line containing the `test(` declaration, and preserve the exact declared test name. This supersedes W47-C2X1's range citations for these test cases.
- The grep output below shows declarations only. `black-box-durable.test.ts` has exactly three test declarations at lines 179, 236, and 306; lines 157 and 288 are not test declarations. No CON row is assigned to either line.

### Command and complete grep output

Command run from `D:\Git\dugate\du-rework`:

```powershell
$files=@('services/connector/tests/p8-03-convergence.test.ts','services/connector/tests/runtime-foundations.test.ts','services/connector/tests/durable-integration.test.ts','services/connector/tests/black-box-durable.test.ts','services/connector/tests/connector.test.ts','services/connector/tests/security-lifecycle.test.ts'); foreach($f in $files){ "### $f"; rg -n '^\s*(test|it)\s*\(' $f }
```

Grep executed at `2026-09-24T22:24:15+07:00`; output:

```text
### services/connector/tests/p8-03-convergence.test.ts
56:    test('normalizes JSON adapter request with canonical payload and headers', () => {
73:    test('normalizes multipart adapter request with FormData container', () => {
84:    test('fail-closed SSRF fence rejects private IP, IPv6 loopback, and file URIs', async () => {
92:    test('adapter maps provider response into normalized output and token usage', () => {
127:    test('identical request replays cached result without duplicate transport dispatch', async () => {
161:    test('replaying same invocation ID with altered input fails with 409 INPUT_HASH_MISMATCH', async () => {
192:    test('hash calculation is invariant to JSON property ordering', () => {
209:    test('strictly enforces in-flight cap and rejects excess with 429 QUOTA_EXHAUSTED', async () => {
230:    test('multi-replica quota sharing respects aggregate in-flight ceiling', async () => {
277:    test('encrypts credentials at rest and decrypts with authenticated tag verification', () =>
294:    test('secret rotation allows new key version while revoking obsolete version', async () =>
311:    test('grant verification binds identity, inputHash, and rejects tampered or expired claims', async () =>
360:    test('transport disconnect after send records UNKNOWN state and prevents blind retries', async () =>
405:    test('provider timeout exceeding budget records UNKNOWN state', async () =>
429:    test('clean classification of standard HTTP failure taxonomy', () =>
442:    test('appendUsageEvent derives deterministic SHA-256 eventId per invocation and attempt', () =>
471:    test('validates UsageIngestBatchSchema rejecting negative tokens and float micro-USD', () =>
503:    test('HttpUsageSink transmits single debit event with bearer auth and idempotency-key', async () =>
543:    test('outbox dispatcher retries on transient sink failure and acknowledges once delivered', async () =>
580:    test('poison events are safely parked after retry exhaustion without dropping valid events', async () =>
600:    test('late usage arriving after timeout is safely appended to outbox and delivered', async () =>
630:    test('live usage_events projection aggregates provider tokens and costs with zero double-billing on duplicate events', async () =>
### services/connector/tests/runtime-foundations.test.ts
33:test('Redis quota is shared by two store instances through atomic eval boundary', async () =>
44:test('management revision redacts all configured provider headers', () =>
64:test('HTTP shell exposes health, redacted management, and write-only rotation', async () =>
110:test('HTTP invocation reads and cancellation forward the invocation grant header', async () =>
158:test('usage outbox replays after delivery fault without duplicating event IDs', async () =>
### services/connector/tests/durable-integration.test.ts
17:  test('migrates empty database and recognizes applied version', async () =>
23:  test('two connector quota instances share Redis in-flight cap', async () =>
### services/connector/tests/black-box-durable.test.ts
179:  test('invokes over HTTP, redacts management output, and replays after restart', async () =>
236:  test('reclaims a claimed due poll after connector restart and fences the stale poller', async () =>
306:  test('holds a shared credential quota lease across a pending cross-tenant invocation', async () =>
### services/connector/tests/connector.test.ts
33:  test('canonical input hash is stable despite object key order', () =>
38:  test('ledger replays same request and rejects a different hash', async () =>
46:  test('quota enforces the aggregate in-flight cap', async () =>
55:  test('grant binds identity, hash, audience, and expiry', async () =>
71:  test('json and multipart adapters map without arbitrary endpoint overrides', () =>
87:  test('usage event IDs are deterministic for duplicate delivery', () =>
92:  test('request mappings never allow arbitrary provider endpoint or header overrides', () =>
100:  test('HTTP 202 requires explicit provider idempotency replay opt-in', async () =>
118:  test('pending replay waits until nextPollAt, then polls with the same provider idempotency key', async () =>
198:  test('pending replay at deadline fails without another provider dispatch', async () =>
228:  test('concurrent due PENDING replay claims only one provider poll', async () =>
265:  test('expired poll lease is recovered and a stale poller cannot replace its result', async () =>
317:  test('quota lease store failure returns due invocation to retryable PENDING', async () =>
356:  test('Postgres pending poll claim is a due-state compare-and-set scoped to the input hash', async () =>
380:  test('pending replay terminalization is fenced to the same hash and PENDING state', async () =>
399:  test('concurrent IN_FLIGHT replay never dispatches the provider twice', async () =>
429:  test('provider response loss is recorded as UNKNOWN and never silently retried', async () =>
### services/connector/tests/security-lifecycle.test.ts
39:test('rejects tampered, expired, and input-mismatched grants without exposing token', async () =>
61:test('provider timeout records UNKNOWN and credential revoke blocks the next replay', async () =>
84:test('lifecycle drains before closing dependencies and rejects new work through state', async () =>
```

### Corrected CON-01..05 map

1. **CON-01 - covered by declarations:** `p8-03-convergence.test.ts:56` `normalizes JSON adapter request with canonical payload and headers`; `:73` `normalizes multipart adapter request with FormData container`; `:84` `fail-closed SSRF fence rejects private IP, IPv6 loopback, and file URIs`; `:92` `adapter maps provider response into normalized output and token usage`.
2. **CON-02 - covered by declarations:** `p8-03-convergence.test.ts:127` `identical request replays cached result without duplicate transport dispatch`; `:161` `replaying same invocation ID with altered input fails with 409 INPUT_HASH_MISMATCH`; `:192` `hash calculation is invariant to JSON property ordering`; durable same-payload replay is `black-box-durable.test.ts:179` `invokes over HTTP, redacts management output, and replays after restart`. **NO CASE** for changed-payload/same-ID collision after restart against the durable Postgres ledger.
3. **CON-03 - covered by declarations:** `p8-03-convergence.test.ts:209` `strictly enforces in-flight cap and rejects excess with 429 QUOTA_EXHAUSTED`; `:230` `multi-replica quota sharing respects aggregate in-flight ceiling`; `runtime-foundations.test.ts:33` `Redis quota is shared by two store instances through atomic eval boundary` (FakeRedis); `durable-integration.test.ts:23` `two connector quota instances share Redis in-flight cap` (integration-gated); `black-box-durable.test.ts:306` `holds a shared credential quota lease across a pending cross-tenant invocation` (live cross-tenant quota lease, not two-replica Redis).
4. **CON-04 - primitive/stub cases only:** `p8-03-convergence.test.ts:277` `encrypts credentials at rest and decrypts with authenticated tag verification`; `:294` `secret rotation allows new key version while revoking obsolete version`; `:311` `grant verification binds identity, inputHash, and rejects tampered or expired claims`; `runtime-foundations.test.ts:64` `HTTP shell exposes health, redacted management, and write-only rotation` (stub callback). **NO CASE** for repository-backed credential rotation/no-downtime behavior while an invocation uses the stored credential. These exact declarations answer the mapping; a nearby body line such as `black-box-durable.test.ts:157` is not a rotation test.
5. **CON-05 - covered by declarations:** `p8-03-convergence.test.ts:360` `transport disconnect after send records UNKNOWN state and prevents blind retries`; `:405` `provider timeout exceeding budget records UNKNOWN state`; `:429` `clean classification of standard HTTP failure taxonomy`; `connector.test.ts:429` `provider response loss is recorded as UNKNOWN and never silently retried`; `security-lifecycle.test.ts:61` `provider timeout records UNKNOWN and credential revoke blocks the next replay`; `black-box-durable.test.ts:236` `reclaims a claimed due poll after connector restart and fences the stale poller` (PENDING recovery/stale-poller fencing). **NO CASE** for a durable provider-side-effect/response-loss UNKNOWN reconciliation across connector restart; the exact live declaration at :236 is pending-poll recovery. A body line such as `black-box-durable.test.ts:288` is not a test declaration.

All five CON IDs have at least one exact declared test mapped above; the two **NO CASE** notes identify uncovered sub-scenarios, not a claim that nearby tests prove them. No source, test, or task file was edited and no task status was changed.

### Citation consistency recheck

- Actual time: `2026-09-24T22:53:32+07:00`.
- Read-only PowerShell check loaded each of the 23 file:line/name tuples above; at each line it required both a `test(`/`it(` declaration prefix and the exact expected test-name literal.
- Result: `DECLARATIONS_CHECKED=23`, `FAILURES=0`.
- Direct disputed-line checks in `black-box-durable.test.ts`: line 157 is `await repository.put(credentialRef, new AesCredentialCipher(encryptionKey).encrypt('provider-secret'));` and line 288 is `)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });`; both returned `DECLARATION=False`.

# W47-C2X1 - P8-03 Connector CON-01..05 coverage audit

Scope: audit existing tests under `services/connector/tests`; USE-01/02 evidence is the separately accepted W46-A6-6 live receipt. P8-03 stays `[~]`; no task row was changed.

## CON cases in order

1. **CON-01 - standardized adapter facade / SSRF / normalized response**
   - `services/connector/tests/p8-03-convergence.test.ts:56`: `normalizes JSON adapter request with canonical payload and headers`.
   - `:73`: `normalizes multipart adapter request with FormData container`.
   - `:84`: `fail-closed SSRF fence rejects private IP, IPv6 loopback, and file URIs`.
   - `:92`: `adapter maps provider response into normalized output and token usage`.
   - These cases directly assert JSON and multipart request forms, URL denials, normalized content, and token/cost usage.

2. **CON-02 - invocation idempotency / dedup collision guard**
   - `p8-03-convergence.test.ts:127`: `identical request replays cached result without duplicate transport dispatch` (transport call count stays 1).
   - `:161`: `replaying same invocation ID with altered input fails with 409 INPUT_HASH_MISMATCH`.
   - `:192`: `hash calculation is invariant to JSON property ordering`.
   - Durable same-payload replay after service restart also has a live case at `services/connector/tests/black-box-durable.test.ts:179`, `invokes over HTTP, redacts management output, and replays after restart`; it proves one provider call/stable result for that replay.
   - **NO CASE** proves that a changed-payload/same-invocation-ID collision is rejected after restart against the durable Postgres ledger. The changed-payload case above uses the in-memory convergence fixture; the durable black-box case replays the same payload.

3. **CON-03 - in-flight cap / shared quota leases**
   - `p8-03-convergence.test.ts:209`: `strictly enforces in-flight cap and rejects excess with 429 QUOTA_EXHAUSTED`; this uses `InMemoryQuotaStore`.
   - `:230`: `multi-replica quota sharing respects aggregate in-flight ceiling`; the two replica wrappers share a `Map`, so this is a synthetic shared-store case, not a Redis test.
   - `runtime-foundations.test.ts:33`, `Redis quota is shared by two store instances through atomic eval boundary`, uses `FakeRedis`, not a real Redis instance.
   - The real Redis case exists at `services/connector/tests/durable-integration.test.ts:23`, `two connector quota instances share Redis in-flight cap`, but the file gates it behind `CONNECTOR_INTEGRATION=1` at `:3-4`; the requested default/offline run leaves that suite skipped. `black-box-durable.test.ts:306`, `holds a shared credential quota lease across a pending cross-tenant invocation`, is a live cross-tenant pending-lease case, but not a two-replica Redis proof.

4. **CON-04 - credential cipher / secret rotation / grant claims**
   - `p8-03-convergence.test.ts:277`: `encrypts credentials at rest and decrypts with authenticated tag verification` (tampered ciphertext is rejected).
   - `:294`: `secret rotation allows new key version while revoking obsolete version`; it compares two cipher instances and confirms the v2 cipher rejects v1 ciphertext.
   - `:311`: `grant verification binds identity, inputHash, and rejects tampered or expired claims`.
   - `runtime-foundations.test.ts:64`, `HTTP shell exposes health, redacted management, and write-only rotation`, verifies the route sends a new secret to a stubbed `rotateCredential` callback and returns 204; the callback is not backed by the connector repository.
   - **NO CASE** in `services/connector/tests` exercises repository-backed credential rotation/no-downtime behavior across a real stored credential and an invocation during rotation. The primitive cipher test and stubbed route do not establish that behavior.

5. **CON-05 - UNKNOWN fault taxonomy / blind-retry prevention**
   - `p8-03-convergence.test.ts:360`: `transport disconnect after send records UNKNOWN state and prevents blind retries`; asserts `safeToRetry: false`, in-memory ledger state UNKNOWN, and no second transport dispatch.
   - `:405`: `provider timeout exceeding budget records UNKNOWN state`.
   - `:429`: `clean classification of standard HTTP failure taxonomy` for 429, 503, 500, 400, and connection-reset errors.
   - Additional exact cases: `connector.test.ts:429`, `provider response loss is recorded as UNKNOWN and never silently retried`; `security-lifecycle.test.ts:61`, `provider timeout records UNKNOWN and credential revoke blocks the next replay`; and gated live `black-box-durable.test.ts:236`, `reclaims a claimed due poll after connector restart and fences the stale poller` (PENDING poll recovery/stale-fence behavior).

## USE evidence and run request

W46-A6-6 records the two live USE-01/02 suites as **1/1 each, ExitCode 0, 0 skipped**, with the PostgreSQL window released (`coordination/reports/antigravity-6.md:7218-7310`). This packet audits CON-01..05 separately.

The requested command is `npx jest --runInBand` from `services/connector`, three consecutive times. Important execution boundary: the full command is not purely offline because `p8-03-convergence.test.ts:630` contains an ungated live PostgreSQL projection test. The coordinator environment had `DATABASE_URL` unset, and the test's fallback is the local test DB `du_orchestrator_test`; the integration suites gated by `CONNECTOR_INTEGRATION` remain off. Per the established DB-test lane, Antigravity received the exact three-run request and was told to use only that test DB.

RUN REQUEST receipt `2e6709bf-5ce8-45dd-9090-cd526bf613fc`: `accepted=true`, stage `input_accepted`. Antigravity ran the same command three times in sequence. Runs 1 and 2 exited 0; run 3 completed assertions but failed one runtime-foundations test, then hung before the shell could emit its exit code. Thus this is not three consecutive green runs and does not satisfy P8-03 acceptance.

| Run | Exact command | Tests / ExitCode | Actual start/end (+07:00) |
|---|---|---|---|
| 1 | `npx jest --runInBand` | `Tests: 4 skipped, 74 passed, 78 total`; ExitCode `0`; 2 skipped suites, 10 passed | `2026-09-24T20:51:05+07:00` to `20:51:13+07:00` |
| 2 | `npx jest --runInBand` | `Tests: 4 skipped, 74 passed, 78 total`; ExitCode `0`; 2 skipped suites, 10 passed | `2026-09-24T20:51:19+07:00` to `20:51:23+07:00` |
| 3 | `npx jest --runInBand` | `Tests: 1 failed, 4 skipped, 73 passed, 78 total`; Jest-native ExitCode **not emitted**; task-facility forced-stop result `CANCELLED` | Started `2026-09-24T20:51:31+07:00`; Jest finished assertions at about `20:51:35+07:00`; hung process safely canceled at `2026-09-24T21:08:36+07:00` |

### Run 3 failure and process cleanup

`runtime-foundations.test.ts:64`, declaration `HTTP shell exposes health, redacted management, and write-only rotation`, failed at the fetch on `:100` to `/connectors/c1/credentials/rotate` with `TypeError: fetch failed`, cause `connect EADDRINUSE 127.0.0.1:59234`. The test's `server.close()` at `:107` is not in `finally`; the exception leaves the listener open. Jest printed `Ran all test suites` and the counts above, but did not emit a native exit code because Node remained alive on that handle. Antigravity's receipt confirms `p8-03-convergence.test.ts:630` DB projection passed in all three invocations. At the earlier status check, the database had zero active queries/transactions and its window was retained.

As confirmed in `antigravity-6.md:7948-7990`, the testing lane canceled the completed hung task at `2026-09-24T21:08:36+07:00`; this forced-stop status is not a Jest exit code. It verified 0 remaining invocation processes, PostgreSQL 0 active queries and 0 ungranted locks, Redis `PONG`, and released the DB window at `2026-09-24T21:09:30+07:00`.

Follow-up receipt: testing lane requested cleanup/status only; no rerun or source/test change was made. **Acceptance result:** there are two clean suite runs followed by one failed run, so the required three consecutive green runs were not obtained. The blocker is the `EADDRINUSE` failure in `runtime-foundations.test.ts`; invocation 3 has no emitted Jest-native ExitCode.

# W42-CX4 â€” Coordination report and adoption receipt

## Artifact path verification

- Before write: Test-Path -LiteralPath du-rework/coordination/reports/codex2.md â†’ False (command output captured immediately before creation).
- After write: Test-Path -LiteralPath du-rework/coordination/reports/codex2.md â†’ True.
- Final physical line count after creation: 70 lines (PowerShell `(Get-Content -LiteralPath $p -Encoding UTF8).Count`, with `$p = 'du-rework/coordination/reports/codex2.md'`; result `70`).

## W42-CX2 summary and executed checks

Updated du-rework/docs/19-traceability-audit-matrix.md using only canonical BR-01..BR-12, exact test titles, checked source/test paths, and explicit X-absent cells. P8-01 stayed [ ]. No test, build, PostgreSQL, or Redis command was run in this lane.

Commands and results recorded from the matrix path ledger validation, run from D:/Git/dugate:

- Test-Path -LiteralPath $path, once for each of the 54 result rows in docs/19 Â§2.2 â†’ 42 True, 12 False, 0 result mismatches.
- Select-String -Path $f -Pattern '^\| BR-(0[1-9]|1[0-2]) â€”' -Encoding utf8 â†’ 12 canonical BR rows.
- Select-String -Path $f -Pattern '^\| BR-(0[1-9]|1[0-2]) \|' -Encoding utf8 â†’ 12 X-absent rows.
- Test-Path -LiteralPath coordination/reports/codex2.md â†’ True for the prior repository-root report path. This does not substitute for this requested nested artifact; the nested path was False before this write.

The 54 path rows have 42 existing paths and 12 deliberately absent historical/root citations. The ledger mismatch count was zero. The counts above describe static path and row checks, not test execution.

## Adoption decision: P4-05 and P4-08 remain [ ]

Decision: do not adopt either task from the 82 offline suites and 8 live suites reported as run 19:05â€“19:07. Those runs explicitly excluded the two orphan integration files. Their existence and unrelated suite totals cannot prove the named P4 live assertions.

Basis: the already accepted W41-CC section in du-rework/coordination/reports/codex.md, lines 142â€“160. This packet relies on that accepted read-only audit and does not repeat it.

### P4-05

The accepted W41-CC record identifies du-rework/tests/integration/p4-05-artifact-streams.integration.test.ts as a seven-test live suite: staged upload grantâ†’PUTâ†’finalize READY, read-grant download, scoped file lifetime, oversized rejection, stale lease-epoch fencing, hash verification, and resultRef/disposal. The suite requires real PostgreSQL on :5433 and Redis on :6380 and had not been run/adopted in W41-CC.

The task acceptance is ART-01..03 plus bounded memory/file lifetime. Prior SDK offline evidence supports the SDK-side bounds/temp-workspace lifecycle, but not real P2 grant/access behavior or the platform ART-02 staging-orphan sweep. In particular, the platform sweep must protect artifacts referenced by active checkpoints; the SDK temp-workspace sweep only manages du-worker-* directories.

### P4-08

The accepted W41-CC record identifies du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts as one live cross-service case: submitâ†’dispatchâ†’SDK workerâ†’pending yieldâ†’retryâ†’stable invocationâ†’SUCCEEDED, using real P2 and P3, a mock provider, and a worker without DB credentials. It had not been run/adopted in W41-CC.

P4-08 requires the real consumer integration against P2/P3 and the worker credential boundary. The offline grant-service mock and unrelated live suites do not prove the real cross-service sequence. Adoption requires the exact suite result, command/exit code, service revisions/environment, and credential-boundary evidence.

## RUN REQUEST â€” existing Antigravity testing lane work; do not resend

The orchestrator reports that Antigravity (term_47a1d44b) is already running the live batch and will return pass/fail for these exact two files this cycle. The following records preserve the prior command requests; they are not new dispatches.

- P4-05, cwd du-rework/tests/integration: npx jest tests/integration/p4-05-artifact-streams.integration.test.ts --runInBand. Expected evidence: seven named live cases, exit code/result, PostgreSQL :5433, Redis :6380, service revision, and environment. Status: in progress at the testing lane; await its verdict.
- P4-08, cwd du-rework/tests/integration: npx jest tests/integration/p4-08-sdk-consumer.integration.test.ts --runInBand. Expected evidence: the full real-P2/P3 submit-to-SUCCEEDED sequence, exit code/result, service revisions/environment, mock-provider boundary, and proof the worker has no DB credential. Status: in progress at the testing lane; await its verdict.

W42-CX2 also recorded these earlier P8 traceability verification requests. They are listed for artifact completeness and are not re-issued here:

- RUN REQUEST: pnpm --dir du-rework/businesses/document-core run test:integration:full
- RUN REQUEST: pnpm --dir du-rework/businesses/document-core exec jest --runInBand --runTestsByPath tests/manifest.test.ts tests/all-variants-e2e.test.ts tests/traceability.test.ts tests/profile-binding-fixture.test.ts tests/checkpoint.test.ts tests/checkpoint-replay.test.ts tests/cancellation-fencing.test.ts tests/package-boundary.test.ts
- RUN REQUEST: pnpm --dir du-rework/services/orchestrator exec jest --runInBand --runTestsByPath tests/runtime.test.ts tests/admin-view-model.test.ts
- RUN REQUEST: pnpm --dir du-rework/businesses/example-review exec jest --runInBand --runTestsByPath tests/manifest.test.ts tests/example-review-continuation.integration.test.ts tests/fanout-and-join.test.ts
- RUN REQUEST: pnpm --dir du-rework/services/connector exec jest --runInBand --runTestsByPath tests/connector.test.ts tests/reliability-security.test.ts
- RUN REQUEST: pnpm --dir du-rework/packages/observability exec jest --runInBand --runTestsByPath tests/observability.test.ts

No run request above was executed by this Codex lane. Do not infer a passing result from the request text.

## PLATFORM REQUEST â€” already received by Claude Code/platform; do not duplicate

Please resolve the P4-05 ART-02 platform gap in services/orchestrator: implement staging-orphan cleanup guarded against deleting artifacts referenced by active checkpoints, or record an explicit scope deferral and its acceptance impact. Keep P4-05 [ ] until the live P2 artifact evidence and platform acceptance/deferral are recorded.

No packages/worker-sdk change is requested before the in-progress live run. The accepted W41-CC record already credits the SDK temp-workspace cleanup slice; do not duplicate that implementation. Route any later failure to the owner identified by its failing assertion.

## Current status

P4-05 and P4-08 remain [ ]. No source or test file was changed. No live command was sent or run by this lane. Wait for the current Antigravity verdict before changing either acceptance status.

## W42-CX6 execution update â€” 2026-09-23

This update supersedes the earlier "in progress" P4-08 request and the preceding statement that no test file had changed or run. The testing lane returned its verdict during this cycle.

### P4-08 type-drift decision

Read `du-rework/docs/34-p4-08-type-drift-spec.md` and selected option A: adapt the integration-test call site while preserving the frozen `WorkerConfig.invokeConnector` contract. The test supplies a typed `workerConfig: Parameters<typeof startWorker>[1]` and adapts the payload input when calling `createSdkConnectorInvoker`. No `packages/worker-sdk` or `packages/connector-client` signature/API was changed. Blast radius is limited to the P4-08 integration harness; P4-05 and P4-07 contracts and grant/payload security boundaries are unchanged.

The targeted typecheck config is `du-rework/tests/integration/tsconfig.test.json`.

### Typecheck and testing-lane result

- Offline command, cwd `D:/Git/dugate/du-rework/tests/integration`: `npx tsc --noEmit -p tsconfig.test.json` â€” **exit code 0**.
- RUN REQUEST was sent to the Antigravity testing lane (term_47a1d44b; message `msg_9c6d2c91bf20`): cwd `du-rework/tests/integration`, `npx jest p4-08-sdk-consumer.integration.test.ts --runInBand`.
- The testing lane's actual command added `--forceExit`: `cd du-rework/tests/integration && npx jest p4-08-sdk-consumer.integration.test.ts --runInBand --forceExit` â€” **exit code 1**; literal result: **`Tests: 1 failed, 1 total`**.
- TypeScript compiled and the test ran. The real P2/P3 operation `6119c437-925f-45c5-be55-e19fefd2ee3c` did not reach `SUCCEEDED` within 60 seconds and ended `FAILED` after the `PROVIDER_PENDING` retry path. Full DB-window output is in `du-rework/coordination/reports/antigravity-6.md` under W42-CX6.
- Adoption: **P4-08 remains `[ ]`**. P4-05 also remains `[ ]`; no task status was changed by this update.

### Traceability ledger and status check

Re-running `Test-Path -LiteralPath` for every one of the 54 Â§2.2 ledger paths in `du-rework/docs/19-traceability-audit-matrix.md` returned **42 True, 12 False, 0 mismatches**. Each of the twelve False paths is labeled `ABSENT - NOT EVIDENCE (Test-Path=False)` and is excluded from BR evidence; the matrix cross-check reports zero BR rows citing those paths. P8-01 remains `[ ]` because its isolated E2E harness acceptance clause is open.

There is no `P0-01` status text or row in `docs/19-traceability-audit-matrix.md` to rewrite. The live task row in `du-rework/tasks/P0-business-specs.md` is `[ ]`. Current on-disk task rows also show P0-06 `[x]` and P1-03 `[x]`; this lane did not edit those rows.

### Runtime failure trace and platform handoff

Read-only trace of the failed P4-08 run shows the retry cannot currently complete through the real connector path:

- `du-rework/services/connector/src/db/repository.ts:40` returns an existing invocation as `kind: 'replay'` without changing its state. `markPending` stores `PENDING` and `next_poll_at` (`repository.ts:113`).
- `du-rework/services/connector/src/invoke.ts:45-56` maps a replayed `PENDING` row with `nextPollAt` straight back to a pending outcome; this branch does not call the provider transport. The test changes the mock provider's default response after observing `RETRY_PENDING` (`tests/integration/p4-08-sdk-consumer.integration.test.ts:359`), but a replay of that same stable invocation does not observe the new response.
- This matches Antigravity's observed `PROVIDER_PENDING` retry and final `FAILED` operation. It is a P3 connector pending/polling contract gap, not a remaining TS2345 or a worker-sdk signature issue.

**PLATFORM REQUEST (new; separate from the existing P4-05 sweeper request):** Claude Code/platform, please define and implement the supported P3 behavior for a provider that returns HTTP 202: provide a durable way for the same stable invocation to poll/observe completion after `nextPollAt`, or document the intended terminal/pending contract and revise the P4-08 acceptance fixture accordingly while retaining real P2/P3 coverage. Keep P4-08 `[ ]` until the testing lane proves the agreed behavior and the worker credential boundary. No connector/orchestrator/worker-sdk source was changed by this lane. After a platform resolution, send the exact integration rerun to Antigravity (term_47a1d44b) for its DB window; no duplicate run is requested now.

## W42-CX15 â€” Step 1: signature and 429 inspection

Read `docs/34-p4-08-type-drift-spec.md` and the current call site and declarations. `services/connector/src/adapters/http.ts:63` classifies a provider HTTP 429 as `PROVIDER_RATE_LIMITED`; that is provider runtime/error classification and is unrelated to TS2345 at the worker configuration call.

Exact callable shapes:

- `WorkerConfig.invokeConnector` (`packages/worker-sdk/src/types.ts:251-254`): `(grant: InvocationGrant, payload: ConnectorInvocationPayloadShape) => Promise<InvocationResponse>`.
- `createSdkConnectorInvoker` returns `SdkConnectorInvoker` (`packages/connector-client/src/sdk-invoker.ts:48-49, 60-66`): `(grant: SdkInvocationGrant, payload: SdkInvocationPayload) => Promise<InvocationResponse>`.
- Both returns are the same `Promise<InvocationResponse>`. `SdkInvocationGrant` only requires `{ grant, invocationId }`, while `InvocationGrant` includes additional claims; the helper accepts that smaller structural shape, so the grant argument is not the failing incompatibility.
- The payload parameter is the mismatch: `ConnectorInvocationPayloadShape.input` is `ConnectorInvokeInput` (four named optional keys, no string index signature), while `SdkInvocationPayload.input` is `Record<string, unknown>`. Under strict function parameter compatibility, the helper promises to accept any record, but the worker provides the narrower interface, which lacks the index signature. The direct assignment in the original TS2345 site therefore fails on the payload parameter.

The current integration test has a local adapter that copies `payload.input` into a record. It passes the targeted typecheck, but does not make the exported package callable signatures agree; this packet addresses that package-level drift.

## W42-CX15 â€” Step 2: decision

**Decision: align the package signatures to the canonical connector contract.** Keep the frozen `WorkerConfig.invokeConnector` callback signature; replace duplicate input shapes in worker-sdk and connector-client with the shared `@du/contracts` `InvocationInput` type, which matches the strict `InvocationInputSchema`. Remove the test-only spread adapter and assign `createSdkConnectorInvoker(...)` directly to `WorkerConfig.invokeConnector` so the original seam is type-checked end to end.

Reason: `Record<string, unknown>` is broader than the strict wire input schema and is the source of the parameter mismatch. The `@du/contracts` type carries the exact supported fields and is structurally shared by both packages. This is a compile-time alignment; it does not alter the callback's runtime behavior or the wire payload.

Impact: **P4-05 none** (artifact APIs/lifecycle are untouched); **P4-07 type-surface only** (the invocation input is now typed from the frozen wire contract, with the P4-07 callback signature unchanged). Consumers attempting to pass keys rejected by the strict wire schema will now receive a compile-time error. **Security/API:** no grant, credential, authorization, or serialized-data behavior changes; input typing becomes narrower to match the already-strict runtime contract, so it does not add accepted API fields or privileges.

## W42-CX15 â€” Step 3: implementation and offline typechecks

Implemented the contract alignment in both packages:

- `packages/worker-sdk/src/types.ts`: `ConnectorInvokeInput` now aliases `@du/contracts` `InvocationInput`.
- `packages/connector-client/src/sdk-invoker.ts` and `src/types.ts`: the SDK payload and transport request `input` fields now use the same canonical `InvocationInput`.
- `tests/integration/p4-08-sdk-consumer.integration.test.ts`: removed the local spread adapter; `createSdkConnectorInvoker(...)` is assigned directly to the typed `WorkerConfig.invokeConnector` field.
- Added package tests `packages/worker-sdk/tests/connector-input-contract.test.ts` and `packages/connector-client/tests/sdk-invoker.test.ts`.

Actual offline typechecks (Jest was not run by this lane):

- cwd `D:/Git/dugate/du-rework/packages/worker-sdk`: `npx tsc --noEmit` â€” **exit code 0**.
- cwd `D:/Git/dugate/du-rework/packages/connector-client`: `npx tsc --noEmit` â€” **exit code 0**.
- cwd `D:/Git/dugate/du-rework/tests/integration`: `npx tsc --noEmit -p tsconfig.test.json` â€” **exit code 0**, including the direct P4-08 callback assignment.

P4-08 remains `[ ]`: the earlier testing-lane live run failed on the separate P3 HTTP-202 replay gap, and this type-only signature alignment does not resolve that runtime failure. No Jest was run by this lane. P4-05 and P8-01 remain `[ ]`.

### Testing-lane RUN REQUEST (package unit tests only)

Route these commands to Antigravity (term_47a1d44b), not to this Codex lane:

1. cwd `D:/Git/dugate/du-rework/packages/worker-sdk`: `npx jest tests/connector-input-contract.test.ts --runInBand`
2. cwd `D:/Git/dugate/du-rework/packages/connector-client`: `npx jest tests/sdk-invoker.test.ts --runInBand`

Both are offline package tests and need no PostgreSQL/Redis claim. Do not rerun the live P4-08 suite in the current platform window; its prior live verdict is a runtime P3 pending-replay failure, and the report's separate platform request remains unresolved.

**Request receipt:** Orca terminal send to Antigravity term_47a1d44b accepted request `18775a57-dfb6-4152-a378-bffa61ccd694`. The terminal transcript and durable testing-lane report confirm execution:

- `npx jest tests/connector-input-contract.test.ts --runInBand` â€” exit 0; literal `Tests: 1 passed, 1 total`.
- `npx jest tests/sdk-invoker.test.ts --runInBand` â€” exit 0; literal `Tests: 1 passed, 1 total`.

Full execution evidence is in `du-rework/coordination/reports/antigravity-6.md` under â€œRUN REQUEST RESPONSE: W42-CX15 Package Type Contract Tests (Offline Only)â€ (line 3315 onward). No live P4-08 rerun was requested or run.

## W42-CX16 - Antigravity verdict, connector request, and regression attribution

### P4-08 RUN REQUEST verdict (returned by Antigravity testing lane)

- Runner command from `D:/Git/dugate/du-rework/tests/integration`: `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter "p4-08"`.
- Test command recorded by the lane: `npx jest p4-08-sdk-consumer.integration.test.ts --runInBand --forceExit` (integration test working directory).
- Exit code: **1**. Literal summary: **`Tests: 1 failed, 1 total`**. The TypeScript diagnosis says TS2345 is cleared; runtime waited 60 seconds for `SUCCEEDED` and the operation ended `FAILED` after the `PROVIDER_PENDING` retry path.
- Decision: **P4-08 remains `[ ]` / UNVERIFIED / BLOCKED.** Clearing TS2345 proves the compile-time call shape only; it does not prove the real P2/P3 submit-to-SUCCEEDED acceptance path. Do not adopt or tick from the typecheck or package tests.

### CONNECTOR REQUEST - for orchestrator routing; not dispatched by this report

Please resolve the P3 HTTP-202 pending replay behavior before another P4-08 adoption attempt. Current on-disk implementation paths were checked: `Test-Path du-rework/services/connector/src/db/repository.ts` = **True**; `Test-Path du-rework/services/connector/src/invoke.ts` = **True**; the Antigravity report path `du-rework/services/connector/src/modules/ledger/repository.ts` = **False** in this checkout.

- In `du-rework/services/connector/src/db/repository.ts`, `PostgresInvocationLedger.claim()` returns `kind: 'replay'` for an existing invocation with the same input hash. `markPending()` stores state `PENDING` and `next_poll_at`.
- In `du-rework/services/connector/src/invoke.ts`, `invokeAdapter()` handles a replayed `PENDING` record with `nextPollAt` by returning `{ state: 'pending', nextPollAt }`. This branch does not call the provider transport or poll the provider.
- The P4-08 fixture first makes the provider return HTTP 202 with `nextPollAt`; after the operation reaches `RETRY_PENDING`, it changes the mock default to HTTP 200 and redelivers the same stable invocation. The connector replays the stored pending row and never observes that HTTP 200, so the operation does not reach `SUCCEEDED` and ultimately becomes `FAILED`.

Requested decision from the connector/platform owner: define and implement a provider-appropriate durable poll/replay contract for a pending invocation (including the persisted provider handle/state needed after `nextPollAt`), or explicitly define HTTP 202 as non-completing under this contract and revise the P4-08 acceptance fixture to exercise the supported completion path while preserving stable invocation identity and real P2/P3 coverage. Keep P4-08 `[ ]` until Antigravity verifies the agreed behavior, one ledger invocation reaches `SUCCEEDED`, the result artifact is present, and the worker DB-credential boundary is demonstrated. Do not modify connector/orchestrator services in this lane. After the owner resolves the contract, route the exact live rerun through Antigravity (`term_47a1d44b`) with a RUN REQUEST.

### Connector-client regression check

Antigravity's package-wide result for `D:/Git/dugate/du-rework/packages/connector-client` was command `npx jest --runInBand`, **exit code 0**: **`Tests: 1 skipped, 19 passed, 20 total`**; **`Test Suites: 1 skipped, 3 passed, 3 of 4 total`**. There was **no failed test** in this output.

The one skipped test is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `packages/connector-client/tests/real-service.test.ts`, inside `Connector client against real service (P3-07)`. The suite is conditionally skipped unless `CONNECTOR_INTEGRATION=1`; this is an opt-in live-service test, not a failure caused by the invocation-input type alignment. The new offline `tests/sdk-invoker.test.ts` also passed (`Tests: 1 passed, 1 total`, exit 0). Therefore the reported 19/20 is **19 pass + 1 skip + 0 fail**, not a 19-pass/1-failure regression. The skipped live-service acceptance is not established by this offline run.

No Jest was run by Codex-2 and no new test command was sent in this update. The docs ownership boundary was respected: no changes to `docs/19`, `docs/29`, `docs/31`, `docs/32`, or `docs/36`.
## W42-CX17 - P4-05 test shim removal and consolidated CR-13 run request

### Owned test change

Changed only `du-rework/tests/integration/p4-05-artifact-streams.integration.test.ts`, the P4-05 integration file in my delegated ownership scope.

- Old lines 270-272 claimed the runtime served base64 text; replaced with a comment that the runtime blob endpoint serves original bytes.
- Old lines 277-280 decoded the downloaded data via `Buffer.from(onDisk.toString('utf8'), 'base64')`; replaced with a direct byte equality assertion: `expect(onDisk.equals(payloadCopy)).toBe(true)` (current lines 276-277). The existing SHA-256 and size assertions remain.
- Updated the stale oversized-download comment from `payload base64 is far larger` to `raw payload exceeds this limit` (current line 302; old line 305).
- The test is now checking byte-for-byte round-trip: bytes downloaded to disk equal the pristine copy of the bytes uploaded. No platform, SDK, connector, or other integration test source was changed.

Offline typecheck: cwd `D:/Git/dugate/du-rework/tests/integration`; command `npx tsc --noEmit -p tsconfig.test.json`; **exit code 0**. No Jest or live service was run by Codex-2.

### One consolidated RUN REQUEST to Antigravity

Sent one request to Antigravity (`term_47a1d44b-6e1c-4e59-af80-d4553b927d85`) combining the CR-13 rerun items from Claude Code and this P4-05 fix. It asks the testing lane to run these three suites sequentially in one coordinated DB window and return each literal test summary, exit code, duration, and the single claim/release interval:

1. `powershell -ExecutionPolicy Bypass -File .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter "p4-05-artifact-streams"`
2. `powershell -ExecutionPolicy Bypass -File .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter "artifacts-grants"`
3. `powershell -ExecutionPolicy Bypass -File .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter "blob-wire-binary"`

Orca send receipt: `accepted: true`, request ID `c74a5f1e-7578-4c74-9aaf-4267a0c3d885`. The provider only returned `input_accepted` and cannot report `turn_started`; an immediate terminal read showed the exact combined request in Antigravity's transcript. No duplicate request was sent. Per-suite verdicts are pending; no task row was changed. The user will reconcile P4-05, P2-07, and P5-10 only after all three are green with exit code 0.

### Connector-client 19/20 clarification from W42-A72

The latest Antigravity result (`antigravity-6.md`, W42-A72, 23:14:30 +07:00) confirms the package has **zero failing tests** and Codex-2's 22:32 edits introduced no regression:

- Offline package command `cd packages/connector-client && npx jest --runInBand`: **19 passed, 1 skipped, 0 failed; exit code 0**.
- The skipped case is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `packages/connector-client/tests/real-service.test.ts`; it is gated by `CONNECTOR_INTEGRATION === '1'`.
- Live command `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter "real-service"`: **`Tests: 1 passed, 1 total`; exit code 0**.

Thus there is no failing connector-client test to attribute to the 22:32 package edits. P4-08 remains `[ ]` because its separate live runtime result is blocked on the P3 HTTP-202 pending replay contract documented above.
### W42-CX17 combined run result and row handoff

Antigravity recorded the one combined execution in `du-rework/coordination/reports/antigravity-6.md`, W42-CX17 (lines 3675 onward). DB window: **claimed 2026-09-23 23:46:45 +07:00; released 23:47:12 +07:00**.

| Suite | Literal result | Exit | Duration |
|---|---|---:|---:|
| `tests/integration/p4-05-artifact-streams.integration.test.ts` | `Tests: 7 passed, 7 total` | 0 | 5.10s |
| `tests/integration/artifacts-grants.integration.test.ts` | `Tests: 1 passed, 1 total` | 0 | 3.10s |
| `services/orchestrator/tests/blob-wire-binary.test.ts` | `Tests: 5 passed, 5 total` | 0 | 4.07s |

All three requested suites passed with exit code 0. The test results support your requested reconciliation. Codex-2 changed no `tasks/P*.md` status: current rows read P4-05 `[ ]` in `tasks/P4-worker-sdk.md`, P2-07 `[~]` in `tasks/P2-orchestrator.md`, and P5-10 `[~]` in `tasks/P5-document-core.md`. The Antigravity summary table uses `[x]` language for some evidence, but these on-disk task rows remain as listed; user/coordinator owns reconciliation. P5-10 was not part of this three-suite request; its prior W42-A72 multi-container result remains `Tests: 3 failed, 10 passed, 13 total`, exit 1.

The connector-client question is resolved by W42-A72: offline 19 passed, 1 environment-gated skip, 0 failed; the gated live `real-service.test.ts` passed 1/1 with exit 0. There is no failing connector-client test attributable to the 22:32 changes. P4-08 remains `[ ]` pending the separate P3 HTTP-202 replay contract resolution and a successful live P4-08 run.
## W42-CX18 - P3 replay connector request, offline regression rerun, and live P4-08 verdict

### CONNECTOR REQUEST - route to the P3 connector owner

This is the runtime blocker for P4-08; TS2345 is already cleared. Do not edit `services/connector` in this lane. Current checkout path checks:

- `Test-Path -LiteralPath services/connector/src/db/repository.ts` -> **True**.
- `Test-Path -LiteralPath services/connector/src/invoke.ts` -> **True**.
- The alternate path cited in an old Antigravity report, `services/connector/src/modules/ledger/repository.ts`, -> **False**.

Exact behavior in this checkout:

- `services/connector/src/db/repository.ts:40` `PostgresInvocationLedger.claim()` returns `kind: 'replay'` for a matching existing invocation ID and input hash. `markPending()` at :113 stores `PENDING` plus `next_poll_at`.
- `services/connector/src/invoke.ts:36-56` `invokeAdapter()` sees a replayed `PENDING` record with `nextPollAt` and immediately returns `{ state: 'pending', nextPollAt }`. It does not call the provider transport or a provider status-poll operation on that branch.
- Reproduction is `tests/integration/p4-08-sdk-consumer.integration.test.ts`, test `full cross-service run: submit -> dispatch -> SDK worker -> pending yield -> retry -> stable invocation -> SUCCEEDED`. It first configures the mock provider to return HTTP 202 with `nextPollAt` (:254-259), waits for `RETRY_PENDING` (:352-355), then changes the provider default to HTTP 200 (:357-365) and expects `SUCCEEDED` (:367). The redelivery carries the same stable invocation ID; P3 replays its stored PENDING row and cannot observe the changed 200 response.

**Request:** define and implement a durable, provider-appropriate poll/replay contract after `nextPollAt`, including persisted provider operation/reference state needed to poll completion while retaining stable invocation identity and avoiding duplicate side effects; alternatively define HTTP 202 as non-completing for this contract and revise the P4-08 fixture to exercise the supported P3 completion behavior. Acceptance requires the real P2/P3 case to reach `SUCCEEDED`, leave one successful ledger row and result artifact, and preserve the worker DB-credential boundary. This request is recorded for the user to route; it was not dispatched to a service owner by Codex-2.

### Connector-client offline rerun

Per W42-CX18, Codex-2 ran the offline package suite directly (no DB/services): cwd `D:/Git/dugate/du-rework/packages/connector-client`; command `npx jest --runInBand`; **exit code 0**.

Literal output:

```text
PASS tests/sdk-invoker.test.ts
PASS tests/transport.test.ts
PASS tests/client.test.ts

Test Suites: 1 skipped, 3 passed, 3 of 4 total
Tests:       1 skipped, 19 passed, 20 total
Snapshots:   0 total
```

**Failing test: none. Exact failure: none.** The skipped case is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `packages/connector-client/tests/real-service.test.ts`; it is gated on `CONNECTOR_INTEGRATION === '1'`. This rerun shows no failure attributable to the 22:32 `sdk-invoker.ts` / input-type changes, so no package fix is indicated. No package source was changed for this rerun.

### P4-08 RUN REQUEST RESPONSE - Antigravity W42-A74

Antigravity's response is in `coordination/reports/antigravity-6.md`, W42-A74, with DB window 2026-09-24 00:41:40-00:44:01 +07:00. For `tests/integration/p4-08-sdk-consumer.integration.test.ts`, the literal result is **`Tests: 1 failed, 1 total`**, **exit code 1**, 63.42s. TS2345 compiled cleanly. Runtime error: **`operation did not reach [SUCCEEDED] within 60000ms (last: FAILED)`** after `PROVIDER_PENDING`; the report identifies the P3 HTTP-202 replay gap. Keep P4-08 `[ ]`; Codex-2 did not change its task row or dispatch a duplicate run.

### Ownership and roster

Roster v4 section 14 identifies Codex-3 (`term_6fd976df`) as reviewer, not a test execution destination. No RUN REQUEST was sent to Codex-3. Current task rows were read only: P4-05 `[~]`, P4-08 `[ ]`, P2-07 `[~]`, and P5-10 `[~]`. Codex-2 changed none of them. Qwen-owned docs were not edited.
## W42-CX19 - Exact P3 replay diagnosis and fresh connector-client checks

### CONNECTOR REQUEST for the P3 connector owner (for user routing)

The latest P4-08 response is W42-A75 at 2026-09-24 00:57:33 +07:00. Its command was `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter p4-08`; result **`Tests: 1 failed, 1 total`**, exit **1**, 64.41s. TS2345 is clean. The runtime error is **`operation did not reach [SUCCEEDED] within 60000ms (last: FAILED)`**.

Current path/function diagnosis in this checkout:

- `services/connector/src/db/repository.ts:40-67`, `PostgresInvocationLedger.claim()`: matching stable `invocationId` + `inputHash` returns `kind: 'replay'` with the existing ledger row. The idempotency identity is stable and dedupe is working; it leaves one ledger row.
- `services/connector/src/db/repository.ts:113-120`, `markPending()`: records `state='PENDING'` and `next_poll_at` after the provider's 202 response.
- `services/connector/src/invoke.ts:41-57`, `invokeAdapter()`: for a replayed row with `state='PENDING'` and `nextPollAt`, returns `{ state: 'pending', nextPollAt }` immediately. It does not call the provider transport or a status-poll function, including after `nextPollAt`.

This is a ledger replay short-circuit, not an idempotency-key mismatch. The test returns HTTP 202 with `nextPollAt` (`tests/integration/p4-08-sdk-consumer.integration.test.ts:254-259`), waits for `RETRY_PENDING` (:352-355), changes the mock provider to HTTP 200 (:357-365), then redelivers the same stable invocation and waits for `SUCCEEDED` (:367). The replay branch returns the saved PENDING response, so the changed provider response is never observed.

Grant expiry does not match the observed failure. `services/orchestrator/src/modules/grants/grants.ts:31` sets `GRANT_TTL_SECONDS = 15 * 60`; issue/refresh logic at :189-220 renews the token for the same stable identity while the grant row remains live. The observed run lasts 64.41s and reports the `PROVIDER_PENDING` / terminal-state timeout path, not an expired-grant rejection. Thus the cause identified by the run and source is missing P3 pending-operation polling/replay behavior.

**Request to route:** implement/define a durable provider-specific poll/replay path for the stored pending invocation (including any provider operation reference needed to poll) after `next_poll_at`, preserving stable invocation identity and avoiding duplicate provider side effects. If HTTP 202 is intentionally non-pollable under this contract, document that contract and change the P4-08 fixture to exercise the supported async completion path. Verify with the one-command reproduction above. Keep P4-08 unchecked until the real P2/P3 case reaches `SUCCEEDED`, stores one successful ledger row/result, and proves the worker credential boundary. Codex-2 made no `services/connector` or orchestrator source edits; this request is for the user to route.

### Connector-client offline rerun

Per CX19, reran in `D:/Git/dugate/du-rework/packages/connector-client`:

- `npx tsc --noEmit` -> **exit 0**.
- `npx jest --runInBand` -> **exit 0**; `Tests: 1 skipped, 19 passed, 20 total` (3 suites passed, 1 suite skipped).
- Passing suites: `tests/transport.test.ts`, `tests/client.test.ts`, and `tests/sdk-invoker.test.ts`.
- Failing test: **none**. Exact error: **none**. The one skipped case is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `tests/real-service.test.ts`, gated by `CONNECTOR_INTEGRATION === '1'`.

No current offline failure is attributable to the 22:32 `sdk-invoker.ts` / input-type edits; no package fix was indicated or made.

### P4-08 response and testing-lane batch (state at report time)

At the time this section was written, W42-A75 was the latest completed P4-08 RUN REQUEST RESPONSE and W42-A76 was still running; no duplicate RUN REQUEST was sent. W42-A76 has since completed; see the follow-up below.

Task rows were read only. Current on-disk mapping is P4-05 `[~]` and P4-08 `[ ]` (P2-07 and P5-10 are `[~]`). No task status was edited by Codex-2. The request was to leave them unchanged; if the shorthand CX19 ordering intended a different mapping, reconcile it at the owner/coordinator lane.

**Blocker line at report time:** No usage-limit, model, or hook blocker; offline checks are complete. W42-A76 has since completed; the remaining dependency is the user-routed P3 contract decision.
## W42-CX19 follow-up â€” Antigravity W42-A76 result

Antigravity completed the active batch and recorded its response in `du-rework/coordination/reports/antigravity-6.md` under W42-A76 (DB window 2026-09-24 06:11:00â€“06:13:46 +07:00; response timestamp 06:13:46). The recorded suite results are:

- `tests/integration/p4-05-artifact-streams.integration.test.ts`: `Tests: 7 passed, 7 total`, exit code 0 (4.10s).
- `tests/integration/p4-08-sdk-consumer.integration.test.ts`: `Tests: 1 failed, 1 total`, exit code 1 (63.41s); runtime error `operation did not reach [SUCCEEDED] within 60000ms (last: FAILED)`. TS2345 remains resolved. The report attributes this to the P3 HTTP-202 pending polling/replay contract.
- The A76 report did not include a literal invocation command. The prior A75 report recorded the reproduction command: `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter p4-08`.

This is a test result, not authorization to alter task statuses. I made no task-row edits. On-disk status at the prior read was P4-05 `[~]` and P4-08 `[ ]`; follow the user's task table for reconciliation. P4-08 remains blocked on P3 behavior pending the routed connector request.

**Current blocker:** No usage, model, or hook blocker; offline checks and the P3 diagnosis are recorded. Awaiting user routing/decision on the P3 replay contract; no source or task changes are pending in this lane.
## W42-CX20 - Routing request and latest Antigravity verdict

### CONNECTOR REQUEST for user routing to the P3 connector/platform owner

The P4-08 runtime failure is a pending-ledger replay short-circuit, not a stable-idempotency mismatch and not grant expiry:

- `du-rework/services/connector/src/db/repository.ts:40-67`, `PostgresInvocationLedger.claim()`, finds the same `invocationId` and matching input hash and returns `kind: 'replay'`. `markPending()` at `:113-120` persists `PENDING` and `next_poll_at`.
- `du-rework/services/connector/src/invoke.ts:45-62`, `invokeAdapter()`, returns the stored pending state for a replayed `PENDING` row with `nextPollAt`. It does not invoke provider transport or a status-poll operation after `next_poll_at`. The idempotency identity is doing its deduplication job; the missing behavior is polling/replaying provider completion.
- Reproducer: `du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts`, test `full cross-service run: submit -> dispatch -> SDK worker -> pending yield -> retry -> stable invocation -> SUCCEEDED` at `:224`. The fixture returns HTTP 202 with `nextPollAt` at `:254-259`, waits for `RETRY_PENDING` at `:352-355`, switches the mock to HTTP 200 at `:357-365`, then expects `SUCCEEDED` at `:367`. The same stable invocation is redelivered, but the PENDING replay short-circuit never observes the changed provider response.
- One-command reproduction: `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter p4-08` (the command recorded with W42-A75; W42-A77 recorded the verdict but not its invocation command).
- Grant expiry is inconsistent with this failure: `du-rework/services/orchestrator/src/modules/grants/grants.ts:31` sets a 15-minute TTL; W42-A77 failed after 62.92 seconds with the PENDING-to-SUCCEEDED timeout.

**Requested P3 decision/action:** define and implement durable provider-specific polling for a pending invocation after `next_poll_at`, persisting any provider operation/reference needed to poll while retaining stable invocation identity and avoiding duplicate side effects. If HTTP 202 is intentionally not pollable in this contract, document that boundary and revise the P4-08 fixture to verify the supported completion path. Acceptance evidence must show the real P2/P3 operation reaches `SUCCEEDED`, one successful ledger row and result artifact exist, and the worker has no DB credential. This request is for the user to route; this lane did not edit `services/connector` or send it to another owner.

### Connector-client 19/20 answer

The latest local offline check recorded in W42-CX19 was `npx jest --runInBand` from `du-rework/packages/connector-client`: exit 0, `Tests: 1 skipped, 19 passed, 20 total`. **Failed test: none. Exact test error: none.** The skipped test is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `du-rework/packages/connector-client/tests/real-service.test.ts:152`, gated by `CONNECTOR_INTEGRATION === '1'`. `npx tsc --noEmit` exited 0. Thus no failure is attributable to the 22:32 changes; no package fix is indicated.

### Latest RUN REQUEST response; no duplicate request sent

Antigravity W42-A77 returned at `2026-09-24 07:01:48 +07:00` in `du-rework/coordination/reports/antigravity-6.md`. P4-08: `Tests: 1 failed, 1 total`, exit 1, 62.92s; TS2345 is clean; runtime error: `operation did not reach [SUCCEEDED] within 60000ms (last: FAILED)`, attributed there to the P3 HTTP-202 pending replay contract. P4-05 also ran 7/7, exit 0. Since the live lane has returned a P4-08 verdict, no new RUN REQUEST was sent. Keep task rows unchanged pending the user's table/reconciliation.

**Status discrepancy:** The instruction says preserve P4-05/P4-08 as `[ ]`/`[~]`, while the checked-in `du-rework/tasks/P4-worker-sdk.md` currently reads P4-05 `[~]` and P4-08 `[ ]`. No task row was changed; flagging the mismatch rather than silently rewriting either status.

**Blocker line:** No usage-limit, model, hook, or approval blocker; the P4-08 response is present. The remaining dependency is routing and resolving the P3 pending replay contract, followed by a new Antigravity run after that resolution.
W42-CX20 path check log (commands run from `D:/Git/dugate`):

- `Test-Path -LiteralPath 'du-rework\services\connector\src\db\repository.ts'` -> `True`.
- `Test-Path -LiteralPath 'du-rework\services\connector\src\invoke.ts'` -> `True`.
- `Test-Path -LiteralPath 'du-rework\tests\integration\p4-08-sdk-consumer.integration.test.ts'` -> `True`.
- `Test-Path -LiteralPath 'du-rework\services\orchestrator\src\modules\grants\grants.ts'` -> `True`.
- `Test-Path -LiteralPath 'du-rework\packages\connector-client\tests\real-service.test.ts'` -> `True`.
- `Test-Path -LiteralPath 'du-rework\coordination\reports\codex2.md'` -> `True`.
## W42-CX21 - Explicit request receipt and fresh package verification

### P3 CONNECTOR REQUEST receipt (for user routing)

**Receipt:** This request is written here and addressed to the user for routing because the user reports that `services/connector` has no current owner. It has **not** been delivered to a platform/service owner or another agent; there is no external send receipt. No connector-service source was changed.

The exact P4-08 replay gap is:

- `du-rework/services/connector/src/db/repository.ts:40-67`, `PostgresInvocationLedger.claim()`: a redelivery with the same invocation ID and input hash gets the existing ledger record as `kind: 'replay'`. This is stable-idempotency deduplication working as designed, not an idempotency mismatch.
- `du-rework/services/connector/src/db/repository.ts:113-120`, `markPending()`: stores `PENDING` and `next_poll_at` after the provider's HTTP 202.
- `du-rework/services/connector/src/invoke.ts:45-62`, `invokeAdapter()`: when the replayed record is still PENDING and has `nextPollAt`, returns pending without calling provider transport or polling provider status. The behavior that does not occur is observing provider completion after `next_poll_at` and transitioning the ledger/result to SUCCEEDED.
- The actual integration case is `full cross-service run: submit â†’ dispatch â†’ SDK worker â†’ pending yield â†’ retry â†’ stable invocation â†’ SUCCEEDED` in `du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts:224`. It sets the provider to 202/PENDING at `:254-259`, yields to `RETRY_PENDING` at `:352-355`, changes the mock to 200 at `:357-365`, and expects SUCCEEDED at `:367`.
- Reproduce with one command: `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter p4-08`.
- This is not explained by grant expiry: the grant TTL is 15 minutes at `du-rework/services/orchestrator/src/modules/grants/grants.ts:31`, while the latest explicit P4-08 failure completed in 61.87 seconds.

**Request to route:** define and implement durable provider-specific polling/replay after `next_poll_at`, persisting any provider operation reference needed while retaining stable invocation identity and preventing duplicate side effects; or explicitly define HTTP 202 as non-pollable and revise the acceptance fixture to use the supported completion contract. Acceptance should show real P2/P3 completion to SUCCEEDED, one successful ledger row plus result artifact, and the worker DB-credential boundary.

### Connector-client 19/20: exact failure and 22:32 attribution

I reran offline checks from `D:/Git/dugate/du-rework/packages/connector-client`:

- Command `npx jest --runInBand` -> exit code **0**. `Tests: 1 skipped, 19 passed, 20 total`; suites `tests/transport.test.ts`, `tests/client.test.ts`, and `tests/sdk-invoker.test.ts` passed.
- **Failed test:** none. **Exact error:** none. The skipped test is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `tests/real-service.test.ts` (guarded by `CONNECTOR_INTEGRATION === '1'`).
- Command `npx tsc --noEmit` -> exit code **0**.

There is no failing test/error to attribute to the 22:32 `sdk-invoker.ts` / `types.ts` changes, so no package fix was indicated or made.

### Testing-lane receipt and status boundary

Antigravity has already returned P4-08 results; no duplicate RUN REQUEST was sent. The latest explicit P4-08 execution recorded for W42-A80 (2026-09-24 07:35:22 +07:00) is `Tests: 1 failed, 1 total`, exit code 1, 61.87s, with `operation did not reach [SUCCEEDED] within 60000ms (last: FAILED)`; TS2345 is clean. Later W42-A81/A82 notes still report the P3 replay blocker. P4-05 also has green live results, but I did not change either P4 task row.

The user instructed P4-05/P4-08 `[ ]`/`[~]`; the checked-in task file still reads P4-05 `[~]`, P4-08 `[ ]`. I made no row edits and recorded the conflict instead of silently reconciling statuses.

**Blocker line:** No usage-limit, model, hook, or approval blocker; offline package checks are complete. The remaining dependency is user routing and resolution of the P3 connector replay contract, then a new testing-lane run.
## W42-CX22 - P3 routing receipt and connector-client regression check

### CONNECTOR REQUEST receipt for the user to route

**Receipt status:** The P3 request is recorded here and addressed to the user because `services/connector` has no current owner. It has not been delivered to an owner or another agent, and no external delivery receipt exists. This lane did not edit connector service files.

**Verified source paths** (commands run from `D:/Git/dugate`, all returned `True`):

- `Test-Path -LiteralPath 'du-rework\services\connector\src\db\repository.ts'`
- `Test-Path -LiteralPath 'du-rework\services\connector\src\invoke.ts'`
- `Test-Path -LiteralPath 'du-rework\tests\integration\p4-08-sdk-consumer.integration.test.ts'`

**Replay behavior to resolve:**

- In `du-rework/services/connector/src/db/repository.ts:40-76`, `PostgresInvocationLedger.claim()` selects by stable `invocation_id`; at `:53-57`, a matching `inputHash` returns `{ kind: 'replay', record }`. This is expected idempotent deduplication, not an input mismatch. `markPending()` at `:113-120` persists `PENDING` and `next_poll_at`.
- In `du-rework/services/connector/src/invoke.ts:45-58`, `invokeAdapter()` handles a replayed `PENDING` row at `:52-57` by checking the credential and returning the stored `{ state: 'pending', nextPollAt }`. It does not call provider transport or a status-poll operation after `next_poll_at`; provider completion is never observed, so the invocation cannot transition to `SUCCEEDED` through this path.
- The scenario is test `full cross-service run: submit â†’ dispatch â†’ SDK worker â†’ pending yield â†’ retry â†’ stable invocation â†’ SUCCEEDED` at `du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts:224`. The fixture returns HTTP 202 at `:254-259`, waits for `RETRY_PENDING` at `:352-355`, changes the mock to HTTP 200 at `:357-365`, and expects `SUCCEEDED` at `:367` on the same stable invocation.
- One-command reproduction: `powershell .\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Live -Filter p4-08`.
- Grant expiry is inconsistent with the failure: `du-rework/services/orchestrator/src/modules/grants/grants.ts:31` sets a 15-minute TTL; the explicit P4-08 run completed in 61.87 seconds.

**Requested P3 action:** define and implement durable provider-specific polling/replay after `next_poll_at`, persisting any provider operation reference required while retaining stable invocation identity and avoiding duplicate side effects. If HTTP 202 is not intended to be pollable, document that contract and revise the acceptance fixture to test the supported completion behavior. Acceptance needs a real P2/P3 operation reaching `SUCCEEDED`, one successful ledger row plus result artifact, and proof that the worker has no DB credential.

### connector-client 19/20: failure name, exact error, and attribution

Fresh offline verification from `D:/Git/dugate/du-rework/packages/connector-client`:

- `npx jest --runInBand` -> **exit code 0**; `Tests: 1 skipped, 19 passed, 20 total`. Passed suites: `tests/transport.test.ts`, `tests/client.test.ts`, `tests/sdk-invoker.test.ts`.
- **Failed test:** none. **Exact error:** none. The skipped test is `invoke/poll/wait/cancel behave end-to-end over real HTTP` in `tests/real-service.test.ts:152`, gated by `CONNECTOR_INTEGRATION === '1'`.
- `npx tsc --noEmit` -> **exit code 0**.

There is no failure to attribute to the 22:32 `sdk-invoker.ts` / `types.ts` changes; no package fix is indicated or made.

### Antigravity evidence boundary and P4 status

W42-A83 in `du-rework/coordination/reports/antigravity-6.md` is timestamped 2026-09-24 08:31:15 +07:00. Its four-suite execution table does not include P4-08; the Codex-2 response gives a P4-08 status reminder only. The latest explicit P4-08 execution recorded in that report remains W42-A80 at 07:35:22: `Tests: 1 failed, 1 total`, exit code 1 (61.87s), TS2345 clean, runtime error `operation did not reach [SUCCEEDED] within 60000ms (last: FAILED)`. Later notes keep the P3 replay blocker. Since a P4-08 result already exists, no duplicate RUN REQUEST was sent.

No P4 task rows were changed. The checked-in `du-rework/tasks/P4-worker-sdk.md` still reads P4-05 `[~]`, P4-08 `[ ]`; that differs from the requested `[ ]`/`[~]` ordering and is left for explicit owner/coordinator reconciliation.

**Blocker:** No usage-limit, model, hook, or approval blocker. The named dependency is the unowned P3 connector replay contract, which requires user routing; after its resolution, Antigravity must rerun P4-08.
## W44-C2X - PENDING provider poll implementation and verification

### Scope and status boundary

The user assigned this lane ownership of `services/connector`. Implemented pending replay/poll behavior there and added connector-owned offline coverage. I did not edit task status files, orchestrator, migrations, worker-sdk, or another lane's tests. P4/P3 rows remain for coordinator reconciliation; this report does not tick P4-08, P4-05, or P3-05.

### Implementation evidence

- `services/connector/src/invoke.ts:64-98` handles a replayed PENDING invocation: validates `nextPollAt` and the invocation deadline, returns pending before the due time, then calls `claimPendingPoll(invocationId, inputHash, currentTime)` before contacting the provider. A losing concurrent poller rereads the ledger and returns stored completion/pending or reports the terminal/unknown state; it does not dispatch a second poll.
- `services/connector/src/db/repository.ts:78-88` implements the durable Postgres compare-and-set: state changes from PENDING to IN_FLIGHT only when invocation ID, input hash, and due `next_poll_at <= $3` match. `services/connector/src/types.ts:127-139` declares this ledger operation; `services/connector/src/ledger.ts:42-59` implements it for the in-memory ledger. `services/connector/src/db/repository.ts:90-97` allows a successful result to complete from IN_FLIGHT/PENDING.
- `services/connector/src/invoke.ts:116-157` acquires a quota lease using a fresh timestamp. Lease duration remains bounded at `max(30_000, providerTimeoutMs + 1000)` unless explicitly configured. If Redis throws or quota is unavailable before any provider request, the connector stores retryable PENDING at `min(deadline, now + 1000ms)`; no provider call is made. Acquired leases are released in `services/connector/src/invoke.ts:229-233`. A lease whose acquisition response is lost is bounded by its expiry.
- `services/connector/src/invoke.ts:174-208` sends the same adapter request again only after `next_poll_at`, with a forced `Idempotency-Key: <invocationId>`. HTTP 202 requires a valid `nextPollAt` and is clamped to at least one second later and no later than the request deadline; a 2xx response is normalized and stored SUCCEEDED, non-2xx is classified and stored FAILED, and timeout/transport ambiguity remains UNKNOWN per CON-03. The HTTP adapters also set this key at `services/connector/src/adapters/http.ts:35-48` and `:77-87`.
- This connector contract replays the same POST with the stable provider idempotency key; the current adapter interface has no separate provider operation URL/reference field. The P4-08 test fixture exercises same-key replay by changing its provider response from 202 to 200. Providers that require a distinct status endpoint/reference need an adapter contract extension and are not asserted by these offline tests.

### Added offline regression coverage

`services/connector/tests/connector.test.ts` now covers:

- `pending replay waits until nextPollAt, then polls with the same provider idempotency key` (:100), including repeated 202 then SUCCEEDED, no quota lease before due time, and lease acquire/release for each attempt.
- `concurrent due PENDING replay claims only one provider poll` (:206).
- `quota lease store failure returns due invocation to retryable PENDING` (:242).
- `Postgres pending poll claim is a due-state compare-and-set scoped to the input hash` (:281), checking SQL predicates and the false/no-row path.
- Existing deadline case (:176) checks a due invocation fails PROVIDER_TIMEOUT without another provider dispatch. Existing response-loss case (:332) still checks UNKNOWN/no blind retry.

### Commands run in services/connector

- `npx tsc --noEmit` -> **ExitCode 0** (no output).
- `npx jest --runInBand --testPathIgnorePatterns 'tests/black-box-durable.test.ts|tests/durable-integration.test.ts' --testNamePattern '^(?!.*live usage_events projection)'` -> **ExitCode 0**; `9 suites passed, 67 passed, 1 skipped, 68 total`. The command excludes the DB-backed durable suites and the live usage_events projection test. No DB-backed Jest was run by this lane.

### P4-08 RUN REQUEST receipt to Antigravity testing lane

Sent to runtime terminal `term_47a1d44b-6e1c-4e59-af80-d4553b927d85` (agentIdentity antigravity) with `orca terminal send --terminal term_47a1d44b-6e1c-4e59-af80-d4553b927d85 --text "RUN REQUEST W44-C2X: After your current live batch completes and the DB window is free, run P4-08 against the current connector polling changes. Exact command from D:\\Git\\dugate: powershell .\\tests\\isolation\\concurrent-runner.ps1 -Mode Batch -Category Live -Filter p4-08. Report the literal Jest summary (Tests: N passed, M total), ExitCode, exact runtime error/verdict, executed command, and DB window claim/release timestamps in antigravity-6.md. Do not edit or tick P3/P4 task rows. This request is queued behind your current batch; do not overlap shared DB use." --enter --wait-submit 10 --json`.

Runtime receipt: `accepted=true`, requestId `97afdd86-f0b5-4e69-87a1-018029bf9dc9`, stage `input_accepted`, mutation request `3d55b0a9-a80a-42db-bd08-8ec0863ee066`. The terminal provider reports delivery observation as unsupported. A subsequent `orca terminal read --terminal term_47a1d44b-6e1c-4e59-af80-d4553b927d85 --screen --json` showed the RUN REQUEST in the terminal composer while Antigravity was still running its existing multi-container command (`Test Suites: 1 passed, 1 total`; `Tests: 12 skipped, 1 passed, 13 total`). Thus the request is queued/visible but not yet acknowledged or executed; no P4-08 verdict is claimed. No duplicate request was sent.

**Current remaining acceptance:** await Antigravity's actual P4-08 run after its current batch and the shared DB window are free. Reconcile P4-08/P3 status only from the testing-lane verdict and coordinator direction. No usage-limit, model, or hook blocker.

### W44-C2X follow-up - Antigravity W42-A97 window release

After the RUN REQUEST was queued, `coordination/reports/antigravity-6.md:6083-6194` recorded W42-A97: `Tests: 13 passed, 13 total`, **ExitCode 0**, zero skipped, DB released at `2026-09-24 13:35:50 +07:00`. This is the multi-container R24-02 run, not P4-08. It satisfies the reported A6 13/13 condition, but P4-08's separate live request remains visible in Antigravity's composer and has not returned a verdict. P3/P4 task rows remain untouched for coordinator reconciliation.

At 2026-09-24 13:41 +07:00, Antigravity's terminal was still active (terminal title `npm exec jest tests/bullmq-smoke.test.ts --runInBand --forceExit`); the P4-08 RUN REQUEST remained visible in its queued composer. No P4-08 execution or verdict is present yet. No further prompt was sent, to avoid duplicating or interrupting the testing lane's current run.

At 2026-09-24 13:47 +07:00, Antigravity's screen still showed `pnpm --filter @du/connector run build` active, with both `RUN REQUEST W44-C2X` and the subsequent W42-A98 coordinator prompt in its queued composer. `orca terminal wait --for tui-idle --timeout-ms 25000` returned timeout. The P4-08 request is not acknowledged or executed yet; this is the remaining external acceptance dependency.

## W44-C2Y - CX3 W43-R14 follow-up (D - cross-tenant invocation access, priority 1)

- Added a second authorization factor for GET status and POST cancel: `services/connector/src/http/server.ts` passes `x-invocation-grant` to the runtime; `services/connector/src/services.ts` loads the ledger row, verifies the signed grant, and binds audience, tenant, operation, task, step, invocation ID, input hash, and expiry before returning result/content/usage or cancelling. Missing grant is denied; a grant bound to tenant B cannot read/cancel tenant A's record.
- To preserve the existing P4-07 client flow, the previously assigned connector-client lane now caches each submitted grant by invocation ID (bounded to 512 entries) and sends it only as `x-invocation-grant` on status/cancel requests in `packages/connector-client/src/transport.ts`. It remains alongside the required service-identity bearer; the grant is not placed in URLs or logs. Connector black-box GET setup and offline auth/transport tests were updated.
- Offline security coverage: `services/connector/tests/invocation-access.test.ts` checks absent/invalid/mismatched grants and authorized status/cancel. `runtime-foundations.test.ts` checks header forwarding.
- Required typechecks after D: from `services/connector`, `npx tsc --noEmit` -> **ExitCode 0**; from `packages/connector-client`, `npx tsc --noEmit` -> **ExitCode 0**.
- DB-backed black-box suite was not run here; any such run remains for Antigravity. No task row was changed.

## W44-C2Y - CX3 W43-R14 follow-up (A - provider async contract)

In `services/connector/src/types.ts`, `ProviderAdapter` now declares `asyncPollingMode: 'idempotency-key-replay'` and documents the provider requirement: replaying the same POST with the same `Idempotency-Key` must return current or terminal state. `AdapterConfig.asyncPollingMode` is an explicit opt-in; `invoke.ts` fails closed on HTTP 202 unless both the adapter supports this mode and the configured provider revision declares it. A provider with a separate status URL is not supported by this adapter contract. `adapters/http.ts` declares this mode for JSON and multipart HTTP adapters. The P4-08 fixture now explicitly opts in. `invoke.ts` preserves optional `providerRequestId` from HTTP 202 and persists/returns it via `ledger.ts`, `db/repository.ts`, `services.ts`, and `contracts.ts`. This selects the explicit idempotent POST replay contract; it does not claim general provider status polling.

**Verification:** `npx tsc --noEmit` in `services/connector` -> **ExitCode 0** after explicit opt-in enforcement. Final offline Jest: `npx jest tests/connector.test.ts tests/invocation-access.test.ts tests/runtime-foundations.test.ts --runInBand` -> **ExitCode 0**, `3 suites passed, 23 tests passed, 23 total`. The connector suite checks that an unconfigured HTTP 202 fails closed. Provider-specific replay behavior still needs DB/live testing-lane coverage.

## W44-C2Y - CX3 W43-R14 follow-up (B - durable poll recovery)

`services/connector/src/types.ts` and `ledger.ts` now represent a poll lease token and expiry on each invocation. `db/repository.ts` claims a due PENDING poll with a generated token and expiry; it can also reclaim an `IN_FLIGHT` poll only after the prior token's expiry. All poll result transitions (`complete`, `fail`, `markPending`, `markUnknown`) are fenced by that token, and clear lease state on transition. Terminalizing a still-PENDING replay now uses a separate compare-and-set bound to invocation ID, input hash, and `state = 'PENDING'`, so a concurrent poll claim cannot be overwritten by an expired/invalid replay. `invoke.ts` returns the active lease expiry to concurrent retries, reclaims expired leases, and passes the token through every poll outcome. Thus an old worker that returns after recovery cannot overwrite the new owner's state. `src/db/migrations/002_connector_poll_recovery.sql` adds the lease columns/index; `PgSqlClient.migrate()` now applies 001 and 002 independently so existing installations receive the additive migration. Provider transport replay remains safe only under A's same-key provider deduplication contract.

**Verification:** `npx tsc --noEmit` in `services/connector` -> **ExitCode 0** after B. The durable DB migration/recovery suite was not run; it requires the testing lane's database window. No task row was changed.

## W44-C2Y - CX3 W43-R14 follow-up (C - quota carry-forward)

`services/connector/src/services.ts` now keys quota by the shared `credentialRef`, removing tenant IDs from the provider-account concurrency bucket. `invoke.ts` sizes a new lease through the bounded invocation deadline, stores the lease key/ID/expiry with an accepted PENDING invocation, reuses that lease on redelivery, and releases it only after a terminal result; an ambiguous provider timeout keeps the Redis reservation until its deadline expiry. `ledger.ts` and `db/repository.ts` preserve the lease across PENDING/UNKNOWN and clear it on SUCCEEDED/FAILED/CANCELLED. `src/db/migrations/003_connector_quota_carry.sql` adds the durable lease columns/index. `quota-redis.ts` now sets the Redis key TTL from the latest sorted-set lease, so a short lease cannot expire another async job's longer reservation. Authenticated cancel eagerly releases the captured lease; if Redis release fails, its deadline-bounded TTL remains the fallback.

**Verification:** `npx tsc --noEmit` in `services/connector` -> **ExitCode 0** after C. The final 23/23 offline suite includes the quota carry-forward path in `tests/connector.test.ts`; DB-backed quota concurrency/restart coverage is assigned to the testing lane. No task row was changed.

## W44-C2Y - CX3 W43-R14 follow-up (E - provider poll backoff/budget)

`services/connector/src/invoke.ts` now schedules async provider replays with exponential delay (1s base, doubling to a 30s cap) and 20% jitter, while respecting a later provider `nextPollAt` and the invocation deadline. It persists `provider_poll_attempts`; after 16 async responses that remain 202, the next due redelivery is fenced and moved to `UNKNOWN` for reconciliation without another provider POST, while its carried quota reservation remains deadline-bounded. The counter/migration are in `types.ts`, `ledger.ts`, `db/repository.ts`, and `src/db/migrations/004_connector_poll_backoff.sql`; `PgSqlClient.migrate()` applies that additive migration. Quota retry delay remains one second because those retries do not contact the provider.

**Verification:** `npx tsc --noEmit` in `services/connector` -> **ExitCode 0** after E and the stale-owner lease-retention adjustment. Final offline run `npx jest tests/connector.test.ts tests/invocation-access.test.ts tests/runtime-foundations.test.ts --runInBand` -> **ExitCode 0**, `3 suites passed, 23 tests passed, 23 total`; includes expired-lease recovery, stale poll fencing, explicit provider opt-in, tenant authorization, poll backoff count, quota carry-forward, and SQL claim predicate checks. The first run after adding the opt-in exposed widened test literal types (TS2345); `as const` fixed the fixtures and the rerun passed. No DB-backed Jest was run here. No task row was changed.

### DB-backed RUN REQUEST to Antigravity

Sent once to testing lane terminal `term_47a1d44b-6e1c-4e59-af80-d4553b927d85`; exact command requested from `D:\Git\dugate\du-rework\services\connector`:

```text
npx jest tests/black-box-durable.test.ts tests/durable-integration.test.ts --runInBand
```

Request `99718183-781c-488b-9852-115a5de1c12e` returned `accepted=true`, stage `input_accepted`; delivery observation is unsupported. A fresh terminal screen read showed the request visible in Antigravity's queued composer while its W42-A99 live batch was running. The prompt explicitly says to wait for W42-A99 completion and a free PostgreSQL+Redis window, then report literal suite/test summary, ExitCode, migration versions, poll recovery/quota outcomes, and DB claim/release timestamps. No DB result is claimed yet; no duplicate request was sent.

### Final connector verification and migration packaging

- The repository's `services/connector/Dockerfile` previously copied only `001_connector.sql` into `dist/db/migrations`; it now copies every SQL migration so the runtime can apply `002_connector_poll_recovery`, `003_connector_quota_carry`, and `004_connector_poll_backoff` after deployment.
- Final `npx tsc --noEmit` from `services/connector` -> **ExitCode 0**.
- Final offline command: `npx jest --runInBand --testPathIgnorePatterns 'tests/black-box-durable.test.ts|tests/durable-integration.test.ts' --testNamePattern '^(?!.*live usage_events projection)'` -> **ExitCode 0**, `Test Suites: 10 passed, 10 total`; `Tests: 1 skipped, 73 passed, 74 total`. The two durable DB suites and live usage projection test are excluded for Antigravity's DB window.
- The first full offline attempt timed out only `concurrent due PENDING replay claims only one provider poll` because jitter made the test's hard-coded 1-second advance nondeterministic. The test now injects a fixed midpoint random source; final rerun above passes. An earlier opt-in test run also found widened literal types, fixed with `as const`; the final full rerun passes.
- P3/P4 task rows remain unchanged by this lane. No `services/orchestrator` or migration outside `services/connector/src/db/migrations` was edited.

## W44-C2Z - CX3 W43-R15 follow-through

### 1. `real-service.test.ts` live regression fixture

CX3's accepted diagnosis is specific: the private test transport sent bearer auth but omitted the invocation-bound `x-invocation-grant` on GET/cancel. The service correctly rejects those reads. Replaced that test-only transport in `packages/connector-client/tests/real-service.test.ts` with production `createHttpTransport`, and declared `asyncPollingMode: 'idempotency-key-replay'` in the mock provider revision because the fixture returns HTTP 202 for its cancellation case.

Verification command, working directory `D:\Git\dugate\du-rework\packages\connector-client`:

```text
npx tsc --noEmit
ExitCode: 0
```

Live verification was routed once to Antigravity (`term_47a1d44b-6e1c-4e59-af80-d4553b927d85`), not run in this lane. Exact requested command from `packages/connector-client`:

```powershell
$env:CONNECTOR_INTEGRATION='1'; npx jest tests/real-service.test.ts --runInBand
```

Orca receipt: request `0b0a6825-f138-4e9c-b8b8-b84934b4e9cf`, `accepted=true`, stage `input_accepted`; delivery observation is unsupported. A follow-up terminal screen showed the request visible in Antigravity's composer with its agent generating. This is a queued/visible request, **not an execution verdict**. Await literal Jest summary and ExitCode in `antigravity-6.md`; no green result is claimed here.

### 2. Client continuity for poll/cancel grants

`packages/connector-client/src/transport.ts` now accepts async `resolveInvocationGrant(invocationId)` for callers that recreate the client or need a fresh signed grant. Poll/cancel resolve through that callback and retain the 512-entry local map only as a same-process fallback. Added `packages/connector-client/tests/transport.test.ts` coverage invoking with one client, then polling/cancelling with a recreated client and resolver. The service's tenant-bound authorization remains enforced.

Verification command, working directory `D:\Git\dugate\du-rework\packages\connector-client`:

```text
npx tsc --noEmit
ExitCode: 0
```

Offline test RUN REQUEST sent to the same Antigravity testing lane, sequenced after the live request above:

```text
npx jest tests/transport.test.ts --runInBand
```

Orca receipt: request `15bddd36-bcba-4a28-9362-b8c9e6909846`, `accepted=true`, stage `input_accepted`; screen showed it queued while `real-service.test.ts` was running. It is not a test verdict; await Antigravity's literal summary and ExitCode.

### 3. High A decision: record the supported async-provider boundary

Decision: **document the explicit replay-only contract; do not claim generic GET-status support.** Added service-owned ADR `services/connector/docs/ADR-001-async-provider-polling-contract.md`. It records the dual adapter/config opt-in, stable `invocationId`/`Idempotency-Key` replay requirement, required `nextPollAt`, optional persisted provider request ID, fail-closed `CAPABILITY_UNSUPPORTED`, and the distinct status-URL protocol as unsupported until a separate adapter contract defines URL/host/auth/schema/retry behavior. This keeps P4-08 evidence scoped to the replay-mode mock provider.

Verification command from `D:\Git\dugate\du-rework\services\connector`:

```text
npx tsc --noEmit
ExitCode: 0
```

Testing-lane RUN REQUEST (queued after the two prior commands):

```text
npx jest tests/connector.test.ts --runInBand
```

Orca receipt: request `e88df10c-f313-4740-8e3a-4a5e03bcafe7`, `accepted=true`, stage `input_accepted`; delivery observation is unsupported. It requests the literal Jest summary/ExitCode confirming fail-closed unconfigured 202 and declared replay behavior. No test result is claimed yet.

### Antigravity responses for items 1â€“3

Antigravity recorded W44-C2Z-1 at `coordination/reports/antigravity-6.md` (dated 2026-09-24 15:00 +07:00): `$env:CONNECTOR_INTEGRATION='1'; npx jest tests/real-service.test.ts --runInBand` -> `Tests: 1 passed, 1 total`, **ExitCode 0** (97 ms test); full connector-client with integration enabled -> `Tests: 22 passed, 22 total`, **ExitCode 0**, no skips. DB window: claimed 14:58:55, released 15:00:10 +07:00. The actual live regression is green.

The same report records W44-C2Z-2 and W44-C2Z-3 as offline, no DB window: `npx jest tests/transport.test.ts --runInBand` -> **18/18, ExitCode 0**; `npx jest tests/connector.test.ts --runInBand` -> **17/17, ExitCode 0**. The resolver continuity case and ADR-aligned fail-closed/replay tests passed.

### 4. Live proof cases added for High B and High C

Added two cases to `services/connector/tests/black-box-durable.test.ts`:

- **High B:** real HTTP invocation persists `PENDING`; the test claims the due poll with the same PostgreSQL CAS used by Connector, confirms no second provider call, shuts down the live composition before provider dispatch, waits for that stored lease to expire, then restarts and redelivers. While the recovered poll is blocked at the provider, the old poll token attempts a Postgres terminal write and must be rejected; release the replacement poll and assert one durable `SUCCEEDED` row/result with the stable invocation idempotency key. The fault injection claims the durable lease through the ledger test handle so the restart boundary is deterministic; the provider is not contacted before the shutdown.
- **High C:** tenant A receives HTTP 202 and holds the quota lease for the shared `credentialRef`; tenant B then gets `QUOTA_EXHAUSTED`, has no lease, and has zero provider calls. After A reaches terminal success and releases its lease, B is redelivered and completes with exactly one provider call.

Verification command from `D:\Git\dugate\du-rework\services\connector`:

```text
npx tsc --noEmit
ExitCode: 0
```

Live RUN REQUEST to Antigravity:

```powershell
$env:CONNECTOR_INTEGRATION='1'; npx jest tests/black-box-durable.test.ts --runInBand
```

Orca receipt: request `42ff200b-e3f7-437e-a122-9b0bbb185805`, `accepted=true`, stage `input_accepted`; terminal screen shows the request visible and Antigravity loading it. It is a queued/visible request, not a live result. Await literal suite/test counts, ExitCode, DB claim/release times, and the requested per-case observations in `antigravity-6.md`.

Antigravity returned W44-C2Z-4 in `coordination/reports/antigravity-6.md`: exact command `$env:CONNECTOR_INTEGRATION='1'; npx jest tests/black-box-durable.test.ts --runInBand --verbose` from `services/connector`; `Test Suites: 1 passed, 1 total`, `Tests: 3 passed, 3 total`, **ExitCode 0** (3.734 s). DB/Redis window: claimed `2026-09-24 15:09:00 +07:00`, released `15:10:16 +07:00`.

- High B: actual persisted PENDING poll lease was claimed, Connector composition shut down before provider dispatch, the 150 ms lease expired, and a restarted composition redelivered. The recovery call completed SUCCEEDED; the old lease's Postgres `complete(...)` was rejected with `INVOCATION_UNKNOWN`; provider calls were 1 before the simulated crash and 2 after recovery.
- High C: tenant A's 202 retained the shared credential quota lease; tenant B received HTTP 429 `QUOTA_EXHAUSTED` and had zero provider calls. After A completed and released the lease, B completed SUCCEEDED with one provider call.

All four R15 work items now have an implementation/artifact and requested testing evidence. CX3 read-only re-review remains the final acceptance dependency. P4-08/P3 task rows were not edited.

### CX3 re-review request

Because W44-C2Z makes a clean CX3 re-review a P4-08 acceptance condition, I sent `REVIEW REQUEST W44-C2Z-5` to Codex-3 reviewer terminal `term_6fd976df-b0dd-4622-9bc2-e34939e4226a`. It asks for read-only A/B/C/D/Medium/E verdicts against current source and W44-C2Z-1..4 evidence, remaining severities/file:line, and an explicit 0-HIGH result in `coordination/reports/codex3.md`. It prohibits edits to source/tasks/other lane documents and test execution. Orca receipt `45ee3997-36df-48f9-a024-cce701e460a9` has `accepted=true`, stages `input_accepted` and `turn_started`; a terminal screen confirms the review prompt is active. No reviewer verdict is claimed yet.

### Medium grant continuity follow-up after CX3 W44-C2Z-5

CX3 accepted **0 HIGH** but retained a conditional Medium because no production direct-poll caller was configured with the resolver. `packages/connector-client/src/types.ts` and `src/client.ts` now make `invocationGrant` an explicit `InvocationAccessOptions` for `poll`/`cancel`, with `wait` accepting and forwarding it; the transport gives this explicit grant priority and keeps resolver/cache behavior as fallback. `real-service.test.ts` now invokes with client A and performs poll, wait, and cancel from a fresh client B with the fresh signed grant. `transport.test.ts` covers that explicit path and the resolver path.

Verification from `D:\Git\dugate\du-rework\packages\connector-client`:

```text
npx tsc --noEmit
ExitCode: 0
```

RUN REQUEST W44-C2Z-6 was sent to Antigravity, exact command from `packages/connector-client`:

```powershell
$env:CONNECTOR_INTEGRATION='1'; npx jest tests/transport.test.ts tests/real-service.test.ts --runInBand
```

Orca request `1fe6fc3c-8a3b-4d6b-85c7-571786d1c735` returned `accepted=true`, stage `input_accepted`; a subsequent terminal screen showed it visible and Antigravity loading it. This is not yet an execution result. Await literal Jest counts, ExitCode, and DB window timestamps before asking CX3 to re-review.

Antigravity returned W44-C2Z-6 in `coordination/reports/antigravity-6.md`: `$env:CONNECTOR_INTEGRATION='1'; npx jest tests/transport.test.ts tests/real-service.test.ts --runInBand --verbose` from `packages/connector-client` -> `Test Suites: 2 passed, 2 total`; `Tests: 20 passed, 20 total`, **ExitCode 0**, no skips. DB/Redis window: claimed `2026-09-24 15:19:24 +07:00`, released `15:21:40 +07:00`. The live test invoked with client A, recreated client B, then passed a fresh signed grant explicitly through `poll`, `wait`, and `cancel`; terminal cancel stayed rejected and pending cancel succeeded. Offline transport assertions verified the grant header for explicit and resolver-provided grants. The conditional Medium is addressed at the public API and live caller path; P4-08/P3 task rows remain untouched.

### W44-C2Z-7 - CX3 final re-review delivery status

The explicit-grant follow-up and Antigravity W44-C2Z-6 live evidence are complete. The staged read-only prompt asks CX3 to re-review R15 A/B/C/D, the client grant-continuity Medium, and `real-service.test.ts`, then append a final severity verdict to `coordination/reports/codex3.md`.

- Target: CX3 terminal `term_6fd976df-b0dd-4622-9bc2-e34939e4226a`, incarnation `f056fb2d-c1c5-45f6-b7b2-f6a0c89c009c`.
- Exact Orca terminal prompt receipt: `9734addd-c348-48d9-9c81-5e05225cf233`. Initial result: `agent_prompt_blocked`. The prescribed exact retry returned `operation_unknown`; `orca orchestration request-show --request 9734addd-c348-48d9-9c81-5e05225cf233 --json` still reports `state: pending`, so no delivery or reviewer verdict is claimed.
- `orca terminal read --screen` still shows the prior W44-C2Z-5 completed turn and the W44-C2Z-7 text as an unsent UI draft. `orca orchestration inbox --terminal term_6fd976df-b0dd-4622-9bc2-e34939e4226a` is empty, and this coordinator terminal has no bound Run. Orca computer-use restore produced a Windows desktop screenshot rather than a usable Orca terminal view, so I did not bypass the pending receipt or create a new review identity.
- Acceptance status: the source changes, typechecks, and Antigravity executions recorded above remain valid. CX3 final re-review is still outstanding; P4-08 was not ticked or reconciled.



### W44-C2Z-7 result - CX3 re-review completed

The pending-delivery note above is superseded by CX3's completed read-only review at `coordination/reports/codex3.md:221-234`. CX3 inspected the current source and W44-C2Z-6 receipts, did not run Jest, and did not change tasks or reconcile P4-08.

- Final verdict: **zero HIGH / zero MEDIUM** in R15 A/B/C/D, client grant continuity, and `real-service.test.ts`; no new reproducible finding in scope.
- The review accepts the explicit replay-mode contract, live B/C evidence, fresh-grant public API/live caller proof, and the live service regression result. GET-status providers and initial unleased `IN_FLIGHT` remain separate unsupported/reconciliation boundaries, not findings in this review.
- The earlier Orca `pending` receipt was eventually consumed by CX3. The final verdict is recorded in `codex3.md`; the earlier delivery-status note above is retained as a timestamped history of the interim state, not the current status.
- P4-08 remains unchanged by this lane for coordinator reconciliation.

# OPT-PERF-01 — request-path latency baseline and proposals

Date: 2026-10-02. Scope: offline request-path test timing and read-only hot-path inspection. No source, test, config, or task files were changed; no DB, Redis, S3, Docker, Vault, or other infrastructure was used. There is no public-wire change proposed.

## 1. Prior receipts and method

Read `codex-functest-a-contracts-sdk-2026-10-02.md`, `codex-functest-b-orchestrator-offline-2026-10-02.md`, `codex-functest-c-connector-offline-2026-10-02.md`, `codex-red-evidence-functest-b-2026-10-02.md`, and `qwen-par00-evidence-map-2026-10-02.md` before measuring. FUNCTEST-B already records counts and the offline/infra boundary for the Orchestrator suites; RED-EVIDENCE already establishes the observability logger's stdout sink and explains why the deferred-section log assertion does not see it. This report adds local timing observations and request-path inspection; it does not repeat the prior test-failure diagnosis.

Ran the selected Orchestrator suites individually from `du-rework/services/orchestrator` with `pnpm exec jest --runInBand --runTestsByPath tests/<suite>.test.ts`. A `Stopwatch` around the child command records process wall time (including pnpm/Jest startup); Jest's printed `Time` is recorded separately. The compatibility decoder suite was invoked with `--json` to collect its per-test durations. These are offline suite measurements, not production HTTP latency or database benchmarks. `tests/ingress-bounded.test.ts` was not run because FUNCTEST-B classifies it on the explicit live deny-list (`codex-functest-b-orchestrator-offline-2026-10-02.md`, §Skipped suites); no attempt was made to contact infrastructure.

## 2. Offline timing baseline

| Suite | Tests passed / failed | Jest runtime (ms) | Command wall (ms) | Result |
|---|---:|---:|---:|---|
| `multipart-routes-offline.test.ts` | 33 / 0 | 7,822 | 9,415 | pass |
| `multipart-service-offline.test.ts` | 52 / 0 | 3,675 | 4,898 | pass |
| `s3-multipart-storage-offline.test.ts` | 16 / 0 | 3,677 | 5,802 | pass |
| `s3-multipart-upload.test.ts` | 6 / 0 | 4,055 | 5,389 | pass |
| `public-upload-encryption-gateway.test.ts` | 9 / 0 | 8,094 | 9,528 | pass |
| `operations-list-contract-conformance.test.ts` | 19 / 0 | 7,757 | 9,040 | pass |
| `operations-list-cursor-sort-binding.test.ts` | 54 / 0 | 6,752 | 8,051 | pass |
| `admin-operations-list-pagination.test.ts` | 103 / 0 | 10,879 | 12,388 | pass |
| `admin-shell-server.test.ts` | 43 / 13 | 5,096 | 6,981 | **fail on rerun** |
| `compat-decoders.test.ts` | 46 / 0 | 4,869 | 6,578 | pass |
| `legacy-action-router.test.ts` | 34 / 0 | 3,279 | 4,605 | pass |
| `legacy-headers.test.ts` | 66 / 0 | 3,797 | 5,039 | pass |
| `legacy-operations.test.ts` | 27 / 0 | 3,335 | 4,560 | pass |
| `legacy-wire-decoders.test.ts` | 10 / 0 | 3,450 | 4,681 | pass |
| `legacy-payload-migration.test.ts` | 9 / 0 | 3,104 | 4,636 | pass |

Current rerun total: **14/15 suites pass; 527 passed, 13 failed of 540 tests**. The red `admin-shell-server.test.ts` had passed 56/56 in FUNCTEST-B (`codex-functest-b-orchestrator-offline-2026-10-02.md`, suite row). In this rerun the 13 failures include profile/connector fixtures expecting HTTP 200 but receiving 403; the observed profile error says the `operator` role is not authorized and requires `admin` (assertions include `tests/admin-shell-server.test.ts:636, 681, 698, 808`). This suite timing is retained as a failed measurement, not treated as a clean latency baseline. No fix was attempted.

Representative individual Jest case durations (assertion time, rounded by Jest; these are not end-to-end service timings):

| Suite | Individual test observed | ms |
|---|---|---:|
| `multipart-routes-offline` | non-positive/unparseable multipart limit fails boot | 50 |
| `operations-list-contract-conformance` | every contract parameter is wired into parser | 85 |
| `operations-list-cursor-sort-binding` | refuses to mint cursor without boundary row/timestamp | 31 |
| `admin-operations-list-pagination` | invalid state enum is dropped and named in ignored filters | 94 |
| `compat-decoders` | refuses to mint cursor without boundary row/timestamp | 31 |
| `legacy-action-router` | `handleOwned` rejects a foreign path | 19 |
| `legacy-operations` | rejects unknown legacy state filters | 10 |
| `legacy-wire-decoders` | normalizes each core action discriminator | 7 |
| `legacy-payload-migration` | legacy read window start/end boundary case | 83 |
| `s3-multipart-upload` | resumes after stream interruption by rehashing checkpointed parts | 139 |
| `public-upload-encryption-gateway` | streams chunked encryption with downstream backpressure | 142 |

Jest case times are mostly single-digit milliseconds; suite wall times include roughly 1.2–2.1 seconds of runner/startup overhead in these observed runs and should not be interpreted as per-request latency. The offline list suites use test DB seams/fakes and therefore provide no database query latency. Multipart route/service suites likewise exercise fake storage/crypto seams; they do not measure a live S3 or Vault path.

## 3. Hot-path inspection and ranked candidates

The ordering below combines structural work on a request with the offline observations; it is not a measured production p50/p95 ranking. Every gain marked “estimated” remains unverified because this task used zero infrastructure.

| Rank / hotspot | Evidence | Optimization proposal | Gain estimate | Risk | Status |
|---|---|---|---|---|---|
| 1. Operations list DB path | `server.ts:3373-3379` awaits a page query using `SELECT *`; only after that, `server.ts:3417-3422` awaits a separate filtered `count(*)`. The result mapper uses the projection callback at `:3425-3431`; public mapping reads a narrower field set in `modules/operations/facade.ts:32-50`, while admin adds `tenantId` in `server.ts:4107-4109`. | Narrow the page SELECT to fields actually consumed by the projection; start the independent population count before awaiting the page query and join with `Promise.all`, keeping the count predicate free of the cursor. | Estimated up to one DB round-trip of request latency from overlap if the pool has spare capacity; narrower projection reduces row bytes in proportion to unused columns. No DB numbers measured. | Concurrent queries use another pool slot and can observe different snapshots; count must remain over the filtered population, not the cursor remainder. SQL mocks/fixtures may pin the statement. | `patch-proposal + lease request` |
| 2. Long-poll re-reads | `modules/operations/facade.ts:57-84` polls every 500 ms, clamps wait to 30 seconds, and calls `getOp` initially plus on every poll (`:74-81`). The public route supplies tenant-scoped `getTenantOperation` (`server.ts:1806-1811,1834-1840`). | If a tenant-fenced operation-change notification seam is available, wait on it and re-read the operation after wake; preserve the bounded wait and tenant-fenced read. Do not remove the read-after-wake fence. | Theoretical reduction from up to about 61 reads per 30-second request to an initial read plus a wake read; no latency measurement. | Missing/lost notifications can strand requests; wakeups must be tenant-safe and bounded. No notification seam was established by this read-only pass. | `patch-proposal + lease request` |
| 3. JSON ingress allocation/parse | `http/ingress.ts:55-103` accumulates chunks, tracks `total`, calls `Buffer.concat`, converts to UTF-8, then `JSON.parse`; JSON ingress is capped at 1 MiB and binary ingress at 64 MiB (`:28-29,59-61`). The server calls this helper on the common body path (`server.ts:734-742`). | Profile allocation under representative concurrent JSON requests first. A low-risk micro-change available for review is to pass the already tracked `total` to `Buffer.concat(chunks, total)`; consider a length-hinted single-buffer path only with safe fallback for absent/mismatched lengths and tests for the cap/stream failure behavior. | The small concat change only avoids re-summing chunk lengths; likely negligible. A validated single-buffer path could avoid the final N-byte copy and chunk references for accurate `Content-Length`; at most one body-sized copy saved (up to the 1 MiB JSON cap), not measured. | A length hint is untrusted; preserve streamed byte counting, 413 behavior, partial-close handling, and raw JSON fallback exactly. Allocation of the full cap for small bodies could regress memory. | `patch-proposal + lease request` |
| 4. Encrypted multipart upload | `upload-encryption-gateway.ts:431-459` buffers and hashes small single-shot bodies, and streams larger bodies through `encryptStream`; it monitors ciphertext and hashes plaintext/ciphertext (`:453-459`). S3 part assembly is incremental (`:488-495`). Crypto chunk geometry is 4 MiB with an 8 MiB stream high-water mark (`modules/encryption/crypto-storage-facade.ts:13-14`, `upload-encryption-gateway.ts:457-459`). | Add an isolated `opt-perf-*` benchmark before requesting any chunk-geometry change; compare wall throughput and peak RSS with real local AES and mocked storage. Keep both integrity hashes, authentication tags, manifest fields, and streaming/backpressure. | Unknown until benchmark. Encryption and integrity hashing remain O(bytes); only per-chunk overhead might improve. No before/after bench was run or claimed. | Chunk size is persisted and validated in manifests (`crypto-storage-facade.ts:86,292-297,368`); changing it can affect read compatibility and memory, so it is not a safe constant-only tweak. | `patch-proposal + lease request` |
| 5. API-key resolution | Each public list/detail route resolves the key (`server.ts:1791-1802,1834-1840`). `resolveApiKey` performs SHA-256 and one ACTIVE-key lookup (`:4182-4197`); `api_keys.hash` is unique (`migrations/0001_platform_v1.sql:17`). This is SHA-256, not bcrypt/scrypt. | Measure hash time and DB lookup separately in an approved DB environment. Do not cache successful resolutions without an explicit revocation-invalidation design: the ACTIVE filter is checked per request. | No gain estimate without DB timing. The SHA-256 operation is one digest; likely database/network latency is the variable, but it was not measured here. | Caching risks accepting revoked keys; production DB profiling is outside this zero-infra task. | `measurement-only; no cache proposal` |

### Required logger and facade checks

The logger's default sink writes one line per emitted record to `process.stdout` (`packages/observability/src/logger.ts:27-30`) and serializes/redacts before the sink write (`:163`). RED-EVIDENCE already characterized this path (`codex-red-evidence-functest-b-2026-10-02.md:43-45,97`). The Orchestrator's request listener calls this logger in its unhandled ingress/request error paths (`server.ts:756,828`); the inspected normal response path does not establish a log write on every successful request, so I did not rank stdout as a common-path bottleneck or recommend batching it without request-level log-volume evidence.

The operation facade creates one view per returned row, including ISO date conversion, constant progress projection, and links (`modules/operations/facade.ts:32-50`); the server serializes response bodies once at the HTTP boundary (`server.ts:809`). This is O(page size), but the tested page cap and offline timings provide no evidence that the mapping/stringify dominates database work. No mapping cache or wire-shape change is proposed.

## 4. Patch proposals and lease requests

No existing file was edited. The following sketches are proposals only; each change requires an explicit owner lease before implementation.

### Proposal A — list query overlap and projection

```diff
diff --git a/services/orchestrator/src/server.ts b/services/orchestrator/src/server.ts
@@ listOperationsPage
- const page = await ctx.db.query(
-   `SELECT * FROM operations${pageWhere} ORDER BY ${sortKeySql} ${scanDirection}, id ${scanDirection} LIMIT $${pageParams.length}`,
-   pageParams
- );
+ const countPromise = ctx.db.query(
+   `SELECT count(*)::int AS total FROM operations${filtersWhere}`,
+   filters.params
+ );
+ const pagePromise = ctx.db.query(
+   `SELECT id, tenant_id, business_id, business_version, action, state, state_version, created_at, updated_at, deadline_at FROM operations${pageWhere} ORDER BY ${sortKeySql} ${scanDirection}, id ${scanDirection} LIMIT $${pageParams.length}`,
+   pageParams
+ );
+ const [page, counted] = await Promise.all([pagePromise, countPromise]);
@@
- const counted = await ctx.db.query(
-   `SELECT count(*)::int AS total FROM operations${filtersWhere}`,
-   filters.params
- );
```

Lease request: `services/orchestrator/src/server.ts` (expected owner: server integrator `qwen_1`) and existing operation-list conformance tests (serialize their owner with the server lane). Impact: medium/high if DB RTT or wide rows dominate; effort: low/medium. This retains the count's filtered-population semantics and response projection, but the pool/snapshot risks above need review.

### Proposal B — bounded JSON body assembly

```diff
diff --git a/services/orchestrator/src/http/ingress.ts b/services/orchestrator/src/http/ingress.ts
@@ end event, after bounded byte count is final
- const rawBuffer = Buffer.concat(chunks);
+ const rawBuffer = Buffer.concat(chunks, total);
```

Lease request: `services/orchestrator/src/http/ingress.ts` and `services/orchestrator/tests/ingress-bounded.test.ts` (expected owner: request-ingress lane/coordinator). This is the safe micro-change only; its possible gain is limited to avoiding the concat length-summing pass. The larger length-hinted single-buffer idea is not included as a code diff because it needs a fallback design and cap/failure tests, and the relevant ingress suite remains on the FUNCTEST-B deny-list.

### Proposal C — terminal wait notification

```diff
diff --git a/services/orchestrator/src/modules/operations/facade.ts b/services/orchestrator/src/modules/operations/facade.ts
@@ waitForTerminal polling loop
- await delay(Math.min(500, remaining));
- op = await getOp(operationId);
+ await waitForOperationChange(operationId, remaining);
+ op = await getOp(operationId); // preserve the route's tenant-fenced read
```

Lease request: `modules/operations/facade.ts`, `server.ts`, and the runtime state-transition notification owner (expected owner: runtime/operations lane, coordinated with `qwen_1`). Impact: high potential DB-query reduction; effort: high because notification delivery, timeout, cancellation, and tenant fencing need proof. `waitForOperationChange` is a proposed seam, not an existing helper found in this pass.

### Proposal D — encrypted multipart geometry benchmark

No source diff is safe to propose before measuring: the persisted manifest carries and validates chunk geometry (`crypto-storage-facade.ts:86,292-297,368`). Lease request: allow a new `opt-perf-*` offline benchmark and, only if it demonstrates a gain without compatibility change, a later scoped lease for crypto/upload owners. Impact: unknown; effort: medium for benchmark, high for a compatible runtime change.

### API-key path

No key-cache patch is requested. The only proposal is to separately measure SHA-256 and the indexed ACTIVE-key SQL lookup in an approved DB lane. Owner for any temporary request instrumentation would be the server integrator (`server.ts:4182-4197`). No DB was used in this packet, so no source diff or cache lease is justified.

## 5. Implementation order

1. **Operations list** — medium/high impact, low/medium effort: first measure row width and page/count query latency in an authorized database lane, then consider the proposed overlap/projection while pinning count and cursor semantics.
2. **Long-poll wait** — high potential query-volume impact, high effort: only after the runtime owner identifies and tests a bounded tenant-safe state-change notification path.
3. **Ingress allocations** — medium memory/GC potential, medium effort: start with the tiny `Buffer.concat(chunks, total)` diff; benchmark common chunking/body sizes before a larger allocation-path change.
4. **Multipart crypto chunk tuning** — unknown impact, medium benchmark effort/high implementation effort: establish local throughput/RSS measurements while preserving ciphertext integrity and persisted-manifest compatibility.
5. **API-key resolution** — unknown impact, low measurement effort: profile SHA and SQL independently; keep per-request ACTIVE status enforcement and make no cache change absent revocation invalidation.

## 6. Files and changes

- New implementation/benchmark files with `opt-perf-` prefix: **none**. The offline suite measurements did not isolate a request-path performance gain, and no standalone helper would be wired into production without editing leased files.
- Source/test/config changes: **none**.
- Receipt: `coordination/reports/codex-opt-perf-01-request-path-2026-10-02.md`.
- Gates, COMP rows, and commits: **unchanged**.

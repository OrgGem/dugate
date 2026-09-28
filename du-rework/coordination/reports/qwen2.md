# Qwen-2 — Functional Testing Lane (W43-Q2)

**Identity**: Qwen Code v0.24.4, model qwen3.8-flash, cwd `D:\Git\dugate`, handle Orca **`term_4d79e7d3`**.
Đây là lane **Qwen-2 (functional tests, offline)** — KHÔNG phải phiên điều phối. Phiên điều phối là Qwen Code orchestrator
(`term_dd86e46b…`, WAVE-39-ORCHESTRATOR-REALLOCATION.md). (W45-QA-1: handle được ghi tường minh ở đầu báo cáo theo chỉ đạo.)

## 3 dòng đọc được từ §14 (WAVE-39-ORCHESTRATOR-REALLOCATION.md)

1. `**Qwen-2 \`term_4d79e7d3\` (functional tests, offline)**` — roster v3, cycle 82.
2. `Qwen-2 writes and runs offline functional tests (document-core's six actions, recipe variants, profile
   binding/execution pin, fail-closed validation, artifact metadata logic, error taxonomy) and sends
   **\`RUN REQUEST\`** lines for anything needing PostgreSQL/Redis; Agent-6 answers with its existing
   \`RUN REQUEST RESPONSE\` format.`
3. `Its first three tasks: identity+context line, take over \`docs/29\`/\`31\`/\`32\`/\`36\` from the retired
   lane and **re-\`Test-Path\` every path they cite** (this wave already produced a \`[PASS]\` pointing at a
   nonexistent file), and propose its functional-test list keyed row-by-row to \`[ ]\`/\`[~]\` rows **for my
   approval before writing**.`

## Quy chế tôi phải giữ (từ packet onboarding W43-Q2 + §14)

- **Window DB** (PG :5433 db `du_orchestrator_test`, Redis :6380) CHỈ có MỘT holder tên là **antigravity**
  (`term_47a1d44b`, TESTING LANE). Tôi KHÔNG tự claim window. Mọi lệnh cần DB thật phải ghi
  `RUN REQUEST: <lệnh chính xác> | cwd | output literal kỳ vọng | row cần chứng minh` trong report này.
- Tôi được phép TỰ CHẠY và TỰ VIẾT test chức năng **offline** (mock provider, không DB).
- Kết quả phải kèm lệnh + exit code + `Tests: N passed, M total`. Không viết "pass" khi không có output.
  Không gán nhãn FAIL cho suite xanh chỉ vì exit code khác 0 (lớp đó tên là **GREEN-EXIT1**, không phải bằng chứng).
- **Boundary**: không sửa `services/orchestrator/src/**` (Claude Code), `src/app/admin/**` (OpenClaude),
  `packages/worker-sdk|connector-client` (Codex-2), `docs/19` (Codex-2), `tasks/P*.md` (chỉ owner row hoặc coordinator).
- Ngồi ở đâu thiếu bằng chứng thì ghi REQUEST, không tự ý quy kết.

## Việc đầu tiên (3 việc theo thứ tự)

1. [x] Viết report này (identity + 3 dòng §14).
2. [x] Nhận docs/29 + docs/31 + docs/32 + docs/36 từ lane Codex cũ; re-Test-Path mọi đường dẫn cite.
3. [~] Đề xuất DANH SÁCH test chức năng gắn row `[ ]`/`[~]` của `tasks/P*.md` — đã ghi bên dưới, đang chờ/đã trình.

## Việc 2 — Kết quả re-Test-Path (docs/29, 31, 32, 36)

Script: `.qwen/tmp/qwen2-testpath.ps1`, base `D:\Git\dugate\du-rework`.
Exit code 0. **93 đường dẫn → 78 True / 15 False.**

**15 False (phân loại, không xóa dòng):**

| Đường dẫn | Nguồn cite | Disposition |
|---|---|---|
| `tests/integration/artifact-retention.integration.test.ts` | docs/32 Gap 1 (Test A/B) | ABSENT — spec-hypothetical, chưa viết (đúng như spec nói "no tests written"). Chủ platform. |
| `tests/integration/version-drain.integration.test.ts` | docs/32 Gap 2 (Test C) | ABSENT — spec-hypothetical, chưa viết. |
| `businesses/example-review/tests/version-drain.integration.test.ts` | docs/32 Gap 2 (cwd alt) | ABSENT — spec-hypothetical, chưa viết. |
| `tests/integration/operator-routes.integration.test.ts` | docs/32 Gap 3 (Test D, conditional) | ABSENT — chỉ viết nếu operator routes được build. |
| `services/orchestrator/worker.ts` | wave-doc §14 (ngoài 4 docs) | ABSENT — orchestrator không có worker.ts tại đường dẫn này. Không thuộc cite 4 docs. |
| `worker.ts` (du-rework/) | — | ABSENT trong du-rework. Main project có `D:\Git\dugate\worker.ts` (True đã ghi riêng). |
| 9 suite phantom (blob-wire-binary.integration, connector-e2e, connector-real-service, continuation-resume, cross-service-boundary, full-system-e2e, p7-03-extension-deployment, p7-04-generic-admin-profile, bullmq-task-queue — tất cả `.integration.test.ts` trong `tests/integration/`) | docs/36 C2/C6 | ABSENT — đã bị quarantine sẵn trong docs/36 mục 3.3 ("ABSENT – KHÔNG PHẢI BẰNG CHỨNG"); re-verify xác nhận đúng. |

**Kết luận:** không phát hiện phantom MỚI ngoài 9 suite docs/36 đã quarantine. Các cite còn lại của
docs/29/31/32/36 đều True trên disk. Ghi chú độc lập: `du-rework/tools/openapi/validate_openapi.py`,
`tests/isolation/{namespace.ts, concurrent-runner.ps1, validate-baseline-counts đổi thành verify-baseline-counts.ps1}`,
`packages/connector-client/tests/real-service.test.ts` đều tồn tại. `p7-04-profile-assignment.integration.test.ts`
có thật (True) — docs/31 MM-10 ghi "p7-04 file NOT FOUND" là SAI, đã có ghi chú CONFLICT trong docs/29 ledger,
không sửa docs/31.

## Việc 3 — DANH SÁCH test chức năng đề xuất (gắn row `[ ]`/`[~]`)

Trình trước khi viết (theo W43-Q3: không cần duyệt từng cái, nhưng phải trình danh sách trước).
Phương pháp: nghiên cứu source + liệt kê 374 test hiện có để KHÔNG trùng lặp; chỉ nhắm lỗ hổng thật.
Cả hai suite: **offline (mock provider MockTaskContext, zero DB/Redis)**, đặt trong
`du-rework/businesses/document-core/tests/`, chạy bằng `npx jest tests/<file> --runInBand` trong
`du-rework/businesses/document-core` (jest maps @du/worker-sdk→src; không cần build, không chạm dist).

### FT-01 — `six-action-fail-closed-matrix.functional.test.ts` → **P5-10 [~]**
Fail-closed matrix ở mức **handler** (`documentCoreHandlers`) cho cả 6 action. Mỗi action đưa vào
~5-8 input lỗi (thiếu discriminator, variant/type/task/mode không hợp lệ, text >100k, artifact >max,
custom schema lỗi, compare thiếu/trùng side, QA thiếu questions). Với mỗi case assert:
1. code lỗi canonical đúng (error taxonomy: `MISSING_DISCRIMINATOR`, `INVALID_DISCRIMINATOR`,
   `DOCUMENT_TOO_LARGE`, `TOO_MANY_ARTIFACTS`, `INVALID_CUSTOM_SCHEMA`, `CONFLICTING_COMPARISON_PARAMETERS`, v.v.);
2. `retryable=false` (fail-closed, không blind retry);
3. **side-effect audit: zero connector invoke + zero artifact write + zero step checkpoint** (spy
   MockTaskContext) — valid trước khi có side-effect.
**Vì sao functional chứ không phải unit:** `bounded-input.test.ts` chỉ test class `InputNormalizer`
đơn lẻ; `all-variants-e2e` (29 test) chỉ happy-path. Không suite nào chạy handler thật với input lỗi và
kiểm chứng "fail trước khi side-effect" — đây chính là nhánh NEGATIVE của "six-action E2E / facade
parity" mà P5-10 yêu cầu, và khớp cam kết "custom schema reject trước inference", "parser không tự gọi LLM".

### FT-03 — `execution-pin.functional.test.ts` → **P2-02 [ ]** (nhánh PRF, offline slice)
Hành vi **execution pin** phía business: chạy extract/compare qua handler với MockTaskContext đã
được PIN (businessVersion 1.0.0, profileRevision, connectorBindings → connector/rev cố định):
1. provenance/envelope dùng version **đã pin**, không re-resolve theo "version mới có sẵn" giữa chừng;
2. `connector.invoke` đi đúng binding đã pin (slot → connector/revision cố định), không lookup lại;
3. fail-closed: action KHÔNG có trong bindings → deny trước mọi provider call (PRF-01 skip-offline form);
4. profile binding tham chiếu slot/connector không hợp lệ → lỗi rõ ràng, không fallback mù.
**Vì sao functional chứ không phải unit:** pin là thuộc tính xuyên biên (claim snapshot → execute →
finalize). `profile-binding-fixture.test.ts` chỉ test slot derivation tĩnh của `ProfileBindingFixtureClient`;
không có test nào kiểm chứng runtime tôn trọng executionSnapshot đã pin. Đây là offline slice của 2 test
live trong multi-container (version pinning @1522, connector revision pinning PRF-02 @1858) và PRF của P2-02.

### KHÔNG viết (nêu lý do, tránh trùng/ngoài boundary)
- **P3 replay / P4-08**: contract 202→PENDING→replay-pending-no-redispatch đã có
  (`connector.test.ts:96-118`); INVOCATION_UNKNOWN no-blind-retry + timeout→UNKNOWN + classifyFailure
  429/503 đã có (`p8-03-convergence.test.ts:366-434`). Lỗi live P4-08 ("202, không bao giờ SUCCEEDED")
  là **thiếu poll scheduler** (MM-06) phía runtime — KHÔNG offline-test được ở lane tôi, nằm phía
  Codex-2 (worker-sdk) + platform. → RUN REQUEST RQ-2.
- **p4-05 base64 double-wrap**: `blob-store.ts` **không tồn tại** (finding mới: thêm phantom path nữa
  cho docs/30 §4 finding-6). Đường wrap nằm trong orchestrator artifacts hoặc worker-sdk download path
  (CR-13 class, platform/Codex-2) — ngoài boundary của tôi. → RUN REQUEST RQ-3.
- **multi-container 3 fail**: bản chất live stack (DB + Redis + barrier hooks cục bộ của test); invariant
  "replay reuses checkpoint, zero duplicate provider" đã có offline (`checkpoint-replay.test.ts:194`);
  pinning → FT-03 offline slice. → RUN REQUEST RQ-4 cho bản live.
- **bullmq-smoke**: bản chất Redis (BullMQ ADR-05); equivalent offline đã có (`sdk-consumer.test.ts`
  injected QueueConsumer). → RUN REQUEST RQ-1.

### RUN REQUEST gửi antigravity (term_47a1d44b) — ghi trong report, không tự chạy
- **RQ-1** | `REDIS_SMOKE=1 npx jest tests/bullmq-smoke.test.ts --runInBand` | `du-rework/businesses/document-core` |
  kỳ vọng `Tests: 1 passed, 1 total`, exit 0 | row bullmq-smoke (đang FAIL `connect ETIMEDOUT 127.0.0.1:55645`
  — cổng 55645 lạ, nghi race fake-runtime chứ không phải Redis 6380) | cần Redis window.
- **RQ-2** | `npx jest tests/integration/p4-08-sdk-consumer.integration.test.ts --runInBand` | `du-rework/tests/integration` |
  kỳ vọng sau khi có poll scheduler: `Tests: N passed, N total`, exit 0 | P4-08 [ ] (giữ [ ], owner Codex-2).
- **RQ-3** | `npx jest tests/integration/p4-05-artifact-streams.integration.test.ts --runInBand` | `du-rework/tests/integration` |
  kỳ vọng `Tests: 7 passed, 7 total`, exit 0 + tên file gây base64 double-wrap | P4-05 [ ] / CR-13 cls.
- **RQ-4** | `npx jest tests/multi-container-e2e.integration.test.ts --runInBand` | `du-rework/businesses/document-core` |
  kỳ vọng `Tests: 13 passed, 13 total`, exit 0 (pinning + barrier + crash recovery) | P5-10 [~] / P2-02 PRF.
- **RQ-5 (thông tin)** | xác nhận đường dẫn `blob-store.ts` có tồn tại ở đâu đó không (tôi Test-Path = False khắp du-rework).

## Việc 4 — Đã VIẾT + CHẠY offline (W43-Q4, duyệt không từng cái)

Roster v4 áp dụng: tôi giữ **docs/28 + docs/35 + docs/29/31/32/36** (W43-Q5 mở rộng: docs/28 lẫn docs/35 là của tôi — khi suite browser mới xuất hiện tôi ghi nhận vào 2 bảng loại 'BROWSER' cạnh OFFLINE/LIVE_INFRA, chỉ sau khi có kết quả chạy thật); Codex-3 là reviewer — KHÔNG gửi RUN REQUEST cho nó. `tests/browser/**` là của OpenClaude (W47-O).

### Kết quả chạy (cwd `du-rework/businesses/document-core`)

**Lệnh:** `npx jest tests/six-action-fail-closed-matrix.functional.test.ts tests/artifact-metadata.functional.test.ts tests/execution-pin.functional.test.ts --runInBand`
**Exit code: 0** — **Test Suites: 3 passed, 3 total | Tests: 45 passed, 45 total** (2.27s)

| Suite | File (mới) | Tests | Anchor row | Nội dung |
|---|---|---|---|---|
| FT-01 | `tests/six-action-fail-closed-matrix.functional.test.ts` | 35 | **P5-10 [~]** | 6 action × (5-7 case): lỗi input → code canonical (error taxonomy: MISSING/INVALID_DISCRIMINATOR, TOO_MANY_ARTIFACTS, DOCUMENT_TOO_LARGE, PAGE_LIMIT_EXCEEDED, INVALID_PAGE_RANGE, INVALID_CUSTOM_SCHEMA, FORBIDDEN_SCHEMA_REF, SCHEMA_DEPTH_EXCEEDED, MISSING_REQUIRED_PARAMETER, INVALID_ARGUMENT, INVALID_PARAMETER_RANGE, MISSING/AMBIGUOUS/CONFLICTING/INVALID_COMPARISON_SIDE) + fail-closed retryable=false + **side-effect audit: zero connector invoke + zero artifact write + zero checkpoint**. |
| FT-02 | `tests/artifact-metadata.functional.test.ts` | 5 | **P2-03 [ ]** (business ART slice) | Metadata contract qua `artifacts.write` spy: fileName `<action>_result.json`, mime `application/json`, role `output`, sizeBytes === bytes, resultRef `artifact://`, byte-roundtrip fidelity, provenance method/modelSlot, extract = đúng 1 reasoning invoke (no duplicate), local-only = zero invoke, fail-closed = zero artifact. |
| FT-03 | `tests/execution-pin.functional.test.ts` | 5 | **P2-02 [ ]** (PRF slice) | Recipe selection là hàm thuần của discriminator submit (3 profile khác hẳn nhau → cùng recipeId, mọi action); slot routing pin theo recipe (extract luôn reasoning, không re-resolve theo bindings); đổi context presentation giữa 2 run → cùng variant + cùng slot + đúng 1 invoke/run; variant chưa đăng ký → fail-closed explicit, không fallback recipe. |

**Xác nhận strict TS:** `npm run lint` (`tsc --noEmit -p tsconfig.json`) exit 0.

### Ghi chú trung thực
- Toàn bộ offline, mock provider (MockTaskContext), **zero DB/Redis**. Tôi CHỦ ĐỘNG không chạy `jest` cả folder vì `bullmq-smoke.test.ts` probe Redis 6380 — testing lane đang giữ window lúc 00:50; tránh tranh chấp.
- Phát hiện trong lúc viết FT-03: cùng một `ctx` (cùng task), checkpoint replay dedup connector call lần chạy lại (MockTaskContext.step) — replay-safe đúng design, đã có `checkpoint-replay.test.ts:194`. Test của tôi chuyển sang so sánh 2 run trên 2 ctx riêng để không overlap khẳng định đó.
- Không có test mới nào vào `services/orchestrator/src`, `src/app/admin`, `packages/worker-sdk|connector-client`, `docs/19`, `tasks/P*.md` — chỉ thêm 4 file test (3 trong `businesses/document-core/tests/`, 1 trong `services/orchestrator/tests/`).

## Việc 5 — R24-01 (High security: long-poll ?wait= tenant fence) — W43-Q5

**Kết luận rà soát (read-only, source):** R24-01 **ĐÃ được fix trong source bởi Claude Code**:
- `services/orchestrator/src/server.ts:663-679` — route `GET /api/v1/operations/:id` inject `(id) => ctx.runtime.getTenantOperation(id, apiKey.tenantId)` vào `waitForTerminal`; cả read trước poll và mỗi re-read 500 ms đều tenant-scoped.
- `services/orchestrator/src/modules/runtime/runtime.ts:862-865` — `getTenantOperation`: `WHERE id=$1 AND tenant_id=$2` (foreign id = missing, prompt 404, không timing leak).
- Suite real-HTTP riêng đã tồn tại: `services/orchestrator/tests/operation-tenant-fence.test.ts` (foreign terminal/active `?wait=30/10` → prompt 404; flip tenant mid-poll → 404; authorized long-poll → 200 SUCCEEDED) — **CHƯA từng được chạy** (cần DB).
- Các row TODO cũ trong `tasks/REVIEW-FIXES-2026-09-24.md` + note `reports/codex3.md` đều RA ĐỜI TRƯỚC code fix (đã ghi trong `WHOLE-CODE-REVIEW-2026-09-24.md:20`). → blocker "duy nhất còn mở" thực chất là **verification gap**, không phải code gap.

**Proof offline tôi viết + chạy (seam-level, zero DB):**
`services/orchestrator/tests/r24-01-poll-fence-offline.functional.test.ts` — `npx jest tests/r24-01-poll-fence-offline.functional.test.ts --runInBand`
Exit code 0 — **Tests: 5 passed, 5 total** (3.99s): foreign TERMINAL + `wait=30` → prompt 404 (3ms); foreign ACTIVE + `wait=10` → prompt 404 (1ms); flip tenant mid-poll → 404 sau 1 iteration (~1s); authorized → 200 terminal view; `wait=0` clamp floor. `npm run lint` (orchestrator) exit 0.

**Hành động ghi theo W43-Q5:**
- **RUN REQUEST RQ-6 → antigravity:** `npx jest tests/operation-tenant-fence.test.ts --runInBand` | `du-rework/services/orchestrator` | kỳ vọng `Tests: 4 passed, 4 total`, exit 0 + các literal 404 prompt/SUCCEEDED | row R24-01 | cần DB window. Đây là mảnh duy nhất còn thiếu để review kín.
- **REQUEST cho Claude Code: KHÔNG cần fix mới** — code + suite đã có (do chính Claude Code viết). Chỉ còn yarn verify bằng RQ-6. Đính chính premise của coordinator: R24-01 đã chuyển từ "code gap" → "verification pending".

## Việc 6 — Chờ (theo W43-Q5, chưa thực hiện)
1. OpenClaude (W47-O) đang viết browser harness `du-rework/tests/browser/` (package riêng, chromium-only, headless). Khi có `artifacts-summary.json` + `Tests: N passed, M total` + exit code → tôi ghi nhận các suite browser vào **docs/28 + docs/35** với loại **BROWSER** (offline, không cần DB/Redis). Không sửa trước khi có kết quả thật.
   - **[x] HOÀN TẤT tại W43-Q6** — đã ghi nhận vào docs/35 (mục 3.4) + docs/28 (mục 4.7): sections 14/14 PASS exit 0 (axe 0/0/0/0, 31 screenshots, 28 axe scans), interactions 0/4 FAIL (harness-side ×4, zero platform bug). Tổng fleet: **106 suites = 82 OFFLINE + 22 LIVE_INFRA + 2 BROWSER**; passed 1,680 / failed 8 / total 1,688.
2. Sau đó: chạy lại offline inventory (zero DB) trên toàn bộ 82+ suite để xác nhận **không regression**; báo tổng cộng (sum từ từng dòng `Tests:`), không dùng ước lượng.
   - **[x] HOÀN TẤT — xem Việc 8 dưới đây** (batch 07:14–07:19).

## Việc 8 — W43-Q6 Regression offline re-run (07:14–07:19) + tổng cộng

**Lệnh:** `powershell -NoProfile -ExecutionPolicy Bypass -File du-rework\tests\isolation\concurrent-runner.ps1 -Mode Batch -Category Offline`
(cwd `D:\Git\dugate`; manifest tĩnh 82 suite, Category=Live bị loại → **zero DB/Redis**). Runner exit 1 (do 1 suite FAIL).

**Runner literal (đầu ra chính thức):**
```
Filtered suites count: 82 of 104
BATCH EXECUTION SUMMARY
Category: Offline | Suites Total: 82 | Suites Passed: 81 | Suites Failed: 1
Tests Passed Sum: 1469 | Tests Total Sum: 1525
```

**1 suite FAIL (đúng 1):** `services/orchestrator/tests/admin-shell-server.test.ts` — `Tests: 2 failed, 54 passed, 56 total`, Exit 1 (5.05s) **chỉ trong khối batch load toàn bộ**.
- Không tái hiện được: chạy độc lập → `Tests: 56 passed, 56 total`, exit 0 (cùng workdir, lệnh y hệt); chạy cụm (platform-mount + render + router + server) → `Tests: 254 passed, 254 total`, exit 0.
- Git: `du-rework/services/orchestrator/src/server.ts` = M (modified, uncommitted); `admin-shell-server.test.ts` = `??` (untracked) — công việc admin-shell mới của platform, chưa vào baseline docs/35.
- **Phân loại: transient flake dưới tải batch** (cổng-time/state-leak giữa các process), KHÔNG phải regression của Qwen-2, KHÔNG phải regression ổn định của platform. Không dùng làm bằng chứng FAIL; theo dõi ở batch sau (07:02 antigravity chưa về).

**5 OFFLINE suites Qwen-2 mới (63 tests, chạy thật, mỗi suite kèm literal — ghi vào docs/28 §6.2):**
FT-01 35/35 · FT-02 5/5 · FT-03 5/5 (document-core) · r24-01 5/5 (orchestrator) · tests/unit 13/13.

**Tổng cộng thành thật (công thức ghi trong docs/28 §6.3):**
- **111 suites = 87 OFFLINE + 22 LIVE_INFRA + 2 BROWSER** · tests **1,818 passed / 8 failed / 1,882 total**.
- offline total = 1,525 (batch, đã gồm 56 shell-server) + 63 (mới) = **1,588**; passed = 1,469 (gồm 54 shell-server pass) + 63 = **1,532**.
- [FAIL] 8 = 4 live cũ (multi-container 3 + p4-08 1) + 4 browser interactions (harness-side, 0 platform bug). **Không có regression ổn định mới.**

## Việc 7 — W43-Q6 (offline functional BR-05/UC-07 + BROWSER records + ledger confirm)

### (1) docs/35 + docs/28 — lớp BROWSER ✅ (đã ghi, nguồn kết quả thật W47-O11; W43-Q7 cập nhật sang FINAL W47-O12)
- docs/35: addendum tổng số (106 suites) + mục **3.4 BROWSER** (2 suite kèm literal + ExitCode).
- docs/28: Key Metrics (+2 BROWSER), breakdown (+row Top-Level Browser), mục **4.7 Browser Harness**.
- Class BROWSER = offline (không DB/Redis), không dùng làm bằng chứng regression platform (4 interaction fail là harness-side).

### (2) docs/29 — 5 suite trạng thái ANSWERED (kèm literal + ExitCode) ✅
W42-A76 (06:13) đã ghi đủ trong ledger; tôi thêm mục **W43-Q6 Ledger Confirmation** tóm tắt 5 dòng:
p4-05 ANSWERED-PASS `7/7` exit 0 · p4-08 ANSWERED-FAIL `1/1` exit 1 · multi-container ANSWERED-FAIL
`3 failed, 10 passed` exit 1 · bullmq-smoke ANSWERED-PASS `1/1` exit 0 · runtime ANSWERED-PASS `97/97`
exit 0. Batch 07:02 chưa xuất hiện trong antigravity.md (grep trống) → nếu tới sẽ SUPERSEDE. Không xóa dòng.

### (3) tests/unit mới — BR-05 TTL/quota + UC-07 drain (offline functional, zero DB) ✅
Tạo: `tests/unit/jest.config.cjs` + `tests/unit/tsconfig.json` + 
`br05-artifact-ttl-quota.functional.test.ts` (4 test: A-1..A-4, B-1..B-4) +
`uc07-version-drain.functional.test.ts` (5 test: C-1..C-5).
**Lệnh:** `npx jest --config tests/unit/jest.config.cjs --runInBand` (cwd `du-rework`)
**Exit code: 0 — Tests: 13 passed, 13 total** (2 suite, 1.57s).
- BR-05 mỗi test = 1 acceptance condition Test A/B từ docs/32 Gap 1 (sweep EXPIRED unreferenced → xóa;
  checkpoint-referenced → giữ; trong TTL → giữ; READY không bị sweep; quota boundary allow/deny 429
  QUOTA_EXCEEDED; denied = zero orphan row). GRANT_TTL_MS mirror artifacts.ts:23.
- UC-07 mỗi test = 1 acceptance condition Test C từ docs/32 Gap 2 (drain: fail-closed gap → rollback
  pointer về v1; in-flight v2 pin; idempotent activate/deactivate; không ACTIVE → lỗi explicit).
  C-2 viết lại 1 vòng: route phải fail-closed (active-pointer-only, đúng registry.ts + runbook 5),
  "redirect v1" là bước rollback pointer riêng.
- DB twins đã nằm trong docs/29: **RUN REQUEST P0-01-A (-B, -C)** (artifact-retention / version-drain,
  runner testing lane antigravity). Không có test live nào do lane này chạy.

### (4) Không có mục "TOI KHONG LAM GI DUOC" — vẫn còn việc offline (regression batch).

## Việc 9 — W43-Q7 (kết quả thật 08:31 → docs/29 + docs/28/35 FINAL BROWSER; tests/unit re-verify)

### (1) docs/29 — ANSWERED kèm literal + ExitCode ✅ (nguồn `antigravity-6.md` W42-A77/A78, đúng bộ 08:31 của coordinator)
| Suite | Row | Literal + ExitCode |
|---|---|---|
| `operation-tenant-fence.test.ts` | R24-01 (P2-07/P8-04) | `Tests: 4 passed, 4 total`, **0**, 4.48s — **R24-01 real-HTTP VERIFIED** → blocker an ninh cuối ĐÃ ĐÓNG |
| 4-suite regression (blob/ingress/usage/fence) | CR-11/13 + W39-C + R24-01 | `Tests: 26 passed, 26 total`, **0**, 6.98s |
| `p4-05-artifact-streams` | P4-05 | `Tests: 7 passed, 7 total`, **0** |
| `bullmq-smoke` | P4-02 | `Tests: 1 passed, 1 total`, **0**, 3.56s |
| `runtime.test.ts` | P2-04..09 | `Tests: 97 passed, 97 total`, **0**, 10.04s |
| `multi-container-e2e` | P5-10 | `Tests: 3 failed, 10 passed, 13 total`, **1**, 50.62s — R24-02 (L1522/1693/1858) |
| `p4-08-sdk-consumer` | P4-08 | `Tests: 1 failed, 1 total`, **1**, 61.98s — chờ P3 202-replay |

RQ-1..RQ-4, RQ-6 → **RESOLVED** (RQ-2/4 RESOLVED-fail). RQ-5 (blob-store.ts) vẫn OPEN-INFO.
Antigravity xác nhận companion offline `r24-01-poll-fence-offline.functional.test.ts` của tôi.

### (1b) docs/28 + docs/35 — BROWSER layer sang FINAL (W47-O12) ✅
- `interactions.spec.ts` 0/4 → **4/4 PASS exit 0** (2.4s, 05:45:08) sau fix harness-side
  (`harness-server.ts:35` adminToken, `stubs.ts:228` copy-once entries; **zero sửa src platform**,
  không `.skip`, không yếu assertion). P6-07 gate **MET** — sẵn cho coordinator flip [x].
- Sections giữ 14/14 PASS, axe 0/0/0/0 (`artifacts-summary.json` 05:45:26).
- **Tổng final: 111 suites = 87 OFFLINE + 22 LIVE_INFRA + 2 BROWSER; tests 1,822 passed / 4 failed / 1,882 total.**
  [FAIL] 4 = 4 live cũ (multi-container 3 + p4-08 1); hết FAIL harness.

### (2) tests/unit P0-01 (BR-05 TTL/quota + UC-07 drain) — ĐÃ VIẾT, chạy lại xác nhận ✅
`npx jest --config tests/unit/jest.config.cjs --runInBand` → **Exit 0, `Tests: 13 passed, 13 total`**
(2 suite, 0.38s) — 8 test BR-05 (A-1..A-4, B-1..B-4) + 5 test UC-07 (C-1..C-5), mỗi test = 1 điều kiện
acceptance của docs/32 Gap 1 + Gap 2; DB twins: RUN REQUEST P0-01-A/B/C trong docs/29 (đã ghi trước).

### (3) Không có mục "TOI KHONG LAM GI DUOC" — không bị chặn; còn việc chờ bên ngoài (P6-07 flip là quyền coordinator; batch 08:31 đã đối chiếu).

## Việc 10 — W43-Q8 (GUI LAI — ack: 3 việc ĐÃ XONG, re-verify bằng chứng fresh trong turn này)

Coordinator báo qwen2.md "vẫn 07:27" (chưa nhận được bản Việc 9). Xác minh lại từng mục bằng
bằng chứng hiện có (chạy lại + grep, turn này):

1. **docs/29 — ANSWERED 08:31 ✅** — W43-Q7 Ledger Addendum đã ở
   `docs/29-run-request-queue.md:148-171`: mọi dòng ANSWERED kèm literal+ExitCode
   (operation-tenant-fence `4 passed, 4 total` exit 0 · p4-05 `7/7` exit 0 · multi-container
   `3 failed, 10 passed` **exit 1** · bullmq-smoke `1/1` exit 0 · runtime `97/97` exit 0 · p4-08
   `1/1` exit 1). RQ-1..RQ-4/RQ-6 RESOLVED, RQ-5 OPEN-INFO.
2. **docs/28 + docs/35 — lớp BROWSER ✅** — docs/28 §4.7 row 105-106 + Key Metrics/breakdown,
   §6.3; docs/35 §3.4 + addendum W43-Q6/Q6b/Q7: sections `14 passed, 14 total` exit 0 (axe
   0/0/0/0), interactions **`4 passed, 4 total` exit 0** (W47-O12, harness offline, no DB).
   Tổng final **111 suites · tests 1,822 passed / 4 failed / 1,882 total**.
3. **tests/unit P0-01 (BR-05 TTL/quota + UC-07 drain) ✅** — viết xong từ W43-Q6,
   RE-RUN turn này: `npx jest --config tests/unit/jest.config.cjs --runInBand` →
   **Exit 0, `Test Suites: 2 passed, 2 total` · `Tests: 13 passed, 13 total`**. 8 test BR-05
   (A-1..A-4, B-1..B-4) + 5 test UC-07 (C-1..C-5), mỗi test = 1 điều kiện acceptance docs/32;
   DB twins = RUN REQUEST P0-01-A/B/C trong docs/29.

Không có việc nào trong W43-Q8 còn thiếu. Không bị chặn.

## Việc 11 — W43-Q9 (PLAN CHANGES 09-24 + Test-Path sweep toàn docs của tôi)

### (1) docs/36 + docs/31 — mục 'PLAN CHANGES 09-24' ✅
- **docs/36 §7.1**: SEC-OIDC-VAULT-2026-09-24.md — 16 row (SEC-00, ADM-BASE-01..03, OIDC-01..04, VAULT-01..06, SEC-INT-01/02), codex3.md review 09:02; mapping → P2-02/P3-02,05/P6-01,04..06/P8-01..08; gate **G-SEC**; old `[x]` KHÔNG certify.
- **docs/36 §7.2**: DEPLOY-STORAGE-LOGGING-2026-09-24.md — 10 row = 9 dev (DATA-00..05, LOG-01/02, DEP-01) + gate **DATA-INT-01 = G-DATA** (coordinator ghi 9 — đối chiếu plan: 9 dev + 1 gate row); mapping → P2-03/P4-05/P5-10/P8.
- **docs/31**: PLAN CHANGES table (SEC/DATA → MM-01..13 chạm) + ghi chú: cả 2 plan CHỈ cần lớp bằng chứng LIVE_INFRA/BROWSER/multi-container — không có suite OFFLINE mới; không dùng tick cũ làm bằng chứng.

### (2) Test-Path re-sweep 5 docs của tôi (29/31/32/35/36) ✅ — NEW ABSENT = 0
Script `.qwen/tmp/qwen2-testpath-w43q9.ps1`, lệnh chạy + exit 0: **124 path True / 36 False tokens**.
36 False phân loại hết (KHÔNG phantom mới):
- 15 doc-number/tasks-P shorthand (docs/29,31,32,35,36,19,20,22,23,24-27,28,30,34 đều tồn tại; **docs/21 cố ý không tồn tại** — MM-02 ghi `x-absent` đúng; `tasks/P` = P0..P9 đều tồn tại).
- 12 cwd-relative test path (admin-*, blob/ingress/usage, operation-tenant-fence, runtime, p7-03/04, p8-03) — verify lại từng cái = **True** ở package home đúng.
- 9 phantom đã quarantine (docs/35 §3.3 / docs/36) — expected ABSENT, đã labeled "KHÔNG PHẢI BẰNG CHỨNG".
- `blob-store.ts` = bare-filename shorthand (RQ-5 OPEN-INFO), không có trong row bảng nào làm bằng chứng; xác nhận repo-wide không tồn tại (A6) — giữ OPEN-INFO.

**Không có dòng nào của tôi trỏ tới file không tồn tại mà chưa được label ABSENT/x-absent.**

### TRANG THAI (theo W43-Q9 yêu cầu):
`Bảng trong: 5/5 (docs/29,31,32,35,36 đã quét; không phantom mới) · ABSENT mới: 0 (36 False = 15 doc-shorthand + 12 cwd-resolved True + 9 phantom đã-quarantine) · khác: 2 plan mới (SEC-OIDC-VAULT 16 rows G-SEC; DEPLOY-STORAGE-LOGGING 10 rows G-DATA) đã mapping vào docs/36 §7 + docs/31, chưa có suite nào — chờ triển khai, không đổi tick cũ.`

## Việc 12 — W43-Q10 (G-DATA 10 rows erratum + đếm row THỰC 3 board)

### (1) docs/36 §7.2 — G-DATA mapping chính xác 10 rows ✅
Đã sửa: **DATA-00..05 (6) + LOG-01/02 (2) + DEP-01 (1) + DATA-INT-01 (1 = G-DATA) = 10** + erratum (công bố "9" trước đó là SAI).

### (2) Đếm row theo dòng bảng THỰC (script `.qwen/tmp/qwen2-boardcount.ps1`, exit 0)

**P0..P9 = 76 rows (`[ ]`=21, `[~]`=7, `[x]`=48, other=0)** — chi tiết từng file:

| File | rows | [ ] | [~] | [x] |
|---|---|---|---|---|
| P0-business-specs | 6 | 3 | 0 | 3 |
| P1-foundation-contracts | 7 | 2 | 0 | 5 |
| P2-orchestrator | 10 | 3 | 1 | 6 |
| P3-connector | 8 | 0 | 0 | 8 |
| P4-worker-sdk | 8 | 2 | 0 | 6 |
| P5-document-core | 10 | 0 | 1 | 9 |
| P6-admin | 7 | 1 | 0 | 6 |
| P7-extension-proof | 7 | 0 | 3 | 4 |
| P8-release-readiness | 8 | 5 | 2 | 1 |
| P9-business-backlog | 5 | 5 | 0 | 0 |
| (PLAN-MISMATCH-FIXES) | 0 | — | — | — |

(PLAN-MISMATCH-FIXES-2026-09-23.md không có dòng `Px-NN` theo pattern — 0.)

**SEC-OIDC-VAULT = 16 rows, tất cả `[ ]`** (SEC-00, ADM-BASE-01..03, OIDC-01..04, VAULT-01..06, SEC-INT-01/02).

**DEPLOY-STORAGE-LOGGING = 10 rows, tất cả `[ ]`** (DATA-00..05, LOG-01/02, DEP-01, DATA-INT-01; DATA-INT-01 lúc đầu regex của tôi không bắt `DATA-\d+` nên ra 9 → cộng thủ công gate = 10, khớp W43-Q10).

### (3) Ghi trần — so với công bố của coordinator
- Coordinator ghi `P0..P9 (51/8/17)` — **KHÔNG khớp disk (76/21/7/48)**. Khả năng: snapshot cũ hoặc cơ sở đếm khác (51+8+17?/ 8 [ ] + 17 [~]?). Tôi đếm THỰC 76 rows / 21 [ ] / 7 [~] / 48 [x]; nếu coordinator dùng cơ sở khác (ví dụ chỉ P0..P8 = 71, hoặc chỉ đếm [ ]/[~]) xin nêu rõ để đối chiếu.
- SEC 16 ✓ · DEPLOY 10 ✓ (đã đúng sau erratum).
- **Hàng 2 chiều (cross-listed, không tính đúp vào row total):** P4-05/P4-08 xuất hiện ở cả P4-worker-sdk.md lẫn ledger docs/29 (adoption row); DATA-INT-01 vừa là row vừa là gate G-DATA; P2-03/P4-05/P5-10/P8 được DEPLOY plan mapping (tham chiếu, không phải row trùng). Đều đã đánh dấu, không phát sinh double-count trong 76.

## Việc 13 — W43-Q11 (cross-check FINDINGS codex3.md — Test-Path + nội dung)

Phương pháp: trích mọi cite `file:line` trong `coordination/reports/codex3.md`; lần lượt
Test-Path + đọc đúng range (script `.qwen/tmp/qwen2-cx3-dump.ps1` exit 0, dump 362 dòng).
**Kết quả: TOÀN BỘ cite ĐỀU TỒN TẠI (Test-Path=True) + NỘI DUNG ĐÚNG NHƯ MÔ TẢ.** Không phantom,
không lệch dòng dẫn tới hiểu nhầm. KHÔNG sửa gì của CX3/khác.

| # | Finding (SEV) | Cite | Test-Path | Nội dung khớp? |
|---|---|---|---|---|
| 1 | High — SEC-INT order ngược | `SEC…md:25-26,32-36` | True | ✓ :25-26 = SEC-INT-01/02 (INT-02 dep = INT-01, chứa Compose); :32-36 roadmap M4 "INT-01 → INT-02" — đúng claim |
| 2 | High — operator mutation | `SEC…md:17,65-67` + `operation-view-models.ts:360-394` | True | ✓ :67 "viewer/operator không gọi được mutation… bị chặn"; source 360-394 = CANCELLABLE_STATES + canCancel/canResume ("operator", display-only gate) — đúng |
| 3 | Medium — ADM-BASE-02 plumbing | `SEC…md:13,17-18,21-22` | True | ✓ :13 row dep ADM-BASE-01,OIDC-03 + "đổi DB state"; :17-18 OIDC-03/04 |
| 4 | Medium — VAULT-05 dep lệch | `SEC…md:23,83-86` | True | ✓**:23 row chỉ "VAULT-01, VAULT-02"; :83 SEC-05 "Phụ thuộc: SEC-03/04" — MISMATCH đúng như claim** |
| 5 | High — String(err)/redaction | `SEC…md:14,25,97-98` + `server.ts:212-214,263-265` + `redaction.ts:33-39` | True | ✓ server.ts:214 detail = String(err), :263-265 tương tự; redaction.ts:33-39 = 3 pattern (SIGNED_URL/BEARER/AWS_KEY) — đúng. Nuance: plan :25/:98 CÓ nêu sink (DB/Redis/response/log/trace/HTML); "chưa nêu đủ sink" của CX3 là về mức đầy đủ, không phải vắng hoàn toàn |
| 6 | Medium — webhook/metrics/renderer | `webhooks.ts:176-195,203-217` + `metrics.ts:45-55` + `operation-section-renderer.ts:85-95` | True | ✓ webhooks: errMsg=String(err) → persist `last_error`; metrics:45-55 = assertLabels (check KEY + cardinality, KHÔNG value allowlist); renderer:85-86 esc() fileName — đúng |
| 7 | Medium — old [x] không certify | `SEC…md:12-26,36,40` + `P2:8-16` + `P3:8-11` + `P6:11-17` + `P8:11-18` | True | ✓ từng row table đúng range; SEC :40 "Những task P3/P6 đã [x] là baseline cũ, không chứng minh OIDC/Vault" — đúng |
| 8 | Medium — tenant/revoke để SEC-00 | `SEC…md:19,24,44,72,90-92` | True | ✓ :71-72 VAULT-01 (tenant-owned/shared theo "đã duyệt"); :90-92 SEC-06 in-flight "theo policy" — chưa 1 expected outcome duy nhất — đúng |
| 9 | W43-R8/1 M — POST→handleSectionGet | `shell-router.ts:350-355,903-917` | True | ✓ :915-916 default branch: mọi section (kể cả POST) → `handleSectionGet` — đúng EXACT |
| 10 | W43-R8/1 M — VAULT writer không cần OIDC-03 để dev | `SEC…md:21,23,77-86` | True | ✓ :21 VAULT-03 dep gồm OIDC-03,ADM-BASE-03; :77 "Phụ thuộc: SEC-02/03"(SEC-04) — đúng |
| 11 | W43-R8/1 High — fixture trước INT-01 | `SEC…md:25-26,94-98` | True | ✓ (trùng #1) :96 "Phụ thuộc: SEC-01..06", không có fixture ordering — đúng |
| 12 | W43-R8/3 High — shell raw exception | `shell-server.ts:170-177,300-309` | True | ✓ :177 `res.end('Internal error: ' + (message ?? String(err)))` — đúng |
| 13 | W43-R8/3 High — UI raw error message | `connector-section-data.ts:400-404` | True | ✓ :404 `'Network error…: ' + (message ?? String(err))` — đúng |
| 14 | W43-R8/3 M — artifact filename/input persist | `operation-section-renderer.ts:84-86` + `submission.ts:150-180` | True | ✓ renderer esc() only; submission:164 JSON.stringify(input) lưu input_ref + :174-179 submit_artifacts verbatim — đúng |
| 15 | W43-R8/3 M — usage/outbox/connector sinks | `usage.ts:82-84` + `metrics.ts:45-55` + `submission.ts:191-209` + `repository.ts:71,84,226` | True | ✓ usage INSERT payload JSON; submission outbox INSERT payload JSON; repository :71 request / :84 result / :226 revision config JSON.stringify+credentialRef — đúng (CX3 tự label "potential sink, chưa phải leak hiện hữu") |
| 16 | SSE không tồn tại | grep `text/event-stream\|EventSource` trong `services/**/*.ts` | — | ✓ **0 matches** — đúng claim (SSE là future-out, không phải leak hiện hữu) |
| 17 | W43-R8/2 — six PLATFORM REQUESTS | `openclaude.md:1138-1159,1208-1225` | True | ✓ :1138-1159 = 6 group (8 routes); :1208-1225 = ADM-BASE-01 addendum (CR-12/MM-02, Edit 1+2 DONE) — đúng |

**Kết luận:** 17/17 cite verified (16 file-cite True + 1 SSE negative). Codex3.md KHÔNG có phantom
đường dẫn; các finding đều bám source thật. Nuance duy nhất (#5): "chưa nêu đủ sink" — plan có
nêu sink ở :25/:98; điểm CX3 muốn là mức đo đầy đủ/mỗi sink kiểm được, phần String(err)/redaction
hạn chế thì source xác nhận.

## Việc 14 — W43-Q12 (CR-12 RESOLUTION 10:11 → docs/36 §8; DEPLOY=9 trong wave doc; codex3 R11/R12)

### (1) docs/36 — mục 'CR-12 RESOLUTION 10:11' ✅ (mục §8 mới)
Ghi đủ bản ghi C (claude.md:1 ~10:11): root cause **fixture-level** — (a) `INSERT INTO artifacts`
thiếu `token_mode`/`token_expires_at` → NULL → route fail-closed **403** tại `server.ts:509-517`
(hành vi ĐÚNG); (b) PUT+GET dùng chung 1 token, bất khả thi sau CR-12 (grant = upload XOR download).
Fix chỉ trong test của C: fixture thêm upload-mode + expiry; helper `rotateGrant(mode)`; blob GET
dùng token download. **Code Edits 1-4 DONE** (0008+0009 migrations, artifacts.ts, runtime.ts
completion gate + parseOutputArtifactIds, server.ts result refs + public download); **tsc exit 0**.
Chưa re-run live (RUN REQUEST → A6).

### (2) Wave doc §14/PLAN CHANGE 2 — **VẪN GHI DEPLOY=9 (SAI vs 10)**
`coordination/WAVE-39-ORCHESTRATOR-REALLOCATION.md:2652` ghi "**9 tasks**, role-roster ownership:"
và `:2672` ghi "**`DEPLOY = 0/0/9`**". Đối chiếu plan thực = **10 rows** (6 DATA + 2 LOG + DEP-01 +
DATA-INT-01 = G-DATA). Đây là log của coordinator — tôi **KHÔNG tự sửa**, chỉ báo: cần coordinator
sửa `:2652` (9→10, thêm DATA-INT-01 = G-DATA) và `:2672` (`0/0/10`).

### (3) codex3.md R11/R12 (C review CR-12) — **KHỢP với C và A6** ✅
- **Khớp C**: root cause fixture-level, fail-closed NULL-mode là đúng (CX3 xác nhận qua source:
  `migrations/0008:7-8` additive; `artifacts.ts:77-82` ghi mode/expiry cùng INSERT; `server.ts:509-517`).
- **Khớp A6**: counts (blob-wire 4/1, ingress 3/5) + core NULL-mode explanation khớp
  (antigravity-6.md:5318-5331).
- **Chính xác hóa 1 điểm**: "3 PUT receive 403" của A6 hơi thừa — case oversize
  (`ingress-bounded.test.ts:244-261`) fail do **test-order contamination** (`before.rowCount=0`),
  cần seed blob độc lập.
- **Finding MỚI (High, R11)**: CR-12 finalize thiếu `taskId/leaseEpoch` trong typed contract
  (`contracts/runtime.ts:202-206`, `worker-sdk/task-context.ts:398`) → service substitute `art.taskId`,
  không gọi `assertLease` → có thể finalize sau lease loss nếu state ≠ FAILED/CANCELLED
  (`artifacts.ts:104-125,141-146`, `server.ts:467-472`). Owner: Platform + Worker SDK/contracts.
- **BOUNDARY**: đây là scoped-grant fix, không phải ART-02/S3 (bytes vẫn vào `artifact_blobs`;
  G-DATA vẫn là gate production riêng) — CX3 đồng ý, không phải conflate CR-12 với G-DATA.

**Evidence pending (chưa có):** re-run live 3-suite (blob-wire/ingress/p4-05) với literal `Tests:`
+ exit code để khôi phục acceptance — coordinator cần nhận RUN REQUEST từ C/A6.

## Việc 15 — W43-Q13 (4 suite CR-12/13 ANSWERED green 10:24 + 3-nguồn CR-12)

### (1) docs/35 + docs/29 — đánh dấu 4 suite ANSWERED green 10:24 ✅
- **docs/35**: row 16 `blob-wire-binary` **5/5 → `8 passed, 8 total`** (W42-A90 10:24, exit 0, 4.08s, CR-12 tests); addendum **W43-Q13** ghi 4 suite (blob-wire 8/8 · ingress 8/8 · usage 9/9 · p4-05 7/7 — **32 passed/32 total, 0 failed, 0 GREEN-EXIT1**), 3 suite GREEN-EXIT1 cũ → **[PASS] exit 0** vĩnh viễn.
- **docs/29**: A6 tự ghi sẵn **W42-A90 ledger (10:24)** 4-row ANSWERED-PASS + **W42-A86 RESOLVED luôn RQ-5** (blob-store.ts = phantom, Test-Path False toàn repo). Tôi thêm note ack (không duplicate): CR-12 CLOSED, RQ-5 RESOLVED, hàng đợi CLEAN, P0-01-A..D spec-hypothetical đúng, C đang ADM-BASE-01.

### (2) TRANG THAI 3 nguồn CR-12 (C / A6 / CX3)

**TRANG THAI: KHOP** — cả 3 nguồn nhất trí về CR-12:
- Root cause **fixture-level** (NULL `token_mode` → 403 fail-closed ĐÚNG): C (claude.md:1) → A6 (A90 verbatim "thêm token_mode='upload' + rotateGrant đã giải quyết 100% 403") → CX3 (R12: "A6 counts + core NULL-mode explanation match source").
- Fix **test-only** (fixture INSERT + rotateGrant; không sửa fail-closed production): cả 3 khớp.
- Re-run **10:24 green exit 0** (32/32): A6 A90 literal; CX3 "need passing rerun before restoring acceptance" → ĐÃ có.

**2 delta bổ sung (bổ chứ không mâu thuẫn verdict):**
1. **Precision A6 (CX3 R12)**: cụm "3 blob PUT receive 403" — case oversize (`ingress-bounded:244-261`) fail do **test-order contamination** (`before.rowCount=0`), không phải 3 route-fail trực tiếp; counts không đổi.
2. **Finding OPEN (CX3 R11 High)**: CR-12 finalize **vắng `taskId/leaseEpoch` trong typed contract** (`contracts/runtime.ts:202-206`, `worker-sdk/task-context.ts:398`; `artifacts.ts:104-125,141-146`, `server.ts:467-472`) → C **chưa xử lý** (note của C: Edit-4 surface "NO live coverage yet"; RUN REQUEST artifact-grant-fencing + tenant-fence vẫn pending A6; không nhắc typed contract). Owner đề xuất: Platform + Worker SDK/contracts.

**Boundary:** CR-12 = scoped-grant fix (không phải ART-02/S3); G-DATA vẫn gate production độc lập (CX3 đồng ý). Evidence Edit-4 (0009 submit_artifacts, runtime completion gate, result refs + public download, tsc 0) mới có cho tới RUN REQUEST pending — chưa live-proven.

## Việc 16 — W43-Q14 (A90 ANSWERED giữ nguyên; A91/A92 QUEUED Admin routes; CX3 review ADM-BASE-01 = CHỜ)

### (1) docs/29 + docs/35 — A90 + A91/A92 ✅
- **docs/29**: block W43-Q14 — A90 ANSWERED-PASS 10:24 (giữ nguyên, 32/32); **A91 QUEUED — NO DB USED**
  (C đang build ADM-BASE-01, 6 routes, claude.md 10:32); **A92 QUEUED — NO DB USED - CHO C** (6 commands
  pre-staged: businesses/:id/versions, profiles/:b/:v/:name, connectors/:id/revisions/:rev, api-keys,
  operations/:id, admin/audit). RUN REQUEST của C (artifact-grant-fencing + tenant-fence) + 6-route pending.
- **docs/35**: addendum W43-Q14 — 6 route GET = PLATFORM REQUEST groups ADM-BASE-01, **chưa có literal/exit
  code → KHÔNG thêm hàng bảng chuẩn** cho 6 route này tới khi có kết quả thật.

### (2) CX3 review ADM-BASE-01 của C — **CHO CT** (chưa có)
- codex3.md mới dừng ở R11/R12 (review CR-12; xác nhận ADM-BASE-01 như expectation:
  "8 GET endpoints in six groups... then prove all live pane fetches" — W43-R8/2) và R13/R14 **CHƯA tồn tại**.
- Không có ghi chú review nào của CX3 về bản build ADM-BASE-01 của C (C đang xây, chưa nộp RUN REQUEST) →
  **TRANG THAI: CHO CT** (CX3 sẽ review khi C nộp).

**Anti-stall:** không bị chặn; còn việc chờ bên ngoài (C nộp build ADM-BASE-01 + RUN REQUEST; CX3 review;
A6 chạy A91/A92) — tôi không có việc offline mới trong tầm tay ngoài theo dõi đã ghi ở trên.

## Việc 17 — W43-Q15 (stale-count fix + A96: ADM-BASE-01 VERIFIED / R24-02 KHÔNG done)

### (1) docs/35 — 3 stale counts đã sửa theo W48-O3/O5 ✅ (bằng chứng rerun khớp chính xác)
- Row 76 `admin-shell-platform-mount`: `14→37` (drift +23) — bằng offline batch của tôi (07:19) và A94 12:22.
- Row 77 `admin-shell-render`: `59→136` (drift +77) — khớp batch.
- Row 79 `admin-shell-server`: `25→56` (drift +31) — khớp batch. [PASS] không đổi; chỉ TỔNG cập nhật.
- **Cộng +131 = đúng gap 1,394→1,525** (baseline docs/35 ↔ batch) → bảng 3.1 nay KHỚP rerun, mâu thuẫn sum tiềm tàng ĐÃ ĐÓNG (ghi docs/36 §9).

### (2) docs/29 + docs/35 + docs/36 — 2 sự thật A96 (12:43→12:48) ✅
- **ADM-BASE-01 6/6 routes VERIFIED LIVE**: `admin-base-routes.test.ts` `7 passed, 7 total` exit 0 (Test-Path True) — data THẬT, zero fake-pane, OpenClaude UNBLOCKED; + `artifact-grant-fencing` 10/10 exit 0 (A95), `operation-tenant-fence` 4/4 exit 0 (A93/A95).
- **R24-02 KHÔNG done — 3 fail**: multi-container full `3 failed, 10 passed, 13 total (0 skipped)` exit 1, 50.235s (L1485 pinning 1.1.0≠1.0.0; L1656 crash lease null; L1821 PRF-02 barrier 15s). P5-10 giữ [~].
- **Nghịch lý ghi nhận thẳng thắn**: A95 claim "R24-02 VERIFIED" từ `1 passed, 12 skipped` — trái quy tắc
  skip-escape (docs/35 §4 / docs/36 §1.4); phán quyết đúng = A96 full-suite. Đã ghi docs/29 (W43-Q15
  Ledger Flags) + docs/36 §9 + docs/35 addendum W43-Q15.

### (3) Test-Path các path mới thêm ✅
`admin-base-routes.test.ts` · `artifact-grant-fencing.test.ts` · `operation-tenant-fence.test.ts` · 3 file
admin-shell-* · `qwen3.md` · `openclaude.md` — **8/8 True** (exit 0).

**Tổng fleet cập nhật (docs/35 addendum W43-Q15): 112 suites = 87 OFFLINE + 23 LIVE_INFRA + 2 BROWSER ·
tests 1,829 passed / 4 failed / 1,889 total.**

### TRANG THAI (W43-Q15):
`docs/35 stale rows 76/77/79 = ĐÃ SỬA (14→37, 59→136, 25→56; +131 khớp batch 1.525); ADM-BASE-01 6/6 VERIFIED LIVE 7/7 exit 0 (A96); R24-02 KHÔNG done — 3 fail, 0 skipped, exit 1 (đã đánh dấu docs/29+35+36); Test-Path path mới 8/8 True; A95-vs-A96 skip-escape contradiction đã ghi trần; tổng 112 suites · 1.829/4/1.889.`

## Việc 18 — W43-Q16 (re-broadcast ownership: Codex-2 = services/connector; P4-08/MON-06/MM-07; skip rule)

### (1) docs/31 ✅
- **MM-06/MM-07**: cell owner đổi thành `connector (Codex-2 — W43-Q16) + platform(+sdk)` — invoke.ts:52 PENDING / invoke.ts:42-59 states nằm trong `services/connector` mà Codex-2 nay sở hữu.
- Block **W43-Q16 OWNERSHIP RE-BROADCAST**: P4-08 `owner = Codex-2, connector-poll in progress` (fail do RUNTIME thiếu poll — 202→PENDING không ai đánh thức — KHÔNG còn lỗi biên dịch; TS2345 cleared, docs/34 done).

### (2) docs/29 ✅
Block **W43-Q16 — PENDING RUN REQUEST p4-08**:
`RUN REQUEST: npx jest tests/integration/p4-08-sdk-consumer.integration.test.ts --runInBand --forceExit` (13/13 executed, không skip) | cwd `du-rework/tests/integration` | literal kỳ vọng `Tests: 13 passed, 13 total`, Exit 0 | row **P4-08 [ ]** (kèm nghiệm thu MM-06/MM-07) | **routing: antigravity term_47a1d44b** — điều kiện phát: Codex-2 nộp fix + ghi RUN REQUEST trong reports/codex2.md. Không tự chạy live.

### (3) Skip rule connector-client ✅ (ghi docs/31 + docs/29)
`packages/connector-client` offline = `Tests: 1 skipped, 19 passed, 20 total` exit 0 — **SKIP KHÔNG tính pass**
(luật fleet, như R24-02/A95-A96): test thứ 20 `real-service.test.ts:152` (gate `CONNECTOR_INTEGRATION=1`)
**VẪN MỞ** ở offline; bằng chứng chỉ hợp lệ khi gated-live (A72 từng 1/1 exit 0 — chạy lại nếu cần, qua window antigravity).

### (4) docs/35 row 22 — owner note W43-Q16 ✅. Test-Path path mới: **5/5 True**
(p4-08 suite · real-service.test.ts · sdk-invoker.test.ts · services/connector/src/invoke.ts · docs/34).

### TRANG THAI (W43-Q16):
`docs/31 = MM-06/MM-07 gắn connector (Codex-2) + P4-08 owner/driver-poll đánh dấu xong · docs/29 = PENDING RUN REQUEST p4-08 13/13 no-skip routing antigravity term_47a1d44b (chờ Codex-2 nộp fix) · connector-client 19/1 SKIPPED = skip KHÔNG tính pass, test 20 vẫn MỞ offline · docs/35 row 22 owner note · Test-Path mới 5/5 True · tổng fleet giữ 112 · 1.829/4/1.889.`

## Việc 19 — W43-Q17 (SKIP≠PASS systematization + cột Skipped docs/35)

### (1) docs/35 — cột Skipped + quy tắc §1.4 ✅
- Script `.qwen/tmp/qwen2-skipcol3.ps1` (restore-clean → cell-split, idempotent): **3 headers + 106 data rows** có cột `Skipped` (tính từ literal: explicit `N skipped` hoặc `total−passed−failed`).
- **§1.4 mới:** `[PASS]` ⇔ `passed==total ∧ skipped==0 ∧ failed==0 ∧ exit 0`; `skipped>0` → **`[SKIP-QUALIFIED]`, không tính bằng chứng**. Backup cũ ở `.qwen/tmp/35-backup-w43q17.md`.
- Trung thực quá trình: pass-1 lỗi regex (thiếu `\s*` trước backtick → 0 rows), pass-2 lỗi idempotency-guard (exit cell bare `| 0 |` bị nhận nhầm là cột skipped → 97 rows bỏ qua); pass-3 restore + cell-split đúng. Không lần nào làm mất dữ liệu (luôn có backup + verify).

### (2) Row multi-container (P5-10/R24-02) ✅ — ghi cả hai mặt
- **A97 Lệnh 4 FULL RUN: `Tests: 13 passed, 13 total`, exit 0, 6.116s, 0 skipped** → row 20 `[PASS]` hợp lệ theo §1.4; 3 fail lịch sử đã xanh sau Q3 fix; **reconcile P5-10 [x] = quyền coordinator** (row ghi rõ 'chờ reconcile').
- **A95 (12:35) + A97 Lệnh 1/2/3 (focused `-t`)** `1 passed, 12 skipped` = executed 1/13 → **`[SKIP-QUALIFIED]` — CHƯA bằng chứng**, đúng marker W43-Q17; cấm gọi là "PASS/VERIFIED".
- **LECH với packet W43-Q17 (ghi để route):** packet quy "A97 đề nghị reconcile [x] trên 1/13 executed"; nguyên văn A97 §1/§4 cho thấy handoff reconcile dựa trên **Lệnh 4 full-run 13/13 exit 0**, các dòng 1/13 là 3 lệnh focused bổ trợ. Pattern 'skip báo như pass' CÓ THẬT (A95 + nhãn "PASS" của 3 lệnh focus) nhưng nền tảng reconcile hiện có một literal hợp lệ — quyết định là của coordinator. docs/36 §10 ghi bảng 3 instance.

### (3) docs/36 §10 + docs/29 W43-Q17 ✅
docs/36 §10 "SKIP ≠ PASS": bảng 3 instance (A95 / A97-L1..3 / A97-L4) + quy tắc thường trực áp dụng cả 4 bảng.
docs/29: block W43-Q17 — từ giờ mọi ANSWERED phải kèm Skipped=0 tường minh; hàng rào cho ledger mới.
KHÔNG sửa báo cáo A6/Q3 (đúng chỉ đạo — coordinator route).

### (4) Test-Path re-sweep ✅ — 130 True / 42 False; **NEW ABSENT = 0**
6 False tăng thêm so với W43-Q9 (124/36) đều là dạng **cwd-relative** của các file tôi đã verify True bằng full path hôm nay (`admin-base-routes` · `artifact-grant-fencing` · `operation-tenant-fence` · `real-service`); còn lại = buckets cũ (15 doc-shorthand, 12 cwd-resolved, 9 phantom-quarantine, docs/21 x-absent).

### TRANG THAI (W43-Q17):
`docs/35 = cột Skipped vào 3 bảng (106 rows, pass-3 sạch; 2 pass lỗi của tôi đã sửa, có backup) + quy tắc §1.4 PASS⇔skipped=0 · row 20 multi-container = [PASS] theo A97-L4 full-run 13/13 exit 0, các claim 1/13+12skip = [SKIP-QUALIFIED] CHƯA bằng chứng · docs/36 §10 + docs/29 hàng rào đã ghi · LECH packet: A97 reconcile dựa trên L4 full-run, không phải 1/13 — coordinator quyết · Test-Path 130/42, NEW ABSENT 0 · fleet 112 suites · 1.832 passed / 1 failed / 1.889 total (chỉ còn p4-08 fail).`

## Việc 20 — W46-Q2-1 (P5-10 fixtures grant; **giờ thật 2026-09-24 17:52 +0700**; handle `term_4d79e7d3`)

Báo cáo này mở đầu bằng danh tính + handle theo chỉ đạo: **Qwen-2, Qwen Code v0.24.4 / qwen3.8-flash, `D:\Git\dugate`, Orca handle `term_4d79e7d3`, lane functional-tests offline — không phải phiên điều phối.** Row P5-10 **giữ [~], KHÔNG tick** (reconcile = quyền coordinator).

### (1) Ba bước W46-Q2-1 — kết quả
- **Bước 1 (sửa 2 fixture lấy + gắn signed grant thật): hoàn tất trên disk, TUYÊN BỐ MINH BẠCH** — khi tôi tới bước áp edit (17:5x), bản vá ĐÃ HIỆN DIỆN trong `multi-container-e2e.integration.test.ts` (file tăng 2233→2248 dòng giữa hai lần đọc của tôi; 3 edit-attempt của tôi bị chặn bởi guard "chưa đọc lại" và tôi KHÔNG ghi đè). Tôi **thẩm định** thay vì sửa lại: helper `signedInvocationGrant` tại :730 đọc `SELECT request, input_hash FROM connector_invocations WHERE invocation_id=$1`, bind đúng 8 claims + `exp/iat`, HMAC `grantSecretBytes` (cùng secret với `HmacSignedGrantSource` :481→composition), payload khớp `InvocationGrantClaimsSchema` (`.strict()`, packages/contracts/src/connector.ts:86-104); 2 call-sites :959/:1001 nay gửi `x-invocation-grant` VÀ có thêm **assertion fail-closed 403 trước 200** (tốt hơn yêu cầu). Compile sạch: `npm run lint` (tsc --noEmit, document-core) **Exit 0** lúc 17:52.
- **Bước 2 (không nới lỏng auth):** `services/connector/src/services.ts` — tôi KHÔNG đụng; git status ` M` là của Codex-2 (poll/grant work). `authorizeInvocation` (services.ts:121-127) vẫn bắt buộc grant; đúng chỉ đạo.
- **Bước 3 (không mở DB):** đã ghi **RUN REQUEST canonical** vào docs/29 (W43/W46 block cuối file) route **Agent-6/antigravity `term_47a1d44b`**: `npx jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit` (không `-t`), kỳ vọng `Tests: 13 passed, 13 total` 0 skipped/0 failed ExitCode 0 kèm từng dòng `√ test (ms)`.

### (2) Literal nguyên văn tôi từng đưa (W43-Q17, A97-L4) — sao chép đầy đủ theo chỉ đạo
Lệnh (antigravity-6.md, A97 "Giai Đoạn B"):
```powershell
pnpm --dir du-rework/businesses/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --forceExit
```
Literal: `PASS tests/multi-container-e2e.integration.test.ts (5.886 s)` + 13 dòng `√` (times 3ms→833ms) + `Test Suites: 1 passed, 1 total` / `Tests: 13 passed, 13 total` / `Time: 6.116 s`; **ExitCode 0** (A97 §1 ghi "PASS TUYỆT ĐỐI ... ExitCode 0").
**BỊ SUPERSEDE:** run full sau đó = `11 passed, 2 failed, 13 total`, ExitCode 1 (CX3 17:38, codex3.md:245 dẫn antigravity-6.md:6640-6661,6672-6695) — connector-enforcement (grant bắt buộc cho GET) vào SAU A97 nên 2 GET cũ của fixture 403. docs/35 row 20 đã hạ về **[FAIL]** theo run verify gần nhất; addendum đính chính tổng: **1,830 passed / 3 failed / 1,889 total**.

### (3) Chặn — NÊU RÕ
**Blocker duy nhất còn lại = `canonical-full-rerun-multi-container` nằm ở phía Agent-6** (cần cửa sổ DB :5433/Redis :6380; Qwen-2 không được mở DB). Không có việc offline nào còn treo cho packet này sau khi RUN REQUEST đã queue.

## Việc 21 — W46-Q2-2 STEER (tuyên bố Qwen-3 sở hữu file multi-container)

**Giờ thật: 2026-09-24 ~18:2x +0700. Danh tính: Qwen-2, handle Orca `term_4d79e7d3` (term_12224548 = Qwen-3, chủ quyền duy nhất của `businesses/document-core/tests/multi-container-e2e.integration.test.ts`).**

**Các dòng tôi ĐÃ THAY ĐỔI trong file đó: KHÔNG CÓ (0 dòng, 0 byte).** Chuỗi事件 minh bạch:
1. Phiên W46-Q2-1, tôi đọc file (2233 dòng, trạng thái CHƯA có grant-header tại :952/:988).
2. Tôi soạn 3 edit (helper `signGrantFromLedger` + 2 call-site) — **cả 3 bị tool guard từ chối** ("file has not been read in this session") trước khi ghi bất kỳ byte nào.
3. Re-read: file đã thành 2248 dòng với helper `signedInvocationGrant` (:730) + 2 call-site đã vá (:959/:1001) — bản vá của lane khác (Qwen-3/coordinator) vào giữa hai thao tác của tôi. Tôi chuyển sang THẨM ĐỊNH, không ghi đè, không revert.
4. Từ thời điểm đó tới giờ: **tôi không mở-ghi file đó lần nào nữa**. Tuân thủ steer tuyệt đối.

## Việc 22 — W46-Q2-3 (P4-05 clause ART-02 transfer từ Codex-2 `term_50c6a1ed` → Qwen-2; ĐỒNG Ý nhận, coordinator lưu §14)

**Giờ thật: 2026-09-24 18:22 +0700. Boundary tôn trọng: CHỈ `packages/worker-sdk` (src + tests).**

### (1)+(2) Dòng quyết định xóa + guard
- Vị trí cũ: `artifact-streams.ts` nhánh `if (now - st.mtimeMs > olderThanMs) { await rm(...) }` — đúng như packet: **chỉ TTL 2h**.
- Sau sửa (cùng file, nay ~518 dòng):
  - `const liveWorkspaces = new Set<string>()` (module) — `createTempWorkspace` đăng ký dir, `dispose` hủy đăng ký.
  - `SweepStaleWorkspacesOptions` thêm `hasActiveReference?: (dir) => boolean | Promise<boolean>` (hook cho nguồn reference metadata/checkpoint phía caller — SDK vẫn DB-free).
  - Nhánh xóa: `liveWorkspaces.has(full)` → KEEP; `await opts.hasActiveReference(full)` true → KEEP; chỉ orphan thật mới `rm`.
- `worker.ts:193` (call site) KHÔNG đổi — hook chưa wire vì cần runtime endpoint hỏi "workspace này còn active checkpoint/metadata tro toi khong" (thuoc domain khac). **REQUEST:** coordinator ghi REQUEST wire-hook cho Codex-2/Claude Code khi contract runtime có endpoint reference; hiện tại in-process guard + hook đã chặn 100% xa tai trong pham vi SDK.

### (3) Test offline mới (temp dir thật, zero DB)
`packages/worker-sdk/tests/artifact-sweep-guard.test.ts` — 4 case: orphan quá TTL → bị don; con active reference (hook true) → VAN SON (khi ca 2 dir cung qua TTL, chi orphan bi don); live workspace cua chinh process (backdate mtime) → khong bao gio bi don, va that sau dispose; non-SDK prefix → khong bao gio cham.

### (4) Lệnh + literal đầy đủ
- `npx jest tests/artifact-sweep-guard.test.ts --runInBand` (cwd `packages/worker-sdk`) → **Tests: 4 passed, 4 total | 0 skipped | 0 failed | ExitCode 0** (2.296s, 18:18:05 +0700).
- Regression toàn package: `npx jest --runInBand` → **Test Suites: 7 passed, 7 total | Tests: 124 passed, 124 total | 0 skipped | 0 failed** (18:22, ExitCode 0). Lần chạy ĐẦU có 1 fail tại `artifact-streams.test.ts` — case sweep cũ dùng **live workspace** làm "stale" (encode đúng hợp đồng TTL-only CŨ); tôi sửa fixture tối thiểu thành planted orphan (giữ nguyên 100% chủ đích test: crashed-worker dir), vì guard mới chủ đích thay đổi hợp đồng đó theo packet. Sau sửa: xanh toàn bộ.
- `npm run lint` (tsc --noEmit) → ExitCode 0.
- Row **P4-05 clause ART-02: vẫn [~], KHÔNG tick** — phần ART-02 wire-hook live và acceptance integration (P0-01-A retention) còn chờ; literal offline này là bằng chứng clause guard, không phải toàn bộ P4-05 acceptance.

## Việc 23 — Kiểm tra blocker (yêu cầu direct của coordinator, ~19:35; Qwen-2 / `term_4d79e7d3`)

| Blocker | Trạng thái | Bằng chứng (literal + ExitCode) |
|---|---|---|
| Canonical full re-run multi-container (P5-10/R24-02) | **XONG — ĐÃ RESOLVED, RESULT PASS** | W46-A6-7 (18:04:10→18:04:30): `Tests: 13 passed, 0 skipped, 0 failed, 13 total`, Exit **0**, 6.873s — docs/29 đã đánh dấu RESOLVED, docs/35 row 20 → [PASS]. P5-10 vẫn [~] (quyền reconcile coordinator). |
| RUN REQUEST p4-08 (poll fix) | **XONG — ĐÃ RESOLVED, RESULT PASS** | W42-A98 13:52 + A99 14:44: `Tests: 1 passed, 1 total`, Exit **0**, 0 skipped (Codex-2 đã nộp provider-poll). docs/35 row 22 → [PASS]; P4-08 vẫn [ ] chờ reconcile. **Tự phê: spec "13/13" của tôi ở W43-Q16 là nhầm suite (p4-08 chỉ có 1 test) — đã sửa ngay trong docs/29.** |
| Wire-hook ART-02 | **ĐÃ ROUTE, KHÔNG PHẢI CỦA TÔI** | Wave cycle 257/263: parked → phát cho Claude Code như W47-C1 (18:44). |
| CX3 review ADM-BASE-01 (C) | **VẪN MỞ — CHO CT** | `codex3.md` dừng ở 253 dòng (W45-CX3-2); không có section R13/R14 nào. |
| Hàng đợi của tôi | **CLEAN** | Không còn RUN REQUEST pending nào chưa trả lời; docs/29 blocks của tôi đều mang nhãn RESOLVED. |

Việc sửa đồng bộ nhân check: docs/29 (2 block RESOLVED + đính chính form-lệnh A6-9), docs/35 (row 20, row 22, addendum W46-Q2-4: **113 suites · 1,837 passed / 0 failed / 1,893 total** + danh sách TỒN KHO CHƯA KHAI 8 suite mới của lane khác, trong đó `admin-shell-live-pane` 0/1 FAIL là finding G-ADMIN-OPS của Claude Code, NOT mine; `services/orchestrator/tests/usage-projection.integration.test.ts` FILE MISSING — đừng cite).

## Việc 24 — W47-Q2-4 Thống kê đối chiếu disk-vs-ledger (giờ thật 2026-09-24 20:34 +0700; Qwen-2 / `term_4d79e7d3`)

Script: `.qwen/tmp/qwen2-reconcile-w47q24.ps1` (ASCII pass-2; du-rework recursive, loại node_modules/dist/playwright-report/test-results; khớp suffix cho cite cwd-relative). Lệnh: `powershell -NoProfile -ExecutionPolicy Bypass -File .qwen\tmp\qwen2-reconcile-w47q24.ps1` → Exit 0.

**TỔNG ĐẾM ĐƯỢC:**
| Loại | Số | Ghi chú |
|---|---:|---|
| File test thật trên đĩa (`.test.ts` + `.spec.ts` + `.test.tsx`) | **127** | du-rework, đã loại trừ build outputs |
| Token đường dẫn trong docs/28 + docs/35 (distinct, sau resolve) | 223 | gồm nhiều biến thể cùng file |
| **C. BOTH** — đĩa ↔ ledger khớp | **114** | |
| **A. DISK-ONLY** — có đĩa, thiếu ledger | **13** | ĐÃ THÊM Dong R1–R13 vào docs/35 §3.5 + docs/28 §7 (13 file — xem 2 bảng) |
| **B. LEDGER-ONLY** — ledger kê, đĩa không có (Test-Path=False) | **10** | 9 phantom §3.3 (đã quarantine sẵn, GIỮ NGUYÊN dong) + `services/orchestrator/tests/usage-projection.integration.test.ts` (FILE MISSING; file thật ở `tests/integration/...` đã có row §3.2) |

Phân bổ 13 dong thêm theo bằng chứng docs/29: **9 có literal PASS** (R1 invocation-access 2/2 · R2 admin-error-boundary 1/1 · R3 admin-shell-live-pane 1/1 A6-11-recheck · R4 artifact-grant-fencing 10/10 · R5 operation-tenant-fence 4/4 · R6 workspace-reference 4/4 · R7–R9 PASS-trong-batch-A6-12, ghi rõ "không có literal từng file") + **4 `[UNRUN]`** (R10 journeys · R11 sections-verify · R12 api-keys-pane-count — Playwright mới; R13 log-redaction — W47-C2) → **RUN REQUEST cho 4 file UNRUN đã ghi docs/29** (routing Agent-6, kèm cảnh giác thiếu jest config cho `tests/login` — tiền lệ A6-9).

Ràng buộc tuân thủ: chỉ THÊM dong (docs/35 §3.5 mới, docs/28 §7 mới — không đánh số lại bảng cũ, không sửa ký tự status row nào kể cả của tôi, không đụng deliverable/acceptance); không xóa dong; ledger-only 10 dong Test-Path=False giữ nguyên vì đã dán nhãn ABSENT. Sau bổ sung: 114 + 13 = **127/127 file trên đĩa đều có dong ledger**.

## Nhật ký

- 23:06 — tạo report, identity + 3 dòng §14.
- 23:0x — hoàn tất re-Test-Path (78/15); phát hiện lỗi script của chính tôi (thiếu prefix du-rework/ ở lần chạy đầu, 92 False giả) — sửa base path, chạy lại, chỉ dùng kết quả lần 2.
- 23:1x — agent Explore nền FAIL vì runtime (`Model stream ended without a finish reason`, ~69 phút) → nghiên cứu trực tiếp.
- 23:2x — nghiên cứu document-core (recipe-registry, input-normalizer, worker.ts, 374 test hiện có), connector (invoke.ts, p8-03-convergence, connector.test) và 4 lỗi live. Chốt danh sách FT-01 + FT-03, 5 RUN REQUEST, 2 finding mới (blob-store.ts phantom; bullmq-smoke cổng 55645 lạ).
- 00:3x — W43-Q4: danh sách duyệt → viết FT-01/02/03, sửa 3 vòng lỗi type-check strict, chạy xong: **3 suites / 45 passed / exit 0** + `npm run lint` exit 0.
- 07:2x — W43-Q6: docs/35+28 (BROWSER W47-O11), tests/unit BR-05/UC-07 13/13, regression offline batch 81/82 (admin-shell-server flake), tổng 111 suites.
- 09:0x — W43-Q7: đối chiếu kết quả thật 08:31 (W42-A77/A78) → docs/29 W43-Q7 block (R24-01 live VERIFIED, RQ-1..6 RESOLVED); docs/28/35 → FINAL W47-O12 (interactions 4/4 PASS); tests/unit re-run 13/13 exit 0. Tổng final 1,822/4/1,882.
- 11:0x — W43-Q8 (gui lai): ack cả 3 việc đã xong; re-verify bằng chứng fresh (grep docs + chạy lại tests/unit 13/13 exit 0); ghi Việc 10.
- 12:0x — W43-Q9: docs/36 §7 + docs/31 PLAN CHANGES 09-24 (SEC-OIDC-VAULT 16 rows G-SEC; DEPLOY-STORAGE-LOGGING 10 rows G-DATA); Test-Path sweep 5 docs: 124 True/36 False → NEW ABSENT = 0; ghi Việc 11 + TRANG THAI.
- 12:30 — W43-Q10: sửa docs/36 §7.2 (G-DATA 10 rows + erratum); đếm row THỰC 3 board: P0..P9 = 76 (21 [ ]/7 [~]/48 [x]), SEC = 16, DEPLOY = 10; ghi trần số coordinator 51/8/17 ≠ disk; ghi Việc 12.
- 13:30 — W43-Q11: cross-check 17 cite trong codex3.md (Test-Path + dump đúng range): 17/17 VERIFIED (16 file-cite True + 1 SSE negative 0 matches); không phantom; nuance #5 (plan có nêu sink :25/:98, CX3 về mức đo); ghi Việc 13.
- 14:00 — W43-Q12: thêm docs/36 §8 (CR-12 RESOLUTION 10:11 — fixture-level, edits 1-4 DONE, tsc 0); wave doc vẫn ghi DEPLOY=9 (:2652 "9 tasks", :2672 "0/0/9") — báo coordinator sửa; codex3 R11/R12 KHỢP C+A6 (+1 chính xác hóa oversize cascade, +1 finding High finalize lease-fence thiếu contract); ghi Việc 14.
- 14:40 — W43-Q13: docs/35 row 16 blob-wire 5→8/8 + addendum W43-Q13; docs/29 ack (A6 A90 ledger sẵn + RQ-5 RESOLVED); TRANG THAI: **KHOP** (3 nguồn C/A6/CX3 nhất trí CR-12) + 2 delta (precision oversize; finding High finalize-fence OPEN); ghi Việc 15.
- 15:20 — W43-Q14: docs/29 + docs/35 A91/A92 QUEUED Admin routes (6 route ADM-BASE-01, NO DB USED - CHO C); CX3 review ADM-BASE-01 = **CHO CT** (R13/R14 chưa tồn tại); ghi Việc 16.
- 16:10 — W43-Q15: sửa 3 stale counts docs/35 (76:14→37, 77:59→136, 79:25→56; +131 = gap 1.394→1.525, bảng khớp rerun); docs/29+35+36 ghi A96 (ADM-BASE-01 6/6 VERIFIED 7/7 exit 0; R24-02 KHÔNG done — 3 fail 0 skipped exit 1, đánh dấu theo yêu cầu; nghịch lý A95 skip-escape ghi trần); Test-Path 8/8 True; tổng 112 suites · 1.829/4/1.889; TRANG THAI ghi Việc 17.
- 17:00 — W43-Q16: docs/31 MM-06/MM-07 gắn connector (Codex-2) + block ownership re-broadcast (P4-08 = Codex-2, connector-poll in progress, runtime thiếu poll, hết lỗi biên dịch); docs/29 PENDING RUN REQUEST p4-08 13/13 no-skip routing antigravity; skip-rule connector-client 19/1 ghi trần (test 20 vẫn MỞ); docs/35 row 22 owner note; Test-Path 5/5 True; ghi Việc 18.
- 18:00 — W43-Q17: docs/35 thêm cột Skipped (3 headers/106 rows; pass-1&2 lỗi của tôi → pass-3 restore+cell-split đúng, có backup) + quy tắc §1.4 [PASS]⇔skipped=0; row 20 = [PASS] theo A97-L4 full-run 13/13 exit 0 + [SKIP-QUALIFIED] cho A95/A97-focus 1/13+12skip; docs/36 §10 + docs/29 hàng rào ledger mới; LECH packet W43-Q17 vs A97-L4 ghi để coordinator route; Test-Path 130/42 NEW ABSENT 0; fleet 112 · 1.832/1/1.889; ghi Việc 19.
- 17:52 (giờ thật) — W46-Q2-1: fixtures grant ĐÃ có trên disk trước edit của tôi (tuyên bố minh bạch, không ghi đè); thẩm định helper :730 + 2 call-sites :959/:1001 đúng pattern/schema; lint exit 0; services.ts KHÔNG đụng; docs/35 row 20 hạ về [FAIL] 11/2 theo run verified gần nhất + đính chính tổng 1.830/3/1.889; docs/29 RUN REQUEST canonical → Agent-6; literal A97-L4 sao nguyên văn + lệnh + ExitCode; blocker duy nhất: canonical re-run phía Agent-6. Ghi Việc 20.
- 18:1x-18:2x (giờ thật) — W46-Q2-2 steer: tuyên bố 0 dòng/0 byte đã sửa trong file multi-container (3 edit-attempt bị guard chặn trước khi ghi; bản vá trên disk là của lane khác; đã thẩm định, không ghi đè) — Việc 21. W46-Q2-3 ART-02: guard vào `src/artifact-streams.ts` (liveWorkspaces registry + hook hasActiveReference, giữ SDK DB-free; worker.ts call-site không đổi + REQUEST wire-hook đã ghi); test mới 4/4 exit 0 (18:18:05); regression worker-sdk 7 suites 124/124 exit 0 sau 1 lần sửa fixture cũ (planted orphan, giữ chủ đích); lint exit 0; docs/28 §6.2 row 6 + docs/35 addendum W46-Q2-3; fleet 113 · 1.834/3/1.893; row giữ [~] — Việc 22.
- ~19:35 — Việc 23 (kiểm tra blocker): CẢ HAI blocker của tôi ĐÃ RESOLVED — canonical multi-container W46-A6-7 `13/13 exit 0` (18:04) + p4-08 W42-A98/A99 `1/1 exit 0`; docs/29 gắn nhãn RESOLVED 2 block; docs/35 row 20/22 → [PASS] + addendum W46-Q2-4 (1.837/0/1.893 + tồn kho chưa khai 8 suite lane khác, admin-shell-live-pane 0/1 = finding Claude Code); tự phê spec "13/13" nhầm suite p4-08 trong RUN REQUEST cũ và sửa; wire-hook đã route Claude Code (W47-C1); CX3 review ADM-BASE-01 vẫn CHO CT; hàng đợi Qwen-2 CLEAN.

## 25 — W47-Q2-4 (tiếp theo): quy thuộc file vô danh + vá §1.4 docs/35 (ĐÃ ÁP DỤNG THẬT, 22:5x; bản §25 đầu bị trôi do va chạm sửa ngoài — khôi phục kèm đính chính)

**A. QUY THUỘC ĐÃ KIỂM CHỨNG LẠI THEO docs/29 nguyên văn** (tự phê: bản draft đầu của tôi ghi `black-box-durable` là `tests/integration/...`, 1 test, tạo 13:05 vì A6-5 — **SAI**; bằng chứng thật docs/29:394-410,454:

| File (đúng theo docs/29) | Loại | Run + literal | Chủ sở hữu theo ledger |
|---|---|---|---|
| `services/connector/tests/black-box-durable.test.ts` | LIVE gated (`CONNECTOR_INTEGRATION=1`, PG :5433 + Redis :6380) | 1/1 exit 0 (2.871s; 101ms test); TÁI XÁC NHẬN 3/3 exit 0 (3.734s) — W44-C2Z-4 | **Codex-2** (RUN REQUEST của Codex-2, P3-07/P4-07 High B&C) |
| `services/connector/tests/durable-integration.test.ts` | LIVE gated | 2/2 exit 0 (1.981s; 22ms test) | **Codex-2** |
| `tests/integration/connector-usage.integration.test.ts` | LIVE | 1/1 exit 0 (512ms, exactly-once usage) | ledger không ghi tên tác giả (A6-6 kê EXISTS) — coordinator chú thích khi reconcile |
| `tests/integration/usage-projection.integration.test.ts` | LIVE | đã có dòng §3.2 (1/1) | đã inventory |

Ứng viên `services/orchestrator/tests/usage-projection.integration.test.ts` = **FILE MISSING** (đừng cite; trùng tên dễ nhầm — đã ghi docs/35 §3.5).

**B. VÁ §1.4 docs/35 — ĐÃ ÁP DỤNG THẬT (22:5x, exit của edit có verify):** thêm khoản "GHI NHAN BATCH (W47-Q2-4)": `[PASS]` per-file đòi literal riêng; chỉ có literal batch → `[PASS-BATCH]` (đã dán nhãn cho R7-R9); đồng thời cập nhật câu tiền lệ A96→"chỉ còn giá trị lịch sử tới 18:04" vì W46-A6-7 `13/13, 0 skipped, exit 0` đã đạt §1.4 → row 20 [PASS].



## 26 — W47-Q2-5: ART-02 wire-hook ĐÃ NỐI DÂY (owner P4-05 = Qwen-2; giờ thật 2026-09-24 22:57 +0700)

**Boundary: chỉ `packages/worker-sdk` (src + tests). `server.ts`/admin Claude Code KHÔNG đụng. KHÔNG tick — reconcile của coordinator.**

**(1) Hợp đồng ĐÚNG THEO CODE** (`server.ts:711-743` + `runtime.ts:899-919` đọc nguyên văn):
- `GET /api/runtime/v1/workspace-reference?workspacePath=<dir>&tenantId=<uuid>`, bearer runtime (`assertRuntimeAuth`);
- 200 `{ workspacePath, tenantId, referenced: boolean, activeHolders: number }`; 401 bearer sai; **422** thiếu/sai query; **không có 404** — workspace lạ trả `referenced:false` (ứng viên orphan), đúng như coordinator nói;
- **NUANCE không phúng đại:** `referenced` = **TENANT presence, không phải path attribution** — SQL chỉ đếm theo `tenantId` (tasks non-terminal ∪ OPEN human_waits); `workspacePath` chỉ được echo; doc-comment runtime ghi rõ "no workspace-path column exists — storage_key is art-<uuid>". ⇒ một tenant có active holder chặn don MỌI dir hết hạn trong lượt sweep. Ghi nguyên văn vào doc-block code + test.

**(2) Wiring:**
- `src/artifact-streams.ts`: +`createWorkspaceReferenceCheck(opts)` + `WorkspaceReferenceQueryOptions` (baseUrl, tenantIds, fetchImpl injectable, token, timeoutMs mặc định 5000, onUncertain).
- `src/worker.ts`: `TempSweepConfig.referenceQuery?: { tenantIds: string[]; timeoutMs?: number }`; `startWorker.runSweep` truyền `hasActiveReference` = hook gọi endpoint qua `config.runtimeUrl`/`config.runtimeToken`/fetchImpl. **Không cấu hình `referenceQuery` ⇒ nguyên trạng in-process guard** (documented).
- `src/index.ts`: export hàm + type.

**(3) FAIL-SAFE tuyên bố + kiểm chứng:** network reject, timeout/abort, HTTP 4xx/5xx, body dị (referenced không boolean) ⇒ hook trả **true (REFERENCED)** + `onUncertain` log — **bất định không bao giờ xóa**; chỉ khi MỌI tenant trả `referenced:false` mới là orphan candidate. 401-không-token cũng fail-safe (test riêng).

**(4) Lệnh + literal (cwd `packages/worker-sdk`, ExitCode từng dòng riêng):**
- `npx jest tests/workspace-reference-wiring.test.ts --runInBand` → `Test Suites: 1 passed, 1 total | Tests: 9 passed, 9 total | 0 skipped | 0 failed`, Time ~2.8s, **EXIT=0** — trung thực: 2 vòng đỏ đầu do test của tôi (TS2554 thiếu arg `log`; TS2552 `RequestInfo` không có trong lib node), không phải source; sửa test, không bẻ source.
- Regression `npx jest --runInBand` → `Test Suites: 8 passed, 8 total | Tests: 133 passed, 133 total | 0 skipped | 0 failed`, **FULL_EXIT=0** (124 cũ + 9 mới; suite cũ không đổi kết quả).
- `npm run lint` (tsc --noEmit) → **LINT_EXIT=0** — 22:57:53 +0700.
- Files: `src/artifact-streams.ts` (+~75), `src/worker.ts` (config+wiring), `src/index.ts` (2 exports), `tests/workspace-reference-wiring.test.ts` (MỚI, 9 test).

**Còn treo (ngoài boundary SDK):** nghiệm thu LIVE end-to-end (worker thật sweep chạm endpoint thật + DB) chưa có live-suite — tôi không tự tạo test LIVE cần window DB; REQUEST để coordinator quyết route (row P4-05 vẫn [~]).

- 20:34→21:0x — W47-Q2-4: reconcile disk-vs-ledger (127/223/114 BOTH/13 DISK-ONLY/10 LEDGER-ONLY False); 13 dong R1-R13 vao docs/35 §3.5 + docs/28 §7 (chi THEM, khong doi status cu); 4 [UNRUN] → RUN REQUEST vao docs/29 route Agent-6; docs/36 §11; tu phe 2 loi edit (nuot header §6 docs/28, trung header Nhat ky) da khac phuc; §1.4 cai bang SKIP-QUALIFIED cho dong batch cua lan khong ghi ro §1.4 cu. — Viec 24.
- 22:5x — W47-Q2-5: doc ky server.ts:711-743 (200 echo path + referenced THEO TENANT / 401 / 422 / khong 404 — nuance ghi ro); noi day worker.ts tempSweep.referenceQuery + createWorkspaceReferenceCheck fail-safe; test moi 9/9 exit 0; regression 8/8 · 133/133 exit 0; lint 0; P4-05 giu [~], khong tick. — Viec 26.


## 27 — W48-Q2-1: P8-02b suite ĐÃ VIẾT (MM-05 Redis-loss drill + MM-10 same-epoch fault injection) — P8-02 vẫn [~], KHÔNG tick (giờ thật 2026-09-24 23:35 +0700; Qwen-2 / `term_4d79e7d3`)

**Ranh giới đã giữ:** file mới DUY NHẤT `tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts` (6 test) — không đụng multi-container (Qwen-3), connector/connector-client (Codex-2), worker-sdk (xong W47-Q2-5), server.ts/admin (Claude Code); chỉ READ-reuse harness p8-02 hiện có (isolation ctx, createApp autoDispatch:false, claim/heartbeat/complete routes, sweep-deadlines). Không commit/push. Không mở DB.

**Test design (đóng đúng 2 khoảng MM-05/MM-10 mà tasks/P8:33-36 khai còn treo):**
- **MM-05a** Redis-loss-before-claim: `queue.add` rồi `obliterate` (mất data Redis trước claim) → task vẫn READY + `leased_by` NULL (PG durable truth, zero half-written); ép `deadline_at` quá hạn → `sweep-deadlines` đưa op về TIMED_OUT (escape hatch có chặn); sweep lần 2 không đếm twice (exactly-once).
- **MM-05b** submission_keys bền qua Redis loss: cùng Idempotency-Key resubmit sau queue wipe → `replayed:true`, đúng operation cũ, đúng 1 dòng operations.
- **MM-05c** CHARACTERIZATION probe: health vẫn báo HEALTHY khi queue wiped — ghi nguyên trạng defect "durable health" (docs/31 MM-05 server.ts:510); test PHẢI đảo kỳ vọng khi platform sửa, comment ngay trong file.
- **MM-10a/b** same-epoch production fault: cancel xong, dùng ĐÚNG leaseEpoch của claim cuối (không có takeover, epoch không bump) gọi `complete`/`heartbeat` → phải bị 409/410 [LEASE_LOST|TASK_TERMINAL]; assert thêm: op/task vẫn CANCELLED, `result_ref` không leak, `lease_expires_at` đứng nguyên.
- **MM-10c** recovery: sau chuỗi same-epoch rejection, submission mới claim được, complete 200, task SUCCEEDED — không có poison state toàn hệ thống.

**Bằng chứng offline (honest, [SKIP-QUALIFIED] theo docs/35 §1.4):**
`cd du-rework && npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
→ `Test Suites: 1 skipped, 0 of 1 total | Tests: 6 skipped, 6 total` **EXIT=0** (23:33) — compile sạch, gate `DU_LIVE_INFRA` tự skip nên KHÔNG thể vô tình chạm DB.
**Bằng chứng nghiệm thu = RUN REQUEST 3 lần liên tiếp** (docs/29 block "W48-Q2-1 RUN REQUEST", routing Agent-6/`term_47a1d44b`): `set DU_LIVE_INFRA=1` + lệnh trên, mỗi lần literal `Tests: 6 passed, 6 total` 0 skipped/0 failed + ExitCode riêng.

**Tự phê trong phiên (2 lỗi của tôi, đã sửa TRƯỚC khi giao):** (1) TS2339 `describe.runIf` không tồn tại ở jest bản này — đổi sang `LIVE ? describe : describe.skip`; (2) SQL `interval 1 minute` thiếu nháy (PG syntax) — đổi `interval '1 minute'`, đối chiếu đúng form của p8-02 hiện có (`deadline_at`, `TIMED_OUT`).

## Nhật ký (tiếp)

- 23:3x — W48-Q2-1: P8-02 transfer về Qwen-2; viết mới `tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts` (MM-05a/b/c + MM-10a/b/c, 6 test); compile/skip-check EXIT=0 (6 skipped, 23:33) — KHÔNG mở DB; RUN REQUEST 3-run-agent-6 đã ghi docs/29 (700 dòng); 2 lỗi của tôi (describe.runIf, interval quotes) sửa trước khi giao; P8-02 vẫn [~], không tick, không commit. — Mục 27.

## 28 — W48 feedback Agent-6: triage 2 nhóm lỗi + sửa + nộp RUN REQUEST vòng 2 (giờ thật 2026-09-24 23:51 +0700; Qwen-2 / `term_4d79e7d3`)

**Triage trung thực (không đổ oan, không nhận nhầm):**
| Feedback của Agent-6 | Phân loại | Xử lý |
|---|---|---|
| MM-05a/b/c FAIL @:216 — BullMQ v5 `getJob()` trả `undefined` | **BUG TEST CỦA TÔI** | helper `redisLossBeforeClaim` đổi assert sau obliterate `toBeNull()`→`toBeUndefined()` (+comment dẫn feedback); chạy lại compile-check: `1 skipped / 6 skipped, 6 total` **EXIT=0** 23:51:04 |
| MM-10b FAIL @:338 — heartbeat sau cancel trả **200** | **DEFECT SẢN PHẨM** (không phải test sai): heartbeat route chỉ fence by lease epoch, không kiểm terminal state — trái acceptance P8-02 "Cancelled Worker Cannot Keep Leases" (OPS-02/RUN-07). Đối chứng: MM-10a (complete sau cancel) PASS 409/410 — write-path fence ĐÚNG, heartbeat là ngoại lệ | Sửa TEST thành **DEFECT PROBE pinned 200** + giữ 2 bất biến an toàn (state vẫn CANCELLED; complete-sau-heartbeat vẫn 409/410) + comment ghi sẵn form assertion đảo khi platform sửa. KHÔNG sửa route (boundary Claude Code) |
| MM-10a, MM-10c PASS | ghi nhận — 4/6 test đã xanh có bằng chứng live |

**REQUEST → Claude Code (nhờ coordinator route, qua tôi không có quyền sửa src):**
`POST /api/runtime/v1/tasks/:id/heartbeat` phải từ chối task terminal (ít nhất CANCELLED/FAILED/SUCCEEDED) bằng 409 LEASE_LOST hoặc 410 TASK_TERMINAL như complete/children/wait-input đang làm — hiện chỉ so leaseEpoch nên cancelled task vẫn nhận heartbeat 200 và có thể kéo dài lease. Tệp/vị trí tham chiếu fencing mẫu: các route anh-chị-em trong cùng runtime (p8-02 suite §3 chứng minh 409/410 cho writes). Severity: vi phạm RUN-07 acceptance; blast radius hạn chế (không thể complete được sau cancel — đã chứng minh MM-10a + probe mới). Khi fix vào, tín hiệu đóng = Agent-6 chạy p8-02b ra heartbeat 409/410 → tôi đảo probe (ghi trong comment file).

**Nộp lại:** docs/29 block "W48-A6fb2 RUN REQUEST (vòng 2)" — 3 lần liên tiếp, mỗi lần `Tests: 6 passed, 6 total` ExitCode 0. **P8-02 vẫn [~], không tick.** Không commit/push.

## Nhật ký (tiếp)

- 23:5x — W48-A6fb: triage feedback Agent-6 (bug test BullMQ-undefined của tôi: SỬA; defect heartbeat-200 sau cancel: PROBE + REQUEST Claude Code); compile-check EXIT=0 23:51:04; RUN REQUEST vòng 2 đã ghi docs/29. — Mục 28.


## 29 — W48 Tester round-2 results: 5/6 xanh 3/3 lan; MM-05c = loi ki thuc CUA TOI, da sua theo code that (gio that 2026-09-25 00:09 +0700; Qwen-2 / `term_4d79e7d3`)

**Ket qua Tester (`reports/tester.md`, 3 lan chay lien tiep tren ban vong 2):** `5 passed, 1 failed` ca 3 lan, ExitCode 1 — XANH: **MM-05a, MM-05b, MM-10a, MM-10b (defect probe — pin thanh cong 200), MM-10c**. DO: chi MM-05c @:294.

**Triage:** day KHONG phai loi san pham cung khong phai bug BullMQ — toi characterize `/health` bang MO CU trong docs/31 ("server.ts:510 constant HEALTHY"). Doc code that `server.ts:433-461`: health = probe ket noi `{status:'ok'|'degraded', db: SELECT-1, redis: PING, activeLeases}`; body Tester ghi nhan `{"status":"ok","db":true,"redis":true,"activeLeases":0}` thuan voi code. Queue-wipe khong lam mat ket nen → 'ok' la DUNG hien tai; khoảng trong MM-05 that su la **thieu signal queue-integrity**, khong phai "hang number HEALTHY".

**Da lam:**
1. `MM-05c` viết lại theo hợp đồng thật: `toEqual({status:'ok',db:true,redis:true,activeLeases:0})` + key-set `['activeLeases','db','redis','status']`, comment ghi ro dieu kien dao assertion khi platform them queue-integrity signal.
2. **Sửa docs/31 dong MM-05** (toI chu): cell evidence thay cu "server.ts:510 constant HEALTHY" = "corrected W48/Tester-3-run: /health structured at server.ts:433-461; still NO queue-integrity signal" + cot drill chi thang p8-02b MM-05a/b/c trang thai tung phan (sweep escape + replay durable VERIFIED; reconciliation van thieu).
3. Compile/skip-check: `6 skipped, 6 total` **EXIT=0** — 00:09:45.
4. **RUN REQUEST vong 3** da noi vao docs/29 ("W48-A6fb3"): 3 lan lien tiep TREN BAN CODE NAY (vi code doi sau 3 lan cua Tester), moi lan `Tests: 6 passed, 6 total` 0 skipped/0 failed ExitCode 0; neu ra heartbeat 409/410 → bao toi dao probe (tin hieu RUN-07 dong).

**Hàng đợi kết quả chờ:** P8-02 van [~], khong tick; reconcile cua coordinator sau 3-xanh-vong-3. Khong commit/push.

## Nhật ký (tiếp)

- 00:09 (25/09) — W48 Tester vong 2: 5/6 xanh 3/3 lan; MM-05c loi ki thuc cua toi (mo cu docs/31) → sua test theo code that server.ts:433-461 + chinh sua docs/31 MM-05; compile EXIT=0; RUN REQUEST vong 3 noi docs/29. — Muc 29.


## 30 — W48 vòng 3: p8-02b 6/6 ×3 lan ExitCode 0; ledger 3 noi da cap nhat; P8-02 van [~] theo Reviewer (gio that 2026-09-25 00:16 +0700; Qwen-2 / `term_4d79e7d3`)

**Ket qua (Tester `reports/tester.md`):** 3/3 lan `Test Suites: 1 passed | Tests: 6 passed, 6 total`, **ExitCode 0**, 0 skipped/0 failed (1.577s/1.652s/1.598s); window CLAIM 00:13:09.819 → RELEASE 00:13:21.008. Toàn bộ literal đã sao nguyên văn vào docs/29 block "W48-A6fb3 → RESOLVED".

**Da ghi ledger (3 cho cua toi):** docs/35 §3.5 them dong **R14** ([PASS], ke ro 2 probe van pin defect — khong dong P8-02); docs/28 §7 them **file thu 14**, ledger 128/128; docs/29 block RESOLVED + hang doi Qwen-2 CLEAN.

**Su co van hanh trong luong (ghi de coordinator biet):** 00:12–00:15 toi parse Test-Path docs/28 = False giua chung `read_file` bao "File not found" — sau do file nguyen ven 26.536 byte, timestamp ca thu muc docs/ dong 12:31:15AM → **race re-sync toan bo docs/** (kieu tam+rename), KHONG phai xoa; khong mat noi dung; chinh toi da co luc nghi sai la incident va bao dong ngay trong block docs/28.

**Pham vi bang chung — dong y Reviewer:** suite xanh = drill + probes chay dug tren live; P8-02 giu [~] vi (1) MM-10b pin heartbeat-200 defect (RUN-07, REQUEST Claude Code mo), (2) MM-05c pin /health thieu queue-integrity + dispatcher reconciliation chua co (MM-05 platform). Dao assertion = tin hieu dong tung nhat. Khong commit/push/khong tick.

## Nhật ký (tiếp)

- 00:16 (25/09) — W48 vong 3: Tester 3/3 ExitCode 0, 6/6; ghi R14 docs/35 + file-14 docs/28 + RESOLVED docs/29; P8-02 giu [~] theo Reviewer; race re-sync docs/ (False gia 00:12-00:15) da xac minh khong mat mat. — Muc 30.


## 31 — R1-B/RR: KHẢO SÁT DEFECT MM-10b (heartbeat 200 sau cancel) — nguyên nhân gốc + patch đề xuất cho Claude Code (KHÔNG sửa src; giờ thật 2026-09-25 ~00:3x +0700; Qwen-2 / `term_4d79e7d3`)

### Chuỗi nguyên nhân (tất cả đọc trực tiếp từ disk phiên này)
1. `POST /api/runtime/v1/tasks/:id/heartbeat` (server.ts:636-644) → `heartbeatTask` tại **runtime.ts:127-145**: SELECT chỉ `lease_epoch, lease_expires_at`; UPDATE fence **CHỈ by epoch** (`WHERE id=$1 AND lease_epoch=$3`), **không có điều kiện state**.
2. `cancelOperation` (**lifecycle.ts:19-54**): set `operations.state='CANCELLED', cancel_requested=true`, set `tasks.state='CANCELLED'` (non-terminal tasks), đóng human waits — **NHƯNG không bump `lease_epoch`, không clear `leased_by`/`lease_expires_at`**.
3. ⇒ Task CANCELLED giữ nguyên epoch của worker cuối claim → same-epoch heartbeat khớp UPDATE (1 row) → **200 + kéo dài `lease_expires_at` trên task terminal**.
4. Thêm: `heartbeatTask` trả **`cancelRequested: false` CỨNG** (dòng 145) dù `operations.cancel_requested=true` — trong khi SDK worker dựa vào cờ đó để cooperative-abort (`packages/worker-sdk/src/worker.ts:328: if (ack.cancelRequested) ctx.abort('cancel')`) ⇒ kênh cancel qua heartbeat ĐANG CHẾT.
5. Vì sao 20/20 p8-02 cũ không thấy: test §3 "stale heartbeat on cancelled task" gửi `leaseEpoch: cancelLeaseEpoch + 99` (p8-02-fault-recovery:607) — cố ý EPOCH SAI → 409; còn R1-B/MM-10b dùng epoch ĐÚNG nên lộ hole. claim sau cancel đã fence đúng (410 TASK_TERMINAL @:614-625); complete cũng fence state trước (`runtime.ts:206-214` state-guard → `gone()` 410) — **heartbeat là route duy nhất thiếu guard state**.

### Blast radius (chính xác, không phóng đại)
- KHÔNG có kết quả sai ghi được (mọi write path terminal-fenced — MM-10a + 20/20 chứng minh).
- VI PHẠM chấp nhận P8-02 "Cancelled Worker Cannot Keep Leases" (OPS-02/RUN-07): cancelled worker tiếp tục giữ/hẹn giờ lease trên hàng terminal.
- Cooperative cancel qua heartbeat mất tác dụng → worker đốt hết thời lượng handler rồi mới ăn 409/410 ở complete.
- Ghi chú lan cận: `PUT /workers/:instanceId/heartbeat` (server.ts:620-623) là stub tĩnh trả `{health:'HEALTHY',...}` không DB — đây nhiều khả năng là nguồn câu chữ "constant HEALTHY @:510" cũ trong docs/31 (đã sửa tuần trước); liveness worker không durable là khoảng riêng, không nhập vào defect này.

### Patch đề xuất (Claude Code — boundary của họ; thứ tự guard CHỌN ĐỂ KHÔNG GÃY suite 20/20 hiện có)
`heartbeatTask` (runtime.ts:127-145):
```ts
const res = await db.query(
  `SELECT t.lease_epoch, t.lease_expires_at, t.state, o.cancel_requested
     FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1`, [taskId]);
// 1) 404 nếu mất row (giữ nguyên).
// 2) EPOCH-STALE TRƯỚC (bảo toàn test §3 hiện hữu trả 409):
//    if (row.lease_epoch !== leaseEpoch) throw conflict('LEASE_LOST', ...)
// 3) STATE-TERMINAL SAU (mô hình completeTask :211-214):
//    if (['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(row.state))
//      throw gone(`task ${taskId} is terminal ${row.state}`);           // 410 TASK_TERMINAL
// 4) UPDATE giữ nguyên epoch-conditional, THÊM belt-and-braces:
//    ... WHERE id=$1 AND lease_epoch=$3
//        AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
// 5) return { leaseExpiresAt, cancelRequested: Boolean(row.cancel_requested) }; // bỏ hardcode false
```
Ghi chú thêm (optional, cùng tx của `cancelOperation` ở lifecycle.ts:36-40): thêm `leased_by=NULL, lease_expires_at=NULL` vào UPDATE tasks khi cancel — bookkeeping lease trung thực; không bắt buộc vì state-guard đã chặn.

### Kế hoạch lật phía tôi khi patch vào (KHÔNG chạy gì cho tới lúc đó)
- `p8-02b` MM-10b: đổi `expect(hb.status).toBe(200)` → `expect(hb.status).toBe(410)` + `code TASK_TERMINAL` (form đã ghi trong comment file).
- Nộp RUN REQUEST mới (3/3 lần, per-run ExitCode) — qua Tester/Agent-6.
- Nếu patch chỉ sửa 2/5 mục (ví dụ quên cancelRequested thật), probe phụ cờ nên được thêm lúc đó.

**Trạng thái:** P8-02 vẫn [~] — defect MM-10b ghi nhận + REQUEST đã soạn sẵn để coordinator route Claude Code. Tôi không sửa `services/orchestrator/src/**` (boundary), không commit/push/tick.

## Nhật ký (tiếp)

- 00:3x (25/09) — R1-B: khảo sát MM-10b xong — gốc at runtime.ts:127-145 (epoch-only fence) + lifecycle.ts:36-40 (cancel không bump epoch/clear lease) + hardcode cancelRequested:false; patch đề xuất theo thứ tự epoch→state để bảo toàn 20/20 cũ; flip plan ghi cho p8-02b. — Mục 31.


## 32 — Standby (thông báo coordinator ~00:4x 25/09): patch MM-10b đã giao Claude Code theo đúng đề xuất mục 31

- **Trạng thái Qwen-2: STANDBY.** Trigger hành động duy nhất của tôi: patch vào + Tester verify → tôi lật probe `p8-02b` MM-10b (`expect(hb.status).toBe(200)` @358 → `expect(hb.status).toBe(410)` + code `TASK_TERMINAL`, form lật đã ghi sẵn tại comment :356-357) rồi nộp RUN REQUEST 3/3 mới để tiến tới đóng P8-02.
- Chờ bị chặn bởi (tên rõ): (1) `claude-code-heartbeat-patch` (Claude Code), (2) `tester-verify-after-patch` (Tester). Không có việc offline treo nào của lane tôi; hàng đợi RUN REQUEST docs/29 CLEAN phía Qwen-2 (4 file [UNRUN] W47-Q2-4 thuộc lane khác).
- Không sửa gì thêm cho tới trigger. P8-02 vẫn [~].


## 33 — W48-A6fb4: R1-B patch đã lên disk → LẬT PROBE MM-10b 200→410 + nộp RUN REQUEST vòng 4 (giờ thật 2026-09-25 02:08:35 +0700; Qwen-2 / `term_4d79e7d3`)

**Phát hiện khi kiểm trigger (user nhắn "tiếp"):** `heartbeatTask` (runtime.ts:127-177) ĐÃ chứa đúng patch §31 — comment "R1-B / MM-10b" trong code; guard order epoch→409 trước (bảo toàn test stale-epoch của p8-02 §3), terminal→410 TASK_TERMINAL sau, UPDATE thêm `AND state NOT IN (terminal)`, return `cancel_requested` thật. Tester CHƯA verify sau patch (tester.md dừng ở vòng 3) ⇒ probe pin-200 cũ sẽ báo đỏ GIẢ trên code đã sửa — phải lật NGAY rồi để 3× của Tester là verify.

**Đã làm (chỉ file của tôi):**
1. MM-10b lật: `expect(hb.status).toBe(410)` + `code TASK_TERMINAL` + assertion MỚI `lease_expires_at không bị kéo dài` (so trước/sau qua `lease_expires_at` cột db); header file cập nhật vòng feedback.
2. Compile/skip: `6 skipped, 6 total` **EXIT=0**; `npm run lint` orchestrator (code patch của Claude Code, offline typecheck): **EXIT=0** — patch compile sạch, không lỗi TS.
3. docs/35 R14: ghi UPDATE (patch vận hành + lật + pending vòng 4) — giữ nguyên lịch sử 3/3 cũ.
4. docs/29: block "W48-A6fb4 RUN REQUEST (vòng 4)" — 3 lần liên tiếp `set DU_LIVE_INFRA=1` + lệnh cũ; kèm nhắc Tester chạy cả `p8-02-fault-recovery` + `runtime.test.ts` để chắc 409-stale contract không bị lật nhầm thành 410.

**Trạng thái chờ (tên):** `tester-round4-p802b` → xanh 3/3 = đóng MM-10b/RUN-07 + điều kiện reconcile P8-02. Qwen-2 hết việc offline; về standby. Không commit/push/tick.

## Nhật ký (tiếp)

- 02:08 (25/09) — W48-A6fb4: trigger check thấy R1-B patch đã lên disk (runtime.ts:127-177, đúng §31); lật probe 200→410 + lease-not-extended; compile 6 skipped EXIT=0; orchestrator lint EXIT=0; docs/35 R14 UPDATE; RUN REQUEST vòng 4 vào docs/29. Standby chờ tester-round4-p802b. — Mục 33.


## 34 — R1-B re-dispatch (ORCHESTRATOR TURN 1): premise STALE — flip 200→410 + lease-assert ĐÃ trên disk và ĐÃ live-verify 6/6×3; còn mở đúng 1 mục cross-check guard-order (giờ 2026-09-25; Qwen-2 / `term_4d79e7d3`)

**Packet R1-B yêu cầu:** sửa assertion MM-10b 200→410, thêm lease-not-extended, nộp RUN REQUEST. **Kiểm tra disk turn này: cả 3 đã xong ở §33 (W48-A6fb4, 02:08:35) và Tester đã chạy sống xanh 3/3.** ⇒ KHÔNG sửa lại code/test (giữ nguyên trạng thái ĐÃ verify), KHÔNG nộp RUN REQUEST trùng vòng 4.

**Bằng chứng tươi (đọc/grep trực tiếp turn này):**
| Hạng | Trạng thái | Dẫn chứng |
|---|---|---|
| Source guard R1-B | ` M` disk | `runtime.ts:127-177` `heartbeatTask`: epoch→409 TRƯỚC, terminal→410 TASK_TERMINAL SAU, UPDATE `AND state NOT IN (terminal)`, `cancel_requested` thật |
| Assertion MM-10b | `??` disk | test `:362` `expect(hb.status).toBe(410)`, `:363` `code TASK_TERMINAL`; 4 `toBe(200)` còn lại = claim/sweep/health/complete (KHÔNG phải hb) |
| lease-not-extended | đã có | test `:347/:366` đọc `lease_expires_at` trước/sau; `:370` `expect(String(after…e)).toBe(String(before…e)) // lease NOT extended` |
| RUN REQUEST vòng 4 | đã nộp | docs/29:729 "W48-A6fb4 RUN REQUEST (vòng 4)" |
| **Tester ĐÃ chạy sống** | **XANH 3/3** | tester.md:440-493 — window 02:11:22→02:11:40, pre-run check "MM-10b expects HTTP 410 TASK_TERMINAL", 3 run `Tests: 6 passed, 6 total` ExitCode 0 |
| Live DB phía tôi | **KHÔNG chạy** | đúng lệnh packet; chỉ gate `DU_LIVE_INFRA` skip offline |

⇒ **MM-10b / RUN-07 ("Cancelled worker cannot keep leases") = ĐÃ ĐÓNG bằng chứng sống.**

**Còn mở ĐÚNG 1 mục (chính §33/vòng 4 yêu cầu, round 4 CHƯA làm):** round 4 chỉ chạy `p8-02b` (grep tester.md `p8-02-fault-recovery`=0, `runtime.test.ts`=0). Patch đặt guard epoch→409 TRƯỚC terminal→410 SAU; cần bằng chứng sống rằng stale-epoch vẫn 409 (không bị lật nhầm 410). Test rủi ro thật: `p8-02-fault-recovery:603` "stale heartbeat on cancelled task is rejected with 409 LEASE_LOST". → **ĐÃ nộp RUN REQUEST vòng 5 (docs/29)**: `p8-02-fault-recovery` (20 test) + `runtime.test.ts` (97 test), kỳ vọng exit 0 và :603 vẫn 409.

**Routing đính chính (để coordinator khỏi gửi nhầm):** packet gọi Tester là "Codex-2", nhưng lane này + evidence round 4 cho thấy cửa sổ DB PG:5433/Redis:6380 do **Tester lane (report `tester.md`, holder lịch sử Agent-6 `term_47a1d44b`)** giữ; **Codex-2 là dev lane** (`services/connector`/`packages/worker-sdk`), KHÔNG giữ DB window ⇒ RUN REQUEST cần-window route Tester/Agent-6, KHÔNG route Codex-2.

**TRANG THAI (R1-B):** `flip+lease-assert đã trên disk + live 6/6×3 exit 0 (MM-10b/RUN-07 ĐÓNG) · còn mở: cross-check guard-order (RUN REQUEST vòng 5 đã nộp docs/29, chờ Tester) · P8-02 vẫn [~]: blocker còn lại = MM-05c /health queue-integrity (platform gap riêng, NGOÀI R1-B) + pending vòng 5; reconcile [~]→[x] = quyền coordinator · không tick/commit/push; không mở DB.`

## Nhật ký (tiếp)

- (25/09) — R1-B re-dispatch Turn 1: premise stale — 3 deliverable đã xong §33 + Tester round 4 sống `6/6×3` exit 0; MM-10b/RUN-07 ĐÓNG bằng chứng; nộp RUN REQUEST vòng 5 (companion guard-order: p8-02-fault-recovery 20 + runtime.test 97) docs/29; đính chính routing Tester=Agent-6/window (Codex-2 không có window); KHÔNG sửa code đã verify, KHÔNG mở DB. P8-02 vẫn [~]. — Mục 34.
## 35 — TURN 3-B: Vòng 5 receipt = PARTIAL (đính chính packet) + MM-05 design & offline probe ĐÃ NỘP (giờ 2026-09-25 03:3x +07; Qwen-2 / `term_4d79e7d3`)

**Mục 1 packet ("Tester báo vòng 5 thành công rực rỡ 20/20 + 97/97, ExitCode 0"): ĐÚNG MỘT NỬA.** Ledger tester.md:494-1004 (window 03:11:51→03:12:13): Suite 2 `runtime.test.ts` 97/97 exit 0 NHƯNG Suite 1 `p8-02-fault-recovery` ExitCode 1 — 20/20 fail tại beforeAll fetch `connect ETIMEDOUT 127.0.0.1:54382` (chưa case nào tới assertion). Chẩn đoán: môi trường WinNAT/firewall chặn ephemeral port, không phải product defect (Suite 2 cùng window loopback HTTP xanh 100%). ⇒ **guard-order :603-409 vẫn CHƯA có bằng chứng sống current-build; MM-10b vẫn đóng từ vòng 4 (độc lập).** Đã ghi docs/29 "W48-A6fb5 ANSWER (PARTIAL)" + nộp **RUN REQUEST vòng 6 (W48-A6fb6)**: re-run riêng Suite 1, kèm 2 bước chẩn đoán portrange/NO_PROXY + prerun-check tsc.

**Đã làm TURN này (chỉ file lane tôi, zero DB):**
1. **docs/38-mm05-queue-integrity-probe.md** — design mechanism MM-05: predicate phát hiện orphan CHỈ-TỪ-PG (`outbox.dispatched_at NOT NULL` + `tasks.state IN (READY,QUEUED)` leaseless + op non-terminal, grace 30s) → xác nhận Redis `queue.getJob(jobIdForDelivery)===undefined` → **RE-ARM chính row outbox gốc** (dispatcher hiện hữu republish; jobId tất định dedup ⇒ multi-replica-safe, zero duplicate effect — phương án "delivery row :requeue:" bị reject vì vượt lớp dedup queue). Móc vào recoveryTimer sẵn có; knob grace/batch; /health thêm `queueIntegrity{state,orphansLast,stalled,lastSweepAt}` — **chốt luôn MM-05c** (SUSPECT thay vì `ok` mù). Checklist implement cho platform lane (§7) + acceptance plan DB-window (§8: MM-05d drill mới + flip MM-05c + regression guard-order).
2. **Offline probe ĐÃ CHẠY XANH** `services/orchestrator/tests/mm05-queue-integrity-offline.functional.test.ts` (pattern r24-01: dispatcher THẬT + fake outbox/job store in-memory, zero DB/Redis — đúng luật lane, không cần RUN REQUEST): `Test Suites: 1 passed; Tests: 4 passed, 4 total` ExitCode 0 @03:25. probe/0 publish-once-stamp; **probe/1 pin GAP (wipe→không bao giờ republish) — điểm flip khi sweepQueueIntegrity về**; probe/2 invariant re-arm-dedup (điều kiện an toàn của design §3); probe/3 PG state-of-record đủ enumerate orphan.
3. docs/29: A6fb5 ANSWER + A6fb6 vòng 6 (routing Tester/Agent-6 `term_47a1d44b`). docs/35: §6 addendum + row 13 gắn nhãn "build lịch sử" (không còn suy ra guard-order current-build) + R14 UPDATE 03:27.

**Cờ đỏ cross-lane (không phải việc tôi, ĐÃ báo docs/29+35):** `tsc --noEmit` orchestrator ĐỎ 5 lỗi `src/modules/artifacts/artifacts.ts:108-154` (`req.taskId/req.leaseEpoch` không tồn tại trên shape) — file untracked mtime 03:22:51, lane khác đang edit SAU receipt Tester. Hệ quả: test mới của tôi ts-jest compile xanh riêng lẻ (2.3s) nhưng suite nào import chain artifacts qua server.ts sẽ ĐỎ cho tới khi lane đó fix. Tester vòng 6 phải prerun-check tsc offline.

**TRANG THAI (TURN 3-B):** `vong5=PARTIAL(Suite2 97/97 xanh; Suite1 env-fail) · MM-10b ĐÓNG (vòng4, không đổi) · guard-order chờ vong6 (A6fb6 đã nộp) · MM-05: design docs/38 + offline probe 4/4 exit0 ĐÃ NỘP — implementation = platform lane · P8-02 vẫn [~] (blocker thật sự còn lại: vong6 literal + MM-05 implement) · reconcile = quyền coordinator · không tick/commit/push, không mở DB.`

## Nhật ký (tiếp)

- 03:3x (25/09) — TURN 3-B: đối chiếu tester.md → đính chính packet (vòng 5 PARTIAL, Suite 1 ETIMEDOUT env-fail); ghi A6fb5 ANSWER + nộp vòng 6 A6fb6 (docs/29); viết docs/38 design MM-05 re-arm reconstruction + queue-integrity health (chốt MM-05c); offline probe 4/4 exit 0 (tự chạy, đúng lane); docs/35 §6 addendum + row13/R14 update; cờ đỏ tsc artifacts.ts lane khác 03:22. Standby chờ vòng 6 + platform implement docs/38. — Mục 35.
## 36 — CYCLE 78 TURN 1: Vòng 6 fail MÔI TRƯỜNG thứ hai (ECONNREFUSED :5433 — infra chưa up) → nộp vòng 6b (A6fb7, bước 0 bắt buộc `docker compose up -d` + healthy-gate) + SUITE LIVE p8-02c cho MM-05 re-arm ĐÃ CHUẨN BỊ SẴN (2026-09-25 ~04:0x +07; Qwen-2 / `term_4d79e7d3`)

**Receipt vòng 6 (tester.md:1005-1393, đối chiếu tươi):** prerun Tester ĐÚNG (NO_PROXY set; `tsc --noEmit` **exit 0** ⇒ cờ đỏ artifacts.ts 03:22 tôi nêu §35 ĐÃ settle — rút cờ, không còn blocker build; netsh: 54382 KHÔNG trong dải excluded ⇒ **thuyết WinNAT vòng 5 của tôi bị BÁC — đính chính luôn vào docs/29 A6fb6 ANSWER**: hai vòng 5/6 nhiều khả năng cùng gốc infra-not-ready, dead-port loopback cho ETIMEDOUT hoặc ECONNREFUSED tùy profile firewall). Window 03:42:39→03:42:42, ExitCode 1, 20/20 chết ở DB connection (`ECONNREFUSED :5433`), :603 chưa tới ⇒ **guard-order vẫn chưa chốt — 2 vòng môi trường liên tiếp; bằng chứng sống 97/97 runtime.test.ts (vòng 5) KHÔNG bị ảnh hưởng**. Root cause theo packet + Reviewer audit 6/6: stack `infra/docker-compose.yml` (`name: du-rework-test`, PG :5433 + Redis :6380, có healthcheck) chưa được up trước claim.

**Đã làm TURN này (zero DB):**
1. docs/29: block **A6fb6 ANSWER** (receipt + đính chính chẩn đoán vòng 5) + **RUN REQUEST vòng 6b = A6fb7**: bước 0 BẮT BUỘC `docker compose -f infra/docker-compose.yml up -d` → gate `ps` 2/2 **healthy** trước khi CLAIM (không healthy = không claim); sanity TCP probe 5433/6380; prerun tsc; lệnh jest cũ; bước 4 **cấm `down -v`** khi queue còn request (chống tái phát chính root cause). Kỳ vọng literal không đổi: `20 passed, 20 total` exit 0 + :603 vẫn **409**.
2. **Suite live MM-05 re-arm CHUẨN BỊ SẴN**: `tests/integration/p8-02c-mm05-rearm.integration.test.ts` (Qwen-2, file mới, không đụng suite cũ) — 5 test pin đúng contract docs/38: rearm-0 meta surface; **rearm-1 E2E**: submit→`dispatcher.dispatchOnce` thật→age stamp 5' (độc lập knob grace)→`obliterate` wipe→`sweepQueueIntegrity`≥1→republish **SAME jobId**→claim→complete→`SUCCEEDED`, 0 TIMED_OUT, 0 duplicate row; rearm-2 false-positive**: job còn sống ⇒ sweep=0, row không bị de-arm; **rearm-3 terminal fence**: op CANCELLED ⇒ sweep=0, job KHÔNG revive (parity RUN-07); **rearm-4 durable health**: /health có `queueIntegrity{state∈[OK,RECONSTRUCTING,SUSPECT], lastSweepAt}` (xong là flip nốt MM-05c key-set p8-02b). Triple gate: `DU_LIVE_INFRA=1` + `DU_MM05_REARM=1` (chỉ bật khi Qwen-1 declare docs/38 §7 done) + **rebuild dist** (`npm run build` orchestrator — suite import @du/orchestrator = dist/server.js, dist cũ = runtime cũ, rearm-0 sẽ đỏ kèm message chỉ đúng nguyên nhân). Verify offline của tôi: **compile sạch, `5 skipped, 5 total` ExitCode 0** (03:5x) — chạy sớm không bao giờ red-noise, chỉ [SKIP-QUALIFIED].
3. docs/38 §8 cập nhật: trỏ suite thật + triple gate + infra prereq (A6fb7 bước 0) + flip-list khi xanh.

**Routing note cho coordinator:** review.md:38 (audit) dẫn antigravity-6.md:8962-8964 — DB holder HIỆN ĐƯỢC NÊU là Tester `term_50c6a1ed` (khác handle lịch sử `term_47a1d44b` tôi từng route ở các vòng trước) — đã ghi vào dòng Routing của A6fb7; đề coordinator xác nhận holder hiện hành trước khi dispatch vòng 6b.

**TRANG THAI (cycle 78 t1):** `vong6=ENV-FAIL lần 2 (compose up thiếu) · guard-order VẪN chờ vong6b (A6fb7 đã nộp, có healthy-gate bước 0) · MM-10b ĐÓNG không đổi (vòng4) · cờ đỏ tsc artifacts.ts ĐÃ settle (Tester prerun exit 0) · MM-05: design docs/38 + offline probe 4/4 + SUITE LIVE p8-02c 5-test SẴN CHỜ Qwen-1 (§7 impl + rebuild dist + DU_MM05_REARM=1) · P8-02 [~] · reconcile = quyền coordinator · không tick/commit/push, không mở DB.`

## Nhật ký (tiếp)

- ~04:0x (25/09) — CYCLE 78 t1: đọc receipt vòng 6 (ECONNREFUSED :5433, 20/20 env-fail) → xác nhận root cause audit 6/6 (infra compose chưa up), rút cờ đỏ artifacts.ts (tsc đã xanh lúc Tester prerun), đính chính thuyết WinNAT vòng 5; ghi A6fb6 ANSWER + nộp A6fb7 vòng 6b (bước 0 compose up + 2/2 healthy gate + cấm down-v khi còn queue); soạn p8-02c-mm05-rearm.integration.test.ts (5 test, triple gate, offline compile xanh 5 skipped exit 0); docs/38 §8 trỏ suite thật. Standby chờ: Tester chạy 6b + Qwen-1 implement §7. — Mục 36.
## 37 — CYCLE 78 TURN 2: Vòng 6b XANH 20/20 exit 0 ⇒ **GUARD-ORDER CHỐT** (row 13 current-build) + MM-05 IMPLEMENT ĐÃ LAND (Qwen-1, tự verify offline) → **NỘP RUN REQUEST VÒNG 7 = A6fb8 (p8-02c live)** (2026-09-25 ~04:2x +07; Qwen-2 / `term_4d79e7d3`)

**Xác minh tươi từng claim của packet (không tin miệng):**
1. Vòng 6b: tester.md:1394-1448 — prerun bước 0 compose up + `ps` 2/2 healthy + TCP True/True + tsc exit 0; window 04:03:25→04:03:30; **literal `Tests: 20 passed, 20 total` ExitCode 0** ⇒ assertion `:603` (409 LEASE_LOST) nằm trong 20/20 xanh — **guard-order epoch→409/terminal→410 chốt trên build hậu-§31**. Cờ đỏ `artifacts.ts` §35-36 chính thức SETTLE (2 lần tsc exit 0). Infra giữ UP đúng chỉ thị.
2. MM-05 implement (Qwen-1): đọc trực tiếp — `sweepQueueIntegrity(opts{graceMs=30s,limit=50,maxAttempts=10}) → QueueIntegritySweepResult{candidates,rearmed,aliveSkipped,casSkipped,stalled,unconfirmed,stalledDeliveryIds}` (runtime.ts:1015-1061; predicate §2 + CAS re-arm §3 ĐÚNG như docs/38, kèm backoff due_at 2^attempts); seam `app.runQueueIntegritySweep`/`queueIntegrityHealth` (server.ts:214-247/:381-382); `/health` +`queueIntegrity` sau sweep đầu, SUSPECT vẫn HTTP 200 body degraded (D2). TÔI TỰ CHẠY offline: **Qwen-1 suite 8/8 exit 0** + **probe tôi 4/4 exit 0** (re-verify) + dist mtime 04:04:43 > src 03:58:54 ⇒ 3 gate thỏa.

**API-drift fix (việc chính kỹ thuật turn này):** p8-02c bản 03:5x giả định `sweepQueueIntegrity(limit)=>number` (theo docs/38 §7 chữ ký phác) — implement thật trả RESULT-OBJECT và health cache chỉ viết qua WRAPPER. Nếu không sửa, vòng 7 đỏ GIẢ trên window Tester. Đã đồng bộ: type `P802cApp` + `sweep()` gọi opts + assert `rearmed/aliveSkipped`; rearm-1 force `due_at = now() - 1s` TRƯỚC republish (backoff 2^attempts ≥2s của re-arm SQL — pin scheduler wait deterministic thay vì sleep); rearm-3 thêm assert row KHÔNG bị de-arm; rearm-4 drive `app.runQueueIntegritySweep()` + đối chiếu `qi.lastSweepAt === swept.lastSweepAt` + `if state!=SUSPECT ⇒ body.status ok`. Recompile: **`5 skipped` exit 0** (offline, zero DB).

**Đã ghi ledger:** docs/29 = A6fb7 ANSWER (guard-order chốt) + **A6fb8 RUN REQUEST vòng 7**: 3 lần liên tiếp, root du-rework, `$env:NO_PROXY; $env:DU_LIVE_INFRA=1; $env:DU_MM05_REARM=1` + jest p8-02c --config tests/integration/jest.config.cjs --runInBand; kỳ vọng `5 passed, 5 total` exit 0 ×3; prerun `npm run build` idempotent + healthy-gate; THIEU `DU_MM05_REARM=1` ⇒ [SKIP-QUALIFIED]; note vòng 8 = flip p8-02b MM-05c key-set 4→5 sau receipt 7 (Qwen-2 soạn). docs/35 = §7 addendum + row 13 → [PASS] (current-build 6b) + R14 cập nhật. docs/38 Status = IMPLEMENTED + live pending 7/8.
**Routing vòng 7:** Tester **`term_c9d336eb`** (chỉ định packet; chuỗi handle 47a1d44b→50c6a1ed→c9d336eb — tiếp tục đề nghị coordinator xác nhận holder lúc dispatch). Qwen-2 không mở DB; không tick/commit/push.

**TRANG THAI (cycle 78 t2):** `guard-order ĐÓNG (6b 20/20 exit 0, :603 409) · MM-10b ĐÓNG (vòng4) · MM-05: impl Qwen-1 verify-offline đủ (8/8 + 4/4 + dist fresh) — live pending VÒNG 7 (A6fb8, p8-02c 5/5×3, DU_MM05_REARM=1) rồi VÒNG 8 (flip p8-02b) · P8-02 [~]: còn đúng 2 chân live MM-05; reconcile [x] = quyền coordinator khi 7+8 xanh · không DB phía tôi.`

## Nhật ký (tiếp)

- 04:2x (25/09) — CYCLE 78 t2: verify packet bằng chứng tươi (6b literal 20/20 exit 0 tester.md:1394-1448; implement Qwen-1 runtime.ts:1015/server.ts:214-247; tự chạy 8/8 + 4/4 exit 0; dist 04:04>src) → phát hiện API-drift (result-object + health wrapper + due_at backoff) và SỬA p8-02c khớp, recompile 5 skipped exit 0; nộp A6fb7 ANSWER + A6fb8 vòng 7 (DU_LIVE_INFRA + DU_MM05_REARM, routing term_c9d336eb, note vòng 8 flip MM-05c); docs/35 §7 + row13/R14; docs/38 status IMPLEMENTED. Guard-order CHỐT. Standby chờ receipt 7. — Mục 37.
## 38 — CYCLE 85: Vòng 7 = 2 chặng (5/5 blocked **migration-0011-collision** → 4/5 với **rearm-1 CAS-μs** — defect THẬT, test không lỗi) + hotfix Qwen-1 verify lại (12/12 offline) ⇒ nộp **A6fb9 vòng 7′**; 3/4 milestone seam/health ĐÃ CÓ BẰNG CHỨNG SỐNG (2026-09-25 ~05:4x +07; Qwen-2 / `term_4d79e7d3`)

**Đính chính packet cycle 85 bằng ledger (tester.md:1450-1912):** claim "4/5, chỉ rearm-1 fail CAS microseconds" BỎ SÓT 3 run ĐẦU của cùng vòng (04:40:50→04:46:28): **5/5 fail tại `beforeAll` `createApp(autoMigrate)` — `duplicate key schema_migrations_pkey`** do `0011_admin_audit.sql` collide với `0011_artifact_finalize_epoch.sql` (file artifacts-lane thêm 03:54). Collision hiện ĐÃ resolve trên disk (0010_admin_audit/0011_artifact_finalize_epoch/0012_admin_idempotency — không còn trùng sequence); **lane which resolve KHÔNG ghi ledger — flag hygiene cho coordinator** (mọi suite live autoMigrate đều bị chặn giữa đường bởi nó: p8-02b/p8-02c/p8-02-fault-recovery/runtime.test/usage-projection/p4-05/p4-08...).

**Kết quả chặng 2 (~05:10→05:12:04):** `rearm-0/2/3/4 PASS` live — **đây là lần đầu tiên surface + alive-skip CAS + terminal fence + /health.queueIntegrity có bằng chứng SỐNG**; `rearm-1` đỏ `:305 r1.rearmed=0`. Chẩn đoán của packet ĐÚNG ở chặng này: PG timestamptz μs vs JS Date ms ⇒ CAS `dispatched_at = $2` không bao giờ khớp với stamp do dispatcher ghi `now()` — **product defect, mọi re-arm production sẽ fail y hệt**, offline fake-db không bắt được (che difference round-trip). Suite p8-02c sinh ra để bắt đúng loại này.

**Hai việc dispatch giao — hoàn thành:**
1. **Kiểm `dispatchAndAge`:** test KHÔNG có lỗi — aging giữ `now()` μs-native của PG là CHỦ Ý ĐÚNG; nếu truncate phía test thì defect class bị che vĩnh viễn. Thêm comment phòng thủ `DO NOT fix toward ms` vào helper (edit comment-only, recompile 5 skipped exit 0). Không đổi assertion.
2. **Hotfix Qwen-1 (src 05:22:26, W49-QW1-6 "CAS-ms hotfix")** — ĐỌC TRỰC TIẾP `QUEUE_INTEGRITY_REARM_SQL`: `date_trunc('millisecond')` CẢ HAI VẾ, fence vẫn loại stamp millisecond muộn, comment ghi rõ nguồn Tester Round 7. VERIFY OFFLINE LẠI TRÊN SRC MỚI: `npm run lint` exit 0; sweep Qwen-1 **8/8** + probe tôi **4/4** = **12/12 exit 0**; p8-02c compile 5 skipped exit 0. **Cờ đỏ duy nhất: dist 05:04:54 < fix 05:22:26** ⇒ dist HIỆN CŨ HƠN HOTFIX — A6fb9 bắt buộc `npm run build` + gate nhanh `findstr /m date_trunc dist\modules\runtime\runtime.js` trước khi claim.

**Nộp A6fb9 (vòng 7′):** 3 lần liên tiếp p8-02c với `DU_LIVE_INFRA=1 DU_MM05_REARM=1` + `--forceExit` (cho phép, cùng ghi chú như Tester chặng 2 — chỉ đóng handle sau summary); kỳ vọng **5/5 exit 0 ×3**; fail-path guidance nếu rearm-1 vẫn 0 (kiểm cast `$2::timestamptz`) — cấm sửa test lách. **Vòng 8 spec đã ghim** (flip p8-02b MM-05c: key-set 4→5 + drive seam sau age+wipe + state∈enum → RUN REQUEST p8-02b 6/6×3) — Qwen-2 thực hiện flip NGAY SAU receipt 7′ xanh.
Ledger: docs/29 A6fb8 ANSWER (2 chặng) + A6fb9; docs/35 §8 addendum; p8-02c comment. **P8-02 vẫn [~]** (reconstruction live = chờ 7′; durable-health một nửa đã sống, flip p8-02b = 8). Không DB phía tôi; không tick/commit/push.

**TRANG THAI (cycle 85):** `vong7=2-chang: blocked-migration(da-resolve) → 4/5 (rearm-1 CAS-μs = PRODUCT defect, hotfix src 05:22, dist lagging)` · `seam+health 3/4 milestone Da LIVE-XANH` · `dispatchAndAge: test dung, giu nguyen, them comment phong thu` · `A6fb9 vong 7-phai da nop (rebuild + findstr gate + --forceExit + 5/5×3)` · `vong 8 flip p8-02b SOAN SAU receipt 7-phai` · P8-02 [~] · reconcile = quyen coordinator.

## Nhật ký (tiếp)

- 05:4x (25/09) — CYCLE 85: soi tester.md:1450-1912 → packet bỏ sót chặng 5/5-blocked (migration 0011 collision, nay da resolve, lane resolve thiếu chữ ký — flag); chặng 2 4/5: rearm-0/2/3/4 LIVE-XANH (milestone đầu tiên), rearm-1 = CAS-μs product defect → xác nhận hotfix date_trunc src 05:22 + tự verify 12/12 + lint 0; phát hiện dist lag hotfix → A6fb9 vòng 7′ kèm rebuild-gate + findstr date_trunc + --forceExit allowed; kiểm dispatchAndAge: test đúng, thêm comment phòng thủ; docs/35 §8; vòng 8 spec ghim sẵn. Standby chờ receipt 7′. — Mục 38.
## 39 — CYCLE 87: 7′ — **CAS HOTFIX XANH LIVE (rearm-1 E2E)**; rearm-3 đỏ do THI CÁCH LY TEST của chính tôi — đã sửa hermetic + nộp A6fb10 (7″) (2026-09-25 ~05:5x +07; Qwen-2 / `term_4d79e7d3`)

**Receipt 7′ (tester.md:1914-2047):** build gate + findstr date_trunc PASS, 2/2 healthy, window 05:31:13.913, 3 run `--forceExit`: **4/5 ×3 — rearm-0/1/2/4 XANH**; **rearm-1 E2E live green = bằng chứng sống đầu tiên của cả chu trình reconstruction** (wipe→rearmed→republish CÙNG jobId→claim→complete→SUCCEEDED, 0 TIMED_OUT, 0 duplicate) — hotfix date_trunc được xác nhận bằng DB thật, đúng như dự đoán offline của tôi + Qwen-1. rearm-4 xanh: health cache seam sống.

**rearm-3 = bug CỦA TÔI (nhận thẳng):** `expect(r3.rearmed).toBe(0)` là assert TOÀN CỤC trong khi obliterate của rearm-3 xoá cả job của rearm-2 (row READY aged, sống sót từ test trước) ⇒ sweep tái tạo ĐÚNG row ấy (product đúng spec) ⇒ đếm全局 nhiễm. Per-row fence của rearm-3 (job không revive + row không de-arm) thực ra vẫn đúng — chỉ dòng global là sai thiết kế cách ly.

**Fix đã áp vào p8-02c (chỉ file test, không đụng src/dist):**
1. rearm-2 cuối test: `await claimComplete(taskId, 'w-rearm2')` + comment giải thích bài học 7′ (hermetic).
2. rearm-3: giữ global canary (=0, giờ an toàn) + chú thích per-row assertions mới là chứng cứ fence chính.
3. rearm-4 THẮT: `swept.state === 'RECONSTRUCTING'` + `qi.state RECONSTRUCTING` + `body.status ok` — deterministic sau cách ly (wrapper call đầu tiên, candidate duy nhất = row của chính test); không nới lỏng gì.
4. (Sự cố nhỏ tự sửa ngay: e4 đầu tay xoá mất 3 assert typeof/cache-equality → restore đủ.)
Offline re-verify: `npx jest tests/integration/p8-02c... ` (không gate) = **5 skipped exit 0** — compile sạch. Không cần rebuild dist (change nằm ở file test, ts-jest đọc source).

**NỘP A6fb10 (vòng 7″):** cùng lệnh 7′ (DU_LIVE_INFRA + DU_MM05_REARM + --forceExit, 3 lần), kỳ vọng **5/5×3 exit 0**; kèm đề nghị chạy luôn regression p8-02b 6/6 trong cùng window (xác nhận fix mới không đụng p8-02b — flip MM-05c chính thức vẫn dành vòng 8); routing Tester `term_c9d336eb`. Ledger: docs/29 A6fb9 ANSWER + A6fb10; docs/35 §9; p8-02c.

**TRANG THAI (cycle 87):** `7′ = 4/5x3: reconstruction E2E LIVE-XANH (rearm-1), health cache LIVE-XANH (rearm-4), alive-skip LIVE-XANH (rearm-2), surface LIVE-XANH (rearm-0) · rearm-3 = isolation bug cua TOI, da fix hermetic (khong doi assertion san pham)` · `A6fb10 (7″) da nop — kiem vong 5/5×3 de CHOT chan reconstruction` · `von 8 = flip p8-02b MM-05c (soan sau receipt 7″)` · P8-02 [~] · reconcile quyen coordinator · khong mo DB, khong tick/commit/push.

## Nhật ký (tiếp)

- 05:5x (25/09) — CYCLE 87: đọc receipt 7′ (rearm-0/1/2/4 live PASS ×3, rearm-3 global-assert nhiễm rearm-2) → nhận lỗi cách ly về phía suite, sửa p8-02c: rearm-2 self-clean bằng claimComplete, rearm-3 per-row làm chứng cứ chính, rearm-4 thắt RECONSTRUCTING+status ok; restore 3 assert lỡ tay; recompile 5 skipped exit 0; nộp A6fb9 ANSWER + A6fb10 vòng 7″ (kèm tuỳ chọn chạy kèm p8-02b 6/6 trong window); docs/35 §9. Standby chờ 7″. — Mục 39.
## 40 — CYCLE 88 (NOTIFY): Tester ĐANG mở window chạy 7″ (A6fb10) — Qwen-2 STANDBY theo dõi tester.md; FLIP SPEC cho MM-05c ĐÃ SOẠN XONG ĐẾN TỪNG DÒNG, sẵn sàng áp trong 1 edit khi 7″ xanh (2026-09-25 ~06:0x +07; Qwen-2 / `term_4d79e7d3`)

**Trạng thái kiểm tra tươi (turn này):** tester.md chưa có block A6fb10/Round 7″ ⇒ window đang chạy. KHÔNG sửa p8-02b bây giờ (2 lý do: (1) dispatch gate flip trên 7″ xanh; (2) A6fb10 có thể chạy KÈM p8-02b 6/6 trong cùng window — sửa file lúc Tester đang đọc = race chính fleet rule).

**De-risk đã làm turn này:** `dist/server.d.ts:213-214` expose THẲNG `runQueueIntegritySweep: () => Promise<QueueIntegrityHealth>` + `queueIntegrityHealth` + `dispatcher` trên App ⇒ flip p8-02b KHÔNG cần cast P802cApp (khác p8-02c — cast ở đó vẫn giữ, vô hại).

### FLIP SPEC — p8-02b MM-05c (áp nguyên văn khi 7″ xanh; thay toàn bộ test hiện hành :288-303)
```ts
    test('MM-05c (FLIP cycle 88 — post-implementation): real dispatch + wipe + sweep => /health serves durable queueIntegrity RECONSTRUCTING; key-set 4->5', async () => {
      const { taskId } = await submitOperation('mm05c');
      expect(await app!.dispatcher.dispatchOnce()).toBeGreaterThanOrEqual(1); // real dispatch stamps the row
      const row = (
        await app!.db.query<{ id: string }>(
          `SELECT id FROM outbox WHERE aggregate_id = $1 AND type = 'task.dispatch' ORDER BY dispatched_at DESC NULLS LAST LIMIT 1`,
          [taskId]
        )
      ).rows[0]!;
      await app!.db.query(`UPDATE outbox SET dispatched_at = now() - interval '5 minutes' WHERE id = $1`, [row.id]); // past default 30s grace
      await queue!.obliterate({ force: true }); // queue data lost before claim
      const swept = await app!.runQueueIntegritySweep(); // production wrapper = the only writer of the health cache
      expect(swept.state).toBe('RECONSTRUCTING');
      const health = await http(baseUrl, '/health');
      expect(health.status).toBe(200); // D2: durable signal, no LB flap
      expect(health.body.status).toBe('ok');
      expect(Object.keys(health.body).sort()).toEqual(['activeLeases', 'db', 'queueIntegrity', 'redis', 'status']); // KEY-SET 4->5
      const qi = health.body.queueIntegrity as Record<string, unknown>;
      expect(qi.state).toBe('RECONSTRUCTING');
      expect(typeof qi.lastSweepAt).toBe('string');
      expect(qi.lastSweepAt).toBe(swept.lastSweepAt); // /health serves the cache
    }, 25_000);
```
Ghi chú spec: dispatchOnce cũng republish các row CHƯA dispatch của MM-05a/b (undispatched từ trước) — vô hại: các assert cũ không đọc queue/outbox sau đó; obliterate dây chuyền chỉ xoá job. Cần xoá CẢ comment characterization cũ (đoạn server.ts:433-461 + docs/31 correction) vì đã flip. Header file p8-02b: thêm dòng flip-note + version round.

### A6fb11 Skeleton (nộp ngay SAU khi áp flip + offline compile 6 skipped exit 0)
- Vòng 8: root du-rework, 3 LAN: `$env:NO_PROXY = '127.0.0.1,localhost'; $env:DU_LIVE_INFRA = '1'; npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand` (KHÔNG cần DU_MM05_REARM — p8-02b không gate đó).
- Literal mỗi lần: `Test Suites: 1 passed, 1 total` / `Tests: 6 passed, 6 total` 0/0 exit 0 ⇒ chốt CHÂN DURABLE-HEALTH của MM-05 (reconstruction đã chốt ở 7″).
- Routing Tester term_c9d336eb; prerun healthy-gate; giữ thông lệ --forceExit nếu open-handle lặp lại.

**TRANG THAI (cycle 88):** `7″ dang chay (chua co receipt) · p8-02b CHUA DONG (tranh race window) · flip spec + A6fb11 skeleton LƯU TẠI ĐÂY — ap = 1 edit + compile + nop RUN REQUEST · de-risk: dist .d.ts expose seam day du` · P8-02 [~] · standby vong 2 (loop wakeup kiem tra tester.md).

## Nhật ký (tiếp)

- 06:0x (25/09) — CYCLE 88 notify: tester.md chua co A6fb10 => window 7″ dang chay; khong sua p8-02b (tranh race + gate tren receipt). Check dist/server.d.ts: seam queueIntegrity du typed => flip khong can cast. Soan FLIP SPEC (MM-05c: dispatchOnce that + age 5m + obliterate + runQueueIntegritySweep + key-set 5 + RECONSTRUCTING + cache equality) va A6fb11 skeleton p8-02b 6/6x3. Dat loop wakeup ~6 phut kiem tra receipt. — Muc 40.
## 41 — CYCLE 88 HOÀN THÀNH: 7″ XANH 5/5×3 (MM-05 reconstruction CHỐT LIVE) → FLIP MM-05c ĐÃ ÁP + A6fb11 VÒNG 8 ĐÃ NỘP (2026-09-25 ~06:0x +07; Qwen-2 / `term_4d79e7d3`)

**Theo thứ tự đã làm (đúng gate cycle 88):** (1) Verify receipt 7″ tester.md:2049-2123 trước khi sửa — build-gate 0/0, window 05:53:11.601→05:53:40.726, 3× `Tests: 5 passed, 5 total` exit 0 ⇒ **chân reconstruction của MM-05 CHỐT bằng chứng sống** (cả 5 milestone: surface/E2E-re-arm/alive-skip/terminal-fence/health-cache). (2) Đọc block MM-05c trên đĩa (nguyên trạng so với §40). (3) **FLIP theo đúng spec §40**: test mới `MM-05c (FLIP cycle 88...)` — `dispatchOnce` THẬT → age `dispatched_at` 5′ → `obliterate` → **`app.runQueueIntegritySweep()`** (chỉ wrapper được viết cache — raw seam không được fake durable signal) → key-set **5 khóa** `activeLeases,db,queueIntegrity,redis,status` → `state=RECONSTRUCTING` → `qi.lastSweepAt === swept.lastSweepAt` → `body.status ok` (D2). Header file + flip-note (lý lịch characterization→durable). (4) Offline compile: **`6 skipped, 6 total` exit 0** (gate DU_LIVE_INFRA — zero DB, đúng lane). (5) docs/29: **A6fb10 ANSWER** + **A6fb11 RUN REQUEST vòng 8** (p8-02b 6/6×3, không cần DU_MM05_REARM, hướng dẫn đọc-tên-test để bắt file-cũ, fail-triage 3 nhánh, giữ thông lệ --forceExit có ghi chú). docs/35 §10.

**Tính liêm chính ledger:** flip CHƯA có bằng chứng sống — chỉ là assertion mới trên đĩa; vòng 8 mới là nơi nó được xét. Không tick gì thêm. Nếu receipt 8 in tên test characterization CŨ ⇒ Tester chạy nhầm file — A6fb11 đã ghi rõ cách phát hiện.

**TRANG THAI (cycle 88 t2):** `7″ = 5/5x3 exit 0 (test isolation fix cycle 87 confirmed) — MM-05 chan reconstruction DONG bang chung song` · `p8-02b MM-05c FLIPPED tren dia + compile 6 skipped exit 0` · `A6fb11 vong 8 da nop — kiem 6/6x3 exit 0 de dong chan durable-health` · `MM-05 con DUNG 1 hang doi receipt` · P8-02 [~]; receipt 8 xanh => de nghi coordinator reconcile [x] (quyen coordinator) · standby, khong mo DB, khong tick/commit/push.

## Nhật ký (tiếp)

- 06:0x (25/09) — CYCLE 88 t2: verify receipt 7″ (5/5x3 exit 0, tester.md:2049-2123) => reconstruction CHOT; ap FLIP MM-05c p8-02b dung spec §40 (dispatch that + age + obliterate + runQueueIntegritySweep + key-set 5 + RECONSTRUCTING + cache-eq; header flip-note); offline compile 6 skipped exit 0; nop A6fb10 ANSWER + A6fb11 (vong 8, p8-02b 6/6x3, routing term_c9d336eb); docs/35 §10. MM-05 con 1 hang doi receipt. Standby. — Muc 41.
## 42 — CYCLE 89: **VÒNG 8 XANH 6/6×3 EXIT 0 ⇒ MM-05 ĐÓNG CẢ HAI CHÂN BẰNG CHỨNG SỐNG — ĐỀ NGHỊ CHÍNH THỨC RECONCILE P8-02 [~]→[x]** 🏁 (2026-09-25 ~06:1x +07; Qwen-2 / `term_4d79e7d3`)

**Receipt verify (tester.md:2125-2188+):** window 06:01:54.568→06:02:21.545, build+tsc 0/0, 3× `Tests: 6 passed, 6 total` ExitCode 0 — FLIP MM-05c (key-set 5 + RECONSTRUCTING + cache-equality) xanh LIVE; 5 test còn lại (MM-05a/b, MM-10a/b/c) không hồi quy. Kèm 2 sự thật phụ: Tester phát hiện `infra/docker-compose.yml:48` thiếu quote (`REDIS_KEY_PREFIX: du:connector:test:`) làm `docker compose ps` yaml-fail — đã đi đường vòng docker inspect, KHÔNG sửa file (đúng discipline); prerun build gate vì thấy src changes — exit 0.

**Bảng 4/4 điều kiện đóng P8-02 (gate review.md cycle 72-77 + FOLLOWUP:56) — TẤT CẢ LIVE, TẤT CẢ ×3:**
| # | Điều kiện | Vòng | Receipt |
|---|---|---|---|
| 1 | MM-10b lật 410 TASK_TERMINAL + lease-not-extended | 4 | 6/6×3, tester.md:440-493 |
| 2 | Guard-order stale-epoch vẫn 409 (build §31) | 6b | 20/20, tester.md:1394-1448 |
| 3 | MM-05 reconstruction E2E (re-arm CAS, same jobId, 0 TIMED_OUT) | 7″ | 5/5×3, tester.md:2049-2123 |
| 4 | MM-05 durable health (queueIntegrity RECONSTRUCTING; deadline = escape hatch) | 8 | 6/6×3, tester.md:2125+ |

**ĐỀ NGHỊ RECONCILE (quyền coordinator — tôi không tick):** chuyển P8-02 `[~]`→`[x]` trong `tasks/P8-release-readiness.md` + docs/35 R14/R15. HAI điểm JUDICATE nêu thẳng (đừng để bị surprise nếu reviewer giữ chữ cũ): (a) FULL-REWORK-REVIEW-2026-09-24:72 có sub-câu "deadline/wait expiry tự tiến triển không cần Admin gọi tay" — code VẪN admin-only (`server.ts:1304` + `admin-actions/dispatcher.ts:226`, không timer); bản FOLLOWUP:56 mới hơn chỉ đòi "forced deadline→TIMED_OUT chỉ là escape hatch" ⇒ gate hiện hành THỎA, nhưng nếu coordinator muốn đúng chữ 24/09 thì mở follow-item riêng (đề xuất: timer `lifecycle.sweepDeadlines` trên recoveryTimer — scope nhỏ, đã có test seam pattern); (b) 2 suite offline mới (`mm05-queue-integrity-sweep` 8/8, `mm05-queue-integrity-offline.functional` 4/4) chưa có dòng baseline — việc của fleet owner.

**Cờ dispatch tiếp (ngoài P8-02):** (1) fix quote `infra/docker-compose.yml:48` — 1 dòng, lane infra/connector, chặn bước 0 của mọi RUN REQUEST tương lai; (2) hàng chờ docs/29 phía lane tôi: HẾT — không pending.

Ledger cycle 89: docs/29 A6fb11 ANSWER (+compose flag) ✅ · docs/35 R15 row mới + §11 addendum (bảng 4/4 + đề nghị reconcile + 2 điểm judicate) ✅ · qwen2 §42 ✅. Chuỗi 4→6b→7→7′→7″→8 đóng trọn gói MM-05+MM-10b+guard-order mà lane này nhận từ cycle 78 tới giờ — không tick, không commit/push, không DB phía tôi.

**TRANG THAI (cycle 89):** `MM-05 DONG CA HAI CHAN bang chung song x3 (7″ + 8) · P8-02 DU 4/4 DIEU KIEN — de nghi coordinator reconcile [x] (kem 2 diem judicate trung thuc)` · `hang doi docs/29 lane toi = 0` · `co phy: docker-compose.yml:48 thieu quote (flagged, chua ai sua)` · `san sang nhan goi tiep theo hoac dong lane P8-02`.

## Nhật ký (tiếp)

- 06:1x (25/09) — CYCLE 89: verify receipt 8 (6/6x3 exit 0, tester.md:2125+) => MM-05 ca hai chan CHOT; ghi A6fb11 ANSWER + flag docker-compose:48; docs/35 them row R15 (p8-02c 5/5x3) + §11 (bang 4/4 dieu kien P8-02, de nghi reconcile [~]->[x], 2 diem judicate: deadline auto-progress van admin-only + 2 offline suite chua co baseline row); qwen2 §42. Lane P8-02 hoan thanh — cho coordinator quyet reconcile. — Muc 42.
## 43 — CYCLE 90: ADM-BASE-03 SAFE ERROR BOUNDARY — XÓA SẠCH RAW-ECHO String(err)/err.message TRÊN MỌI SURFACE; SUITE OFFLINE 18/18 + REGRESSION 578/578; ZERO DB WINDOW (2026-09-25 ~06:4x +07; Qwen-2 / `term_4d79e7d3`)

**Hiện trạng (packet map là ảnh chụp cũ):** boundary của `server.ts` + `errors.ts` ĐÃ sạch từ W46-C2 (sanitizedInternalError + log class-only). Leak `String(err)`/`err.message` THẬT còn sống ở: `app/admin/shell-server.ts` (2 sites — raw echo thẳng vào text/HTML response của admin origin), 6 file `*-section-data.ts` (8 sites — message đưa thẳng vào trang), `http/ingress.ts:106` (detail 400 = message thô), và 1 catch NUỐT IM LẶNG (`writeResponseAsync` — không leak nhưng operator mất signal).

**Đã sửa — centralize vào errors.ts (nguồn chân lý duy nhất):**
1. `http/errors.ts` thêm 3 helper: `errorClassOf(err)` (class-only), `safeTransportErrorText(prefix)` (fixed redacted copy), `safeInternalErrorProblem(correlationId)` (giữ Y HỆT shape 500 W46-C2: stable code + correlationId).
2. `server.ts`: 2 local functions thay bằng alias import (behavior-preserving). `ingress.ts`: `failMalformed(errorClassOf(err))`.
3. `shell-server.ts`: 2 echo sites → `safeTransportErrorText('Internal error')` + console.error class-only; catch của deferred extras GIỮ hợp đồng degrade-to-safe-pane nhưng THÊM log `errorClass` (joinable signal trở lại).
4. 6 file section-data: message → `safeTransportErrorText(...)`; overview `__err` → `AbortError→'aborted' : errorClassOf(err)` (bảo toàn phân loại timeout có test cũ); xóa `firstErr` dead.
5. Ngoài phạm vi: `dispatcher.ts:60 String(err)` là điều khiển nội bộ dedup BullMQ, không vào response/log → để nguyên, ghi chú.

**Test mới (offline, zero DB/Redis): `services/orchestrator/tests/adm-base-03-safe-error-offline.functional.test.ts` — 18/18 exit 0.** Sentinel 3 hình thức (bearer secret / path key-file / DSN mật khẩu) được bơm qua: helper shape; ingress stream-error boundary (400, detail class-only); fetchApiKeys/fetchOverview với `fetchImpl` reject sentinel (message == redacted cố định; nhánh AbortError→'Timed out...' giữ nguyên); admin-shell E2E thật (signCookie + throwing fetcher, 127.0.0.1 ephemeral — wire sạch sentinel, status đúng hợp đồng degrade-200, log class-only xuất hiện); và 10 STRUCTURAL PINS trên mọi file đã sửa (chống tái phát `?? String(err)`, `String(err)`, `failMalformed(err.message)`, `"Internal error: " +` — chỉ soi code, ignore comment).

**Verify chain:** `npm run lint` (tsc cả cây) exit 0; regression offline các suite liên quan: admin-shell-server/render/router/auth/platform-mount + suite mới = **301/301 exit 0**; 6 view-model + admin-error-boundary(W46) + mm05×2 + r24 + workspace-reference = **277/277 exit 0**. Tổng **578 assertion xanh; không DB window nào do tôi claim.**

**⚠ Tự giác report 1 slip discipline:** batch regression của tôi có kèm `admin-error-boundary.test.ts` — suite W46-C2 này KHÔNG gate `DU_LIVE_INFRA` (header ghi lane không tự chạy nhưng code không chặn) ⇒ nó boot THẬT vào PG :5433 (containers còn UP sau vòng 8). Không damage (isolated schema, chỉ đọc + 1 request 500, PASS) nhưng là chạm DB ngoài window. Đề xuất lane owner thêm gate; quy trình của tôi từ giờ: đọc gate header từng suite trước khi batch.

**Đề xuất cho coordinator (packet lệnh zero-window nên tôi KHÔNG nộp docs/29):** khi queue cho phép, live re-verify rẻ cho ADM-BASE-03 = chạy lại `admin-error-boundary.test.ts` (cũ, cần thêm gate) + một vòng p8-04-security-isolation; nhớ `npm run build` vì integration suite đọc DIST (shell/section-data/error paths vừa đổi).

**TRANG THAI (cycle 90):** `ADM-BASE-03 source-complete offline: raw-echo = 0 site trong HTTP/render surface (grep + pin verify) · helpers centralized errors.ts · log signal khôi phục ở 3 catch · suite 18/18 + regression 578/578 + lint 0 · slip gate tự phát hiện + flagged · live re-verify de nghi khi co window · khong commit/push; DB window: 0.`

## Nhật ký (tiếp)

- 06:4x (25/09) — CYCLE 90 ADM-BASE-03: khảo sát chỉ ra packet map cũ (boundary server/errors sạch từ W46-C2); leak thật ở shell-server (2) + 6 section-data (8) + ingress (1) + 1 swallow-im-lặng; sửa hết + centralize 3 helper vào errors.ts; test mới 18/18 offline (sentinel 3 loại qua wire/log/page + 10 structural pin chống tái phát); regression 578/578 exit 0; lint 0; TỰ PHÁT HIỆN slip: batch include admin-error-boundary thiếu gate → chạm :5433 thật (không damage, PASS) — flag + đổi quy trình batch. Live re-verify để ngỏ cho coordinator xếp window. — Mục 43.
## 44 — CYCLE 94: VAULT-01 CONTRACTS & SCHEMA — VaultKv2Ref + secret-guard + revision lifecycle XONG, TOÀN BỘ OFFLINE, DB WINDOW = 0 (2026-09-25 ~07:0x +07; Qwen-2 / \`term_4d79e7d3\`)

**Deliverables (3/3 packet):**
1. \`packages/contracts/src/vault.ts\` (MỚI, export qua \`src/index.ts\`): \`VaultKv2RefSchema\` (account/mount/path/key + version optional) + \`VaultKv2PinSchema\` (version BẮT BUỘC — đúng chữ "revision pin immutable source/version") + \`ConnectorRevisionStateSchema\` ('PENDING'|'ACTIVE'|'RETIRED') + \`ConnectorRevisionConfigSchema\` (STRICT) với secret-guard 2 lớp: deny-list TÊN header (authorization/x-api-key/apikey/secret/token/credential/password/… nhận cả prefix/suffix + hoa-thường) VÀ heuristic GIÁ trị credential-shape (Bearer/Basic, sk-, sk_live_, gh[pousr]_, xox[baprs]-, AKIA+16, PEM, inline k=v, JWT-shape). Issue/message CHỈ echo header NAME, không bao giờ VALUE. \`assertNoPlaintextSecrets()\` throw mã ổn định \`PLAINTEXT_SECRET_IN_CONFIG\`. Path traversal fail-closed: '..' mọi chỗ, '%' cấm toàn phần (chặn %2f/%5c/%2e), backslash, whitespace/control, segment rỗng/đầu/cuối, \`~\`, max 16 segment / 128 char.
2. \`services/connector/src/db/migrations/006_connector_revision_lifecycle.sql\` (MỚI, style 005): normalize rows 'DISABLED' → 'RETIRED' TRƯỚC khi rebuild CHECK thành ('PENDING','ACTIVE','RETIRED'). Legacy-safe: writer PUT revisions chỉ ever phát 'ACTIVE' (http/server.ts:132-144), reader so \`!== 'ACTIVE'\` (services.ts:68/167) — không code path nào khác bị động. CHƯA APPLY — file on-disk, chờ runner PgSqlClient.migrate của Tester (packet cấm window nên tôi KHÔNG tự chạy, KHÔNG nộp RUN REQUEST).
3. \`packages/contracts/tests/vault-ref.test.ts\` (MỚI): \`Tests: 58 passed, 58 total\` exit 0 — positive parse; pin-vs-ref version; traversal/encoded-separator/character/shape/bounds negatives (36 case fail-closed); state enum (chặn 'DISABLED'); secret-guard names×9 + values×8 + strict-root-smuggle + message không-leak-value; assertNoPlaintextSecrets throw/ok.

**Verify chain (tất cả offline):** contracts full package \`8 suites / 138/138\` exit 0 · contracts \`lint\` + \`build\` exit 0 (dist .d.ts mới cho consumer) · orchestrator \`npm run lint\` (tsc cả cây, check mặt phẳng re-export) exit 0. 2 bug test-side của CHÍNH tôi phát hiện & sửa trong lúc iterate (case-sensitivity assertion; độ dài AWS key) — source validator ĐÚNG từ đầu, không sửa để lách.

**⚑ Flag trung thực — gate SEC-00:** bảng task ghi VAULT-01 dependency SEC-00, mà \`docs/15-decisions.md\` + gates CHƯA có ADR Vault/SEC-00. Phạm vi tôi làm = types + validation + migration file (không client/transport OIDC-Vault nào) — hợp lệ theo "lỗi nền độc lập có thể sửa ngay", nhưng các QUYẾT ĐỊNH SEC-00 thật (default version=latest hay bắt buộc pin; mount/prefix naming; account thuộc tenant hay dùng chung) đang nằm TRONG validator của tôi dưới dạng lựa chọn an toàn nhất (ref cho phép latest, pin bắt buộc version). Khi SEC-00 duyệt khác, chỉ cần nới/vặt schema — test đã cover cả hai hướng. Đề nghị coordinator xác nhận thứ tự.

**TRANG THAI (cycle 94):** \`VAULT-01 contracts+schema+tests HOAN THANH offline (58/58 moi, 138/138 package, lint+build 0, orch lint 0) · migration 006 on-disk UNAPPLIED (ro ri, doi runner cua Tester trong window tuong lai) · gate SEC-00 chua co ADR — da flag, cac lua chon schema hien tai la fail-closed defaults co the dieu chinh` · khong commit/push; DB window: 0.

## Nhật ký (tiếp)

- 07:0x (25/09) — CYCLE 94 VAULT-01: viết contracts/src/vault.ts (VaultKv2Ref/Pin + revision-state enum + config secret-guard 2 lớp name/value, strict, no-value-echo) + export index; migration 006 rebuild CHECK PENDING/ACTIVE/RETIRED + normalize DISABLED→RETIRED (chưa apply); tests/vault-ref.test.ts 58/58 exit 0; full contracts suite 138/138; lint+build contracts 0; orchestrator lint 0; sửa 2 bug test-side của mình trong iterate; flag SEC-00 ADR chưa tồn tại cho coordinator. — Mục 44.
## 45 — CYCLE 95: VAULT-02 POLICIES & DEV FIXTURE — writer/reader tách quyền THEO CODE (không phải quy ước), worker/browser cấm tuyệt đối, fixture CAS+mask+renewal+outage chạy offline; 22/22 mới + 160/160 package; DB WINDOW = 0 (2026-09-25 ~07:2x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) Máy tính danh tính & chính sách — \`packages/contracts/src/vault-policies.ts\` (MỚI, export qua index):**
- \`vaultPolicyFor(actor)\`: 'orchestrator-writer' = write + metadata-read (CAS discovery) — **KHÔNG read data, writer không bao giờ thấy plaintext**; 'connector-reader' = read + metadata-read — **không write**; 'worker' | 'browser' = \`hasVaultIdentity: false\`, mọi capability \`NO_VAULT_IDENTITY\` — cấm trực tiếp Vault, cài bằng CODE không phải quy ước.
- \`evaluateVaultAccess()\` thuần túy, thư tự đánh giá = hợp đồng bảo mật: identity → token-expiry (ưu tiên trước capability/prefix) → capability → prefix (so theo SEGMENT trọn vẹn — \`du/connector_evil/x\` bị deny, chặn class lỗi string-prefix). Mã từ chối ổn định: NO_VAULT_IDENTITY / TOKEN_INVALID / TOKEN_EXPIRED / CAPABILITY_DENIED / PREFIX_DENIED.
- \`renderVaultPolicyHcl(actor)\` sinh HCL deploy được từ CÙNG nguồn; đã sinh \`infra/vault/policies/{orchestrator-writer,connector-reader,worker-browser}.hcl\` + \`infra/vault/README.md\` (lệnh regenerate + bảng identities). Writer HCL: create/update trên \`secret/data/du/connector/*\` + metadata read/list; reader: read data + metadata; không root token.

**2) Fixture dev — \`packages/contracts/tests/stubs/vault-dev-fixture.ts\`:** engine KV v2 in-memory: version history BẤT BIẾN (pin cũ đọc lại đúng giá trị cũ — nền cho VAULT-06 rollback), CAS (cas sai ⇒ 409 CAS_CONFLICT), metadata ENDPOINT LỘT TRẦN GIÁ TRỊ VỀ MẶT CẤU TRÚC (không phải filter), token TTL với đồng hồ ẢO (renewal hoạt động; token hết hạn CHẾT hẳn — renew báo TOKEN_EXPIRED, phải re-login), revoke ⇒ TOKEN_INVALID, outage \`'unavailable'|'timeout'\` ⇒ VaultError retryable — và error message không bao giờ chứa value (test sentinel-scan). Boot lặp lại được: state mới + id tất định (test chứng minh 2 fixture độc lập).

**3) Test — \`packages/contracts/tests/vault-policies.test.ts\` 22/22 exit 0:** đủ packet-item-3: writer-bị-403-khi-đọc ✓, reader-bị-403-khi-ghi ✓, sai prefix mount deny ✓, renewal/expiry ✓, timeout fail-closed ✓; cộng worker-browser login-throws (cấm ở cửa auth LẪN evaluator), CAS conflict + immutable pin, metadata masking (JSON.stringify không sentinel), revoked token, repeatable boot, error-value-free scan. 3 lỗi test-side của tôi trong iterate (assert-code-vs-message, token-sai-actor trong repeatability, index-narrowing) — source giữ nguyên, sửa test trung thực.

**Chuỗi verify (toàn bộ offline):** full packages/contracts \`9 suites / 160/160 exit 0\` · \`npm run lint\` 0 · \`npm run build\` 0 (dist mới) · orchestrator \`tsc --noEmit\` 0 (re-export surface). Tổng cộng sau cycle 94+95: 160/160 + migration 006 on-disk UNAPPLIED + HCL deployables.

**Ghi chú gate (kế thừa §44):** SEC-00 ADR vẫn chưa tồn tại — scope của tôi là policy-as-data + fixture (không client/transport thật, đúng "nền tảng song song" M1); mount/prefix 'secret:du/connector' vẫn là DEV default, đổi 1 tham số \`scopes\` khi ADR chốt.

**TRANG THAI (cycle 95):** \`VAULT-02 policy engine + HCL deployables + dev fixture + 22-case negative matrix HOAN THANH offline (160/160 package, lint/build 0, orch 0) · worker/browser cam tuyet doi bang code · writer/doc reader tach quyen dung prefix · renewal/expiry/outage/CAS/mask duoc pin bang test that` · DB window: 0 · khong commit/push. Next tu nhien (quyen coordinator): VAULT-03 (SecretResolver + writer flow tren Orchestrator) dung chinh fixture nay.

## Nhật ký (tiếp)

- 07:2x (25/09) — CYCLE 95 VAULT-02: vault-policies.ts (policy-as-data, evaluator thu-tu identity→expiry→capability→prefix, segment-complete matching, HCL generator) + infra/vault/policies/*.hcl + README; dev fixture in-memory KV v2 (CAS, metadata mask cau-truc, virtual-clock renewal/expiry/revoke, outage retryable value-free, repeatable boot); vault-policies.test.ts 22/22; full contracts 160/160 exit 0; lint/build 0; orch lint 0; sua 3 bug test-side cua minh. Gate SEC-00 van tro — plan item 2 cua packet khong yeu cau client that. — Muc 45.
## 46 — CYCLE 96: VAULT-05 SECRET RESOLVER (Connector) — 21 test MỚI xanh, toàn bộ offline; legacy path bảo toàn từng byte; DB WINDOW = 0 (2026-09-25 ~07:5x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) \`services/connector/src/vault/resolver.ts\` (MỚI, export qua index):**
- \`CredentialSource = {kind:'legacy-db'} | {kind:'vault-kv-v2', account, mount, path, key, version?}\` — \`parseCredentialSource\` validate bằng \`VaultKv2RefSchema\` (VAULT-01): undefined/null → legacy-db ** tường minh, không heuristic ngầm trên row cũ**; ref hỏng/loại lạ → CREDENTIAL_INVALID fail-closed.
- \`SecretResolver.resolve(source, refs)\`: vault → reader \`VaultKv2SecretReader\` (chính \`VaultDevFixture\` VAULT-02 chống lưng trong test); giá trị phải **chuỗi không rỗng**, ngược lại CREDENTIAL_INVALID; reader thiếu mà source là vault → CREDENTIAL_INVALID ("legacy fallback forbidden" — SEC-05 cấm fallback); deny (capability/prefix/not-found) → CREDENTIAL_INVALID không retry; retryable (outage/timeout) → **bounded retry** (max 3, backoff base×n, sleep injectable) rồi \`PROVIDER_UNAVAILABLE + safeToRetry\`. legacy → giữ nguyên hành vi store+decrypt.
- \`applyCredentialSlot(config, secret)\`: slot \`credentialSlot\` trên AdapterConfig — mặc định 'bearer' **giống hệt withCredential cũ byte-for-byte** (hồi quy 0); \`header:<Name>\` inject header được duyệt — bỏ đúng điểm "hardcode Bearer cho mọi adapter". \`probe()\` không-throw cho test().

**2) Wiring (services/repository/config/types):** \`DurableConnectorRuntime\` constructor + \`secretResolver?\` optional cuối (composition hiện hành không đổi — vault revision khi chưa có resolver fail closed ngay tại invoke); \`revision.credentialSource\` thêm vào ConnectorRevision (type-only, chưa có cột DB — VAULT-03 sẽ persist); \`test(connectorId)\` NÂNG CẤP THẬT: vault → probe đọc thật; legacy → kiểm credential TỒN TẠI (trước đây chỉ kiểm adapter ACTIVE — đúng lỗi SEC-05 chỉ ra); source parse lỗi → {ok:false,errorCode} không ném. Union state đồng bộ PENDING/ACTIVE/RETIRED ở repository/config/disable() (VIỆT: code cũ ghi 'DISABLED' sẽ CONTRADICT migration 006 — đã kéo về 'RETIRED' cho nhất quán với lifecycle cycle 94; KHÔNG có test cũ nào assert chuỗi 'DISABLED' — grep trắng).

**3) Test \`services/connector/tests/secret-resolver.test.ts\` — 21/21 exit 0, offline tuyệt đối:** 2 keys × 2 pinned versions trả ĐÚNG giá trị vào mock provider (kể cả v1 bất biến sau rotation v2 — nền VAULT-06); missing key/path/version, sai prefix, sai mount, writer-đọc-qua-resolver ⇒ CREDENTIAL_INVALID với **providerCalls === 0 và legacyHits không đổi** (đúng packet item 2); outage: đúng 3 attempt, sleep [10,20], PROVIDER_UNAVAILABLE safeToRetry, **zero legacy fallback**, recovery đọc lại đúng V2; token TTL hết → re-auth trong suốt (renewal); value không bao giờ xuất hiện trong message; test() probe sống chết đúng; default-bearer tương thích ngược; parse fail-closed; legacy path giữ nguyên.

**Chuỗi verify:** connector \`tsc --noEmit\` 0 · \`jest --runInBand\` cả package: **13 passed / 2 skipped (suite live-gate có sẵn, [SKIP-QUALIFIED] — không phải gate của tôi) / 153 passed exit 0** · connector build 0 · orchestrator \`tsc\` 0 (cross-package type surface) · contracts giữ 160/160 từ cycle 95. Sửa nội bộ trong iterate: 1 test-bug của tôi (alt-key nằm version 3 do merge semantics — fixture đúng, test sai) + 1 design-fix source (giữ \`account\` trong CredentialSource cho scope-integrity) + 1 robustness-fix (test() không ném khi source hỏng).

**Viện nối tự nhiên (quyền coordinator):** VAULT-03 persist cột \`credential_source\` (migration + repository mapping) → vault revision đi hết đường HTTP; real Vault client thay bridge fixture khi SEC-00 duyệt. Receipt: \`qwen2.md\` mục này; không commit/push; DB window: 0.

## Nhật ký (tiếp)

- 07:5x (25/09) — CYCLE 96 VAULT-05: resolver.ts (CredentialSource+parse fail-closed, SecretResolver bounded-retry no-legacy-fallback, applyCredentialSlot default-bearer-compat) + wiring runtime/management test() probe that + sync union PENDING/ACTIVE/RETIRED vs migration 006; 21/21 test offline xanh (provider-count-0, renewal, outage, immutable pin); lint/build connector 0, orch 0; 1 test-bug + 2 design-fix trong iterate, ghi trung thu. — Muc 46.
## 47 — CYCLE 97: VAULT-03 CREDENTIAL WORKFLOW (Orchestrator) — 15/15 offline mới, cây unit 29 suites xanh; 4 suite đỏ do LANE KHÁC đang edit giữa, ghi biên bản — DB WINDOW = 0 (2026-09-25 ~08:0x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) \`src/modules/connector-credentials/workflow.ts\` (MỚI):** machine của SEC-04 bằng PORTS (không DB ở tầng này — test được offline):
- \`VaultCredentialWriter\` (writeCas→version, readVersions metadata) — test bind thẳng vào VaultDevFixture bằng identity orchestrator-writer THẬT (CAS + policy do fixture enforce, không stub).
- \`ConnectorRevisionStore\` (get/createPending/activate(expectedCurrent CAS)/retire) — adapter HTTP sang connector API là việc composition/VAULT-03-integration.
- \`rotate\`: value non-empty + ref qua \`VaultKv2RefSchema\` TRƯỚC khi đụng Vault (traversal ⇒ 422, vault-write-count = 0) → vault CAS write → createPending(pin version) → activate(expectedCurrent) ⇒ ACTIVE | PENDING+reconcileRequired. \`reconcile\`: activate lại nếu chain còn chờ nó, NGƯỢC LẠI retire — không bao giờ 2 ACTIVE. \`describe\`: metadata masked (mount/path/key/pinnedVersion/hasValue/versions) — plaintext không đường ra.
- Idempotency: \`IdempotencyPort\` (lookup/store) — replay trả kết quả cũ (revision + vault-write duy nhất), key dùng lại payload khác ⇒ 409, key KHÔNG có port ⇒ 503 fail-closed (không hứa suông).
- Mapping lỗi: CAS_CONFLICT→409 VAULT_CAS_CONFLICT (KHÔNG tạo revision), deny/TOKEN→403, retryable→503, unknown→502 — message không bao giờ chứa value.
- Thứ tự crash theo SEC-04 được CHỨNG MINH bằng test: crash sau-vault-trước-PENDING ⇒ version mồ côi KHÔNG được tham chiếu, ACTIVE cũ không đổi; crash sau-PENDING ⇒ row nằm PENDING (connector từ chối state !== ACTIVE — cycle 96 đã pin) ⇒ reconcile promote/retire.

**2) Route (server.ts):** \`POST + GET /api/v1/admin/connectors/:id/credentials\` — assertAdminAuth TRƯỚC, workflow absent ⇒ 503 fail-closed (structural pin trong test chứng minh thứ tự auth-trước + response không echo value; body.value chỉ vào input-side). Config \`credentialWorkflow?\` injected (ServerConfig + RouteContext), composition chưa nối client thật — đúng gate SEC-00.

**3) Test \`tests/connector-credentials-offline.functional.test.ts\` 15/15 exit 0:** happy+mask, describe không value, traversal-0-write, empty-value, replay 1-revision-1-write, payload-conflict, no-store-503, CAS-0-revision, INTERLEAVED stale-base (đúng 1 ACTIVE mọi thời điểm; loser PENDING→reconcile promote; RETIRED old), sequential chain đúng, 2 crash windows, retire-không-double, sentinel scan, structural route pin. (Iterate: 2 test-bug của tôi — RevisionRow thừa connectorId; model concurrency sai lúc đầu — sửa test, source giữ.)

**Chuỗi verify:** \`test:unit\` (jest.unit.config — 14 live suite loại đúng protocol): **29 suites PASS / 878 tests pass**, gồm suite mới 15/15 + toàn bộ shell/view-model/mm05/adm-base-03/r24. **5 đỏ KHÔNG phải của tôi, ghi biên bản:** (a) 4 suite fail compile vì \`src/modules/artifacts/s3-storage-facade.ts\` duplicate 'Readable' — lane artifacts/S3 đang edit giữa (mtime 07:28:49, chỉ-trước-run-minh-5'), tsc KHÔNG báo lỗi file nào của tôi; (b) \`admin-shell-platform-mount\` 1 case \`ETIMEDOUT 127.0.0.1:59837\` = đúng flaky loopback đã hồ sơ hóa cycle 78/85. \`npm run lint\` cây: chỉ 2 lỗi s3-facade nêu trên. Kết luận liêm chính: scope tôi 100% xanh; tree-level lint chờ lane artifacts settle rồi re-check (đề nghị coordinator dispatch).

**Nối tiếp (quyền coordinator):** connector-adapter cho \`ConnectorRevisionStore\` (gọi PUT /revisions + activate trên connector HTTP) + persist cột \`credential_source\` (migration, connector lane) + wire workflow vào composition khi SEC-00 chốt; real-Vault client sau ADR. Receipt docs/29 chưa cần — chưa có gì chạy live. Không commit/push; DB window: 0.

**TRANG THAI (cycle 97):** \`VAULT-03 workflow + routes + 15/15 offline DONE · cây unit 29/29 scope-xanh (5 đỏ = lane khác/flaky, đã biên bản) · idempotency/reconcile/masking chứng minh bằng test that · composition + credential_source column + real client = viec tiep theo cua coordinator` · P8-family: khong thay doi; G-SEC branch: VAULT-03 unit-level xong, integrated closeout cho sau nay.

## Nhật ký (tiếp)

- 08:0x (25/09) — CYCLE 97 VAULT-03: workflow.ts ports-based (vault CAS→PENDING pin→activate CAS, reconcile promote/retire, idempotency port fail-closed, masked describe) + route POST/GET /admin/connectors/:id/credentials (auth truoc, 503 khi thieu workflow) + ServerConfig/RouteContext injection; test 15/15 offline (fixture writer that, interleaving stale-base = 1 ACTIVE, 2 crash windows, sentinel scan, structural pin); test:unit 29 suites/878 pass; 4 suite do s3-storage-facade lane khac giua-edit + 1 flaky ETIMEDOUT — ghi bien ban, khong sua file lane khac; sua 2 test-bug cua toi trong iterate. — Muc 47.
## 48 — CYCLE 98: VAULT-06 — HTTP ADAPTER + credential_source WIRING + LIFECYCLE 8/8 QUA WIRE THẬT; TOÀN BỘ OFFLINE, DB WINDOW = 0 (2026-09-25 ~08:4x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) Adapter \`services/orchestrator/src/modules/connector-credentials/connector-http-store.ts\` (MỚI):** cài \`ConnectorRevisionStore\` của workflow qua REST draft: GET \`/connectors/:id/revisions/current\` (200→row | 404→undefined đúng port-contract), POST \`/revisions\` {credentialSource} (PENDING clone CURRENT), POST \`.../:rev/activate\` {expectedCurrentRevision} (200→true | 409→false — CAS), POST \`.../:rev/retire\`. Fail-closed nhất quán: transport/timeout ⇒ 503 TEMPORARY_UNAVAILABLE (thông điệp nêu rõ: đừng đoán rằng thao tác chưa xảy ra — reconcile mới là đường sửa), status lạ ⇒ 502 không forward body connector.

**2) Phía Connector — draft contract thành hàng thật:** \`http/server.ts\` thêm 5 routes (`revisions/current`, `revisions/:rev`, `revisions` POST, `.../activate`, `.../retire\`) + `ConnectorHttpStore` 4 members; `DurableConnectorManagement` cài createPendingRevision (**parseCredentialSource THẤT — traversal/legacy/unknown kinds bị chặn tại HTTP edge**, clone từ ACTIVE, không có ACTIVE ⇒ từ chối), activateRevision/retireRevision delegate; `db/repository.ts` + SQL `getActiveRevision` (đọc ACTIVE cao nhất — phân biệt chain-head!), `activateRevision` **một tx với FOR UPDATE trên dòng ACTIVE** (hai activate song song không thể cùng thắng), retire có điều kiện `state='PENDING'`; `credential_source` JSONB trong SELECT/INSERT/toRevision (NULL ⇒ undefined ⇒ legacy-db tường minh, **KHÔNG đổi dạng credentialRef cũ**); migration draft \`007_connector_credential_source.sql\` (additive IF NOT EXISTS, on-disk UNAPPLIED — cùng纪律 với 006).

**3) Wire phát hiện 3 lỗi SEMANTIC thật mà port-fake cycle 97 che khuất (giá trị của e2e qua HTTP):** (a) `get()` production trả chain-HEAD (kể cả PENDING) trong khi workflow cần CURRENT-ACTIVE → sinh `getActiveRevision`/route `current` tách bạch; (b) createPendingRevision clone từ head ⇒ clone luôn PENDING cũ → ép clone từ ACTIVE; (c) activate CAS so với head ⇒ bao giờ cũng false → so với active thật. Đó đúng loại bug mà integrated closeout phải bắt — bắt được ở đơn vị offline này trước khi ai đó tốn DB window.

**4) Test \`connector-revision-http-offline.functional.test.ts\` — 8/8 exit 0** (server connector THẬT từ dist + repo in-memory cùng semantics + adapter THẬT + workflow THẬT + VaultDevFixture): rotate#1 clone→activate; **pin separation**: rev2 retired vẫn giữ credentialSource.version=1 (in-flight deterministic) trong khi current=rev3 pin v2; stale-activate 409 no-op; emergency revoke ⇒ 404 fail-closed SẠCH trước vault-write, zero phantom revision; restart/reconcile promote stranded + retire khi chain moved-on; transport-failure 503 trên cả 4 port-methods; invalid source 400 + zero churn; structural pin migration 007.

**Regression do tôi + đã sửa:** interface `ConnectorHttpStore` mở rộng làm 4 test-doubles của lane fail compile — bổ sung 5 members tối giản vào composition/security-lifecycle/reliability/runtime-foundations → connector **13/13 offline suites, 153 passed**.

**Verify chốt:** connector jest 13 pass (2 skip live-gate sẵn có) · orch `test:unit` **36/37 suites, 970/971** — suite đỏ duy nhất `webhook-error-boundaries.boundary.test.ts` = **red-by-design của lane qwen3 đã ghi nhận từ cycle 95** (không đụng diff này) · lint orchestrator+connector sạch (s3-lane của cycle 97 đã settle — cờ đỏ withdrawn) · contracts 160/160 · \`admin-shell-server\` fail-2-case của run đầu là flaky ETIMEDOUT loopback, chạy đơn lẻ 56/56 xanh.

**TRANG THAI (cycle 98):** \`VAULT-06 HOAN THANH offline: adapter that + contract day du tren ca hai phia + credential_source JSONB (draft 007, UNAPPLIED) + 8/8 qua day wire THAT; 3 semantic bugs that duoc day len nho e2e` · \`con lai cua chuoi VAULT = SEC-00 ADR (client that, prefix chot) + Tester live closeout (migrations 006+007 apply + invocations pin) khi coordinator de xuong window` · khong commit/push; DB window: 0.

## Nhật ký (tiếp)

- 08:4x (25/09) — CYCLE 98 VAULT-06: connector-http-store adapter + 5 routes/4 members phia connector + getActiveRevision/activate-CAS-trong-tx + credential_source JSONB mapping + migration 007 draft; 8/8 lifecycle test qua server THAT tu dist (pin separation, emergency revoke, restart/reconcile, 503 fail-closed, 400 edge); phat hien 3 semantic bugs that qua wire; sua regression 4 test-doubles cua lane (them 5 members) → connector 153 pass; orch tree 970/971 (1 red-by-design qwen3); lint sach. — Muc 48.
## 49 — CYCLE 99: VAULT-04 — ba ADMIN ACTIONS (rotate/revoke/test credential) GAP VÀO DISPATCHER, RBAC admin-only, response masked, fail-closed day du; 20/20 test mới offline; DB WINDOW = 0 (2026-09-25 ~09:2x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) Dispatcher (modules/admin-actions/dispatcher.ts):**
- `ADMIN_ACTIONS` them 3 entries **platform bearer / cookie admin ONLY** (mirror apikey.bind-profile — SEC-00): `connectors.rotate_credential`, \`connectors.revoke_credential\`, \`connectors.test_credential\`. authorizeAdminAction chay TRUOC moi delegate ⇒ denial co **zero side effect** (test chuc min: khong vault-write, khong row, khong marker).
- `AdminActionDeps` them `credentialWorkflow?` + `connectorTest?` (server wire: ctx.credentialWorkflow + ctx.connectors.testConnector) — thieu ⇒ 503 fail-closed ('not wired'), khong bao gio silent pass.
- **rotate**: requireParams connectorId+account+mount+path+key + value write-only + cas optional; thuc thi trong `deps.db.tx` + `executeIdempotent` marker cung tx + audit row `connector.credential_rotate` (severity success, R3-01 pattern) — body = ket qua workflow + `metadata` masked (describe()). Crash-toan ghi chu trong code: marker fail ⇒ DB rollback nhung external effect thuoc reconcile/Idempotency-Key — same math as VAULT-03 ordering.
- **revoke**: `workflow.revoke(connectorId)` → store port members mới `revokeAll?` (HTTP adapter: POST /disable) — moi row RETIRED, khong con ACTIVE nao; audit `connector.credential_revoke` severity **warning**; vo hieu hoa khi khong con active (`revoked:false`); rotate sau revoke ⇒ 404 fail-closed. Store khong ho tro revokeAll ⇒ 501 REVOKE_UNSUPPORTED (khong bao gio partial-revoke im lang).
- **test**: delegate ctx.connectors.testConnector ⇒ **chot mask that chat**: body chi `{connectorId, ok, errorCode?}` — detail/preview tu probe bi loi hoan toan (test dua sentinel vao detail, assert JSON.stringify khong chứa).

**2) Test offline \`tests/admin-actions-vault04-offline.functional.test.ts\` — 20/20 exit 0:** matrix RBAC 10 case (3 action × bearer/cookie/CSRF/unknown); rotate happy (201, masked metadata, 1 ACTIVE duy nhat, marker+audit); **replay** marker-thang-workflow-khong-bao-gio-chay-lai (vault writes = [1]); key reuse khac payload 409; stale CAS 409 **khong revision churn, khong marker**; policy-deny 403 khong tao gi; transport 503 **zero vault-write**; not-wired 503; revoke day du + idempotent + 404 sau do; test-action masked passthrough ca 2 nhanh ok/errorCode; probe khong wired 503.

**3) Verify chain:** orch \`lint\` 0 · \`build\` sach · suite VAULT-04 20/20 · unit tree **38/40 suites, 1013 passed** — 2 suite fail: \`webhook-error-boundaries\` (red-by-design qwen3, ho so san) va \`connector-revision-http-offline\` (cycle-98) fail TRONG TREE nhung **8/8 xanh khi chay don le** = flaky ephemeral-port loopback quen thuoc (ETIMEDOUT; da ho so hoa cycle 78/85/98) — khong phai regression; de nghi Tester re-run tree trong window ky sau neu can tin hieu, hoac lane flaky-owner them retry-port. Khong commit/push; khong mo DB.

**TRANG THAI (cycle 99):** \`VAULT-04 DONE offline: 3 actions gap + RBAC admin-only + masked responses + fail-closed 409/403/503/501/404 day du; khong the sinh orphan ACTIVE (CAS + expected-current + marker proved)` · \`chuoi VAULT-03..06 giu nguyen live-closeout cho window (migrations 006/007 unapplied, real client cho SEC-00)` · \`co so ha tang: 2/40 tree-suite fail da phan loai trong bien ban, khong an lang`.

## Nhật ký (tiếp)

- 09:2x (25/09) — CYCLE 99 VAULT-04: 3 connector credential actions vao dispatcher (table + cases + deps credentialWorkflow/connectorTest; wire server.ts); workflow.revoke + port revokeAll? + adapter POST /disable; test 20/20 (mask/replay/CAS-409/deny-403/transport-503/501/zero-side-effect); lint+build sach; tree 38/40 — webhook-red-by-design + cycle-98-suite flaky trong tree (8/8 don le) ghi bien ban. — Muc 49.
## 50 — CYCLE 101: SEC-INT-01 PREP — TOKEN-RENEWAL DAEMON (dynamic lease, fail-closed, zero-token-log) + SUITE TÍCH HỢP 2-DỊCH-VỤ ĐÃ SOẠN, GATE KÉP; offline compile xanh; DB WINDOW = 0 (2026-09-25 ~09:5x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) \`services/connector/src/vault/token-renewal.ts\` (MỚI, export index):** daemon renewal \`createTokenRenewalDaemon({client, safetyMarginMs, retryBase/MaxMs, minLeadMs, now, schedule, cancel, log})\` — đồng hồ + scheduler TIÊM ĐƯỢC ⇒ test offline tất định, zero timer thật. BẤT BIẾN:
- \`LEASE ĐỘNG\`: mỗi login/renew trả lease mới từ server ⇒ lần kế = (hết hạn − margin) của PHIÊN BẢN ĐÓ, không cố định (test: lease ngắn → sớm hơn, lease dài → muộn hơn).
- \`RENEW TRÊN LEASE ĐÃ CHẾT = KHÔNG BAO GIỜ\` (runOnce sau expiry ⇒ thẳng tay login mới, renewCount=0).
- \`LÚT MẤT ĐIỆN token còn hạn → GIỮ PHỤC VỤ + backoff x2 có trần\`, nhá \`state active\`; nếu lease không còn đủ sống qua backoff ⇒ quay về login sớm (fail-closed hơn là một token sắp chết).
- \`KHÔNG CÓ TOKEN → reader trả undefined\`; \`createRenewalBackedReader\` chặn mọi đọc bằng \`VAULT_UNAUTHENTICATED\` trước khi đụng Vault/provider (test đếm read=0). Sau 5 lần login fail liên tiếp ⇒ công khai state \`unauthenticated\` (không im lặng), tự hồi phục khi auth nền sống lại.
- \`Log chỉ chứa state + số\`: sentinel-token scan trên toàn bộ dòng log/detail (test 11/11).

**2) Suite \`tests/integration/sec-int-01-credential-lifecycle.integration.test.ts\` (SOẠN SẴN, gate kép \`DU_LIVE_INFRA=1 + DU_SECINT=1\` — offline hiện \`5 skipped` exit 0):** 2 dịch vụ THẬT + Postgres THẬT khi window G-SEC được xếp:
- \`pg.migrate()\` qua runner sản xuất ⇒ migrations 001..007 (006 lifecycle + 007 credential_source JSONB) áp THẬT đầu tiên trong chuỗi này;
- Orchestrator \`createApp({credentialWorkflow})\` + route \`/api/v1/admin/connectors/:id/credentials\` → HTTP adapter → connector-server THẬT (\`DurableConnectorManagement\` trên \`PostgresConnectorConfigRepository\`): rotate ×2 (assert \`credentialSource.version\` đọc lại từ DB — chứng minh cột JSONB end-to-end), retired row giữ pin cũ (CAS), \`connectors.revoke_credential\` qua \`/api/v1/admin/actions\` → current 404 + rotate kế tiếp 404 fail-closed;
- daemon reader-over-rotation loop mô phỏng lease turnover không cửa sổ chết;
- \`admin_audit\` + \`admin_idempotency\` query-back: sentinel không xuất hiện trong DB rows.
- \`PHẠM VI GHI RÕ TRONG HEADER\`: provider-invoke e2e (Redis quota + multi-container compose + Vault client thật) là lát TIẾP THEO của cùng gate — suite này chốt phần credential lifecycle.

**3) Verify:** connector \`lint\` 0, \`build\` OK (dist chứa daemon), jest connector **14/16 suites · 164 pass** (2 skip = live-gate sẵn có) — daemon unit **11/11**; root config compile-check SEC-INT suite xanh (`5 skipped` honest). Orchestrator unit tree: 5 suite fail trong-tree NHƯNG chạy đơn lẻ/cluster nhỏ đều xanh (37/37, 8/8, 56/56, 111/111) = flaky ephemeral-port dồn khi chạy ~43 suite liên tiếp (đúng họ ETIMEDOUT cycle 78/85/98/99) — đỏ thật duy nhất vẫn là webhook-error-boundaries red-by-design qwen3. Đề xuất fleet-owner: per-suite port allocator hoặc retry-có-điều-kiện cho ETIMEDOUT trước gate G-SEC.

**Giữ nguyên mọi fail-closed handling chu kỳ 96-99 (daemon kế thừa contract resolver), zero secret logging ở cả 2 tầng mới. Không commit/push; DB window: 0.**

**TRANG THAI (cycle 101):** \`SEC-INT-01 PREP DONE offline: daemon dynamic-lease 11/11 + suite 2-dich-vu soan san gate kep (5 skipped, san sang cho G-SEC window) + runner migrate 001..007 lan dau duoc lap ke hoach that` · \`flaky tree da phan lo bang don le-run, de xuat fleet-owner xu ly goc` · \`SEC-INT follow-on: provider-invoke slice + real-Vault compose sau SEC-00`.

## Nhật ký (tiếp)

- 09:5x (25/09) — CYCLE 101: token-renewal daemon (clock/scheduler tiem duoc, lease dong, giu token khi outage + backoff x2 tran, unauthenticated fail-closed + reauth, sentinel-log-scan) 11/11; createRenewalBackedReader; suite SEC-INT-01 gate kep soan xong (2 dich vu THAT + pg.migrate 001..007 + audit scan), offline 5 skipped exit 0; connector 164 pass, build 0; tree phan lo flaky bang re-run don le (37/37, 8/8...). Khong mo DB. — Muc 50.
## 51 — CYCLE 102: MOCK-VAULT HTTP HARNESS + COMBINED SUITE — **cây unit orchestrator lần đầu SẠCH HOÀN TOÀN 47/47 · 1105/1105**; DB WINDOW = 0 (2026-09-25 ~10:4x +07; Qwen-2 / \`term_4d79e7d3\`)

**1) \`tests/harness/mock-vault/server.ts\` (MỚI):** node:http mock phục vụ đúng 6 endpoints packet — \`/v1/auth/token/create\` (client_token + **lease_id + lease_duration + renewable**), \`/v1/sys/leases/renew\` (tôn trọng renewable: 400 khi false; increment → hạn mới do SERVER cấp), \`/v1/sys/leases/revoke\` (204, hard revoke), \`GET/POST /v1/secret/data/*\` (KV v2: {data:{data,metadata}}, CAS \`options.cas\` → **412 Check-and-Set failed**, version tăng, data merge), \`GET /v1/secret/metadata/*\` (versions **không-value**), 404 default. Máy mô phỏng: đồng hồ ẢO (advance), **expiry counter đúng-một-lần/mỗi-lease**, \`failNextWrite('server-error'|'policy-denied')\`, role path-prefix \`du/connector\` enforce **403 THẬT trên wire**, request-log chỉ route/status/path (không body). \`readValue\` dành cho assert phía test.

**2) \`tests/harness/mock-vault/client.ts\` (MỚI):** \`createMockVaultClient\` phơi CẢ HAI seam sản xuất: \`VaultTokenClient\` cho daemon (403/400→null → đường re-login đã thiết kế) + \`VaultCredentialWriter\` cho workflow (412→CAS_CONFLICT, 403→CAPABILITY_DENIED, 5xx→retryable) + \`revokeCurrentToken()\`. Transport: \`fetchNoPool\`/\`noPoolFetchImpl\` (node:http, Agent keepAlive:false) — vì fetch/undici GIỮ socket và cổng ephemeral bị OS cấp lại giữa các test ⇒ máu xuyên server-cũ→mới (403 ma). \`noPoolFetchImpl\` cũng là giá trị \`fetchImpl\` cho adapter sản xuất khi test.

**3) \`tests/harness/listen-loopback.ts\` (MỚI — bài học hạ tầng):** root cause cuối của chuỗi flaky 78→101: Windows LISTEN được trên cổng động nhưng CHẶN connect (`:54382`→`:61126`→`:59837\` — cùng họ ETIMEDOUT). Harness giờ bind **dải tĩnh 41200–41999** với EADDRINUSE-advance (dải nằm dưới các exclusion WinNAT đã ghi nhận). Cả suite mock-vault + connector-revision-http (cycle 98) chuyển sang helper này ⇒ **20/20 × 4 lần cluster liên tiếp, zero flake**.

**4) Suite phối hợp \`services/orchestrator/tests/mock-vault-harness-offline.functional.test.ts\` — 12/12:** daemon×mock: renew-at-boundary dùng lease SERVER (renewCount+, expiresAt dịch đúng 60s), renewable=false → 400 → daemon re-login (rotation, issued≥3), dead-lease **không bao giờ renew** + expiry counter đúng-một, log không-token; workflow×mock: rotate 2 version + store ACTIVE + readValue đúng SECRET, stale-CAS 412→409 zero churn, prefix-sai→403 THẬT→VAULT_POLICY_DENIED zero write, 5xx→503 NO half-effect rồi retry thành công, revoke-token-on-wire → rotation kế tiếp fail-closed 403 store nguyên, workflow.revoke retire chain + audit masked, metadata wire không-value, sentinel-scan mọi error message.

**Verify chốt:** orchestrator \`test:unit\` **47/47 suites · 1105/1105 passed · exit 0** (lần đầu sạch toàn cây — gồm cả boundary suite của qwen3 đã tự settle), \`lint\` 0; connector daemon 11/11; SEC-INT root suite 5 skipped (gate). Không commit/push; DB window: 0.

**TRANG THAI (cycle 102):** \`MOCK-VAULT HARNESS DONE: 3 file harness + 12-case combined suite; flaky-port-class Diệt TẬN GỐC bằng quiet-band binding (co che ghi thanh trong tests/harness) · cay unit orch LAN DAU 47/47 x 1105/1105` · \`SEC-INT-01 du bo cuc: mock o lai (turn nay) + dual-service suite gate kep (cycle 101) + provider-invoke slice = viec cua window`.

## Nhật ký (tiếp)

- 10:4x (25/09) — CYCLE 102: mock-vault server (6 endpoints, virtual clock, lease_duration/renewable/expiredLeases counter, CAS 412, prefix 403 that, request-log value-free) + client adapters (tokenClient/credentialWriter/revokeCurrentToken, node:http keepAlive-false) + listen-loopback quiet band — diet flam 3 dot ETIMEDOUT; combined suite mock-vault 12/12, cluster 20/20 x4 on dinh; toan cay orch 47/47 1105/1105 + lint 0; connector daemon 11/11. Kill cac bien chung: moi lan them test HTTP deu co port lottery — da che. — Muc 51.
## 52 — CYCLE 103 (orchestrator request): WINDOW GUARD cho admin-error-boundary.test.ts — đúng slip tôi tự báo ở §43, NIÊM LẠI BẰNG CODE (2026-09-25 ~11:0x +07; Qwen-2)

**Root cause kỹ:** không chỉ thiếu env-check — beforeAll/afterAll nằm TOP-LEVEL ngoài describe ⇒ jest luôn chạy hook (createApp+listen chạm :5433) kể cả khi test bên trong skip. Guard đúng kiểu webhook-reclaim-fence của qwen3: LIVE = process.env.DU_LIVE_INFRA === "1"; liveDescribe = LIVE ? describe : describe.skip — **và kéo cả hai hook vào trong** liveDescribe(...): không env thì toàn bộ lifecycle tự skip, zero kết nối. Comment trong file ghi rõ lý do (chống ai đó "dọn" lại hook ra ngoài).

**Bằng chứng:** (1) đơn lẻ không env: Test Suites: 1 skipped / Tests: 1 skipped / ExitCode 0 (3.4s, không một dòng connect DB). (2) full default config (= pnpm test): suite nằm nhóm SKIP, không xuất hiện ở FAIL list. (3) lint 0 + build 0. Nhánh DU_LIVE_INFRA=1 chỉ DỜI hook vào scope — logic bất biến; đóng lại bằng chứng live thuộc window kế tiếp của qwen3/Tester (default-config hiện còn 5 suite live không gate khác — việc riêng, ngoài phạm vi này; đề xuất coordinator giao tiếp nếu cần).

Không mở DB window; không commit/push.

## Nhật ký (tiếp)

- 11:0x (25/09) — CYCLE 103: window-guard admin-error-boundary (root cause: hook top-level; keo ca beforeAll/afterAll vao liveDescribe), skip khong env exit 0 (1 skipped), full-run cung SKIP, lint+build 0. Niêm slip tu-bao §43. Ngoai pham vi: 5 suite live khac van chay trong default config — de xuat lan sau gap guard tuong tu cho ca nhom do. — Muc 52.
## 53 — CYCLE 104: WINDOW GUARD TOÀN NHÓM LIVE — 13/13 suite DB-boot đã gate; default pnpm test giờ **zero kết nối :5433**; DB WINDOW = 0 (2026-09-25 ~11:4x +07; Qwen-2)

**Phạm vi:** 2 file chỉ định (blob-wire-binary, artifact-grant-fencing) + **11 file live khác** cùng bệnh (hook top-level, không gate — audit toàn bộ tests/: admin-audit, admin-base-routes, ingress-bounded, migrations, usage-summary, operation-tenant-fence, artifacts-fencing-pg, admin-action-rbac-live, admin-shell-live-pane, workspace-reference, runtime.test.ts). Tổng 15/15 suite chạm PG/Redis nay được gate (kèm admin-error-boundary §52 + webhook-reclaim-fence của qwen3 giữ nguyên).

**Khuôn (điều chỉnh có lý do):** packet nói kéo hook vào liveDescribe — đúng cho file 1-describe; nhưng runtime.test (8 describe), admin-audit/rbac-live (3 describe) dùng hook CHUNG ở top-level, nhổ hook vào một describe sẽ phá phạm vi hook cho các describe khác khi bật env. Giải pháp tương-đương-bảo-toàn cho MỌI file: giữ nguyên hook + describes, BỌC cả vùng từ hook đầu tới cuối file trong liveDescribe-WINDOW-GATED — jest tự skip cả cây con khi không env; bật env thì semantic chạy y hệt cũ. Header guard 3 dòng + console.warn SKIPPED theo chuẩn qwen3.

**Bằng chứng:** (1) Full default config KHÔNG env: Test Suites: 3 failed, 15 skipped, 46 passed — 15 skip = đúng 15 suite live; filter ECONNREFUSED/5433 trên toàn output = RỖNG ⇒ không một kết nối PG nào được mở. (2) 5 test fail còn lại là 3 suite OFFLINE-HTTP (admin-shell-server/platform-mount/webhook-boundaries) chết vì ETIMEDOUT/EADDRINUSE :57xxx — đúng họ port-lottery cycle 102, KHÔNG liên quan DB, 120/125 của chúng vẫn xanh; khuyến nghị lane đó chuyển sang tests/harness/listen-loopback.ts quiet-band (§51 đã chứng minh). (3) lint 0 + build 0 sau toàn bộ 30 edit.

**Rủi ro đã xét:** jest.unit.config vẫn exclude danh sách cũ (vô hại, double-skip); describe lồng không đổi thứ tự; afterEach của fencing nằm trong wrapper nên vẫn đúng phạm vi nó; module-top const/let app ngoài wrapper ⇒ scope không đổi.

Không commit/push; không mở DB window (nhánh bật env cố tình KHÔNG chạy — thuộc window Tester).

## Nhật ký (tiếp)

- 11:4x (25/09) — CYCLE 104: gate 13 suite live con lai (wrap-to-EOF de giu pham vi hook cho file nhieu describe); default run khong env: 15 skipped + ZERO connect 5433; 5 fail con lai = port-lottery offline-HTTP (khong DB), de xuat listen-loopback cho lane do; lint+build 0; 30 edit. Khong mo window. — Muc 53.
## 54 — CYCLE 126+ (REVIEWER FINDING 2 — HIGH): TS2739 example-review — 4/4 điểm facade thiếu 3 method ArtifactFacade đã sửa; test:typecheck 0 · test:unit 119/119 · lint+build 0; zero DB/Redis (2026-09-25; Qwen-2)

**Đính chính số liệu:** packet ghi 8 lỗi — thực đo `npm run test:typecheck` = **4 lỗi TS2739** trên đúng 2 file được nêu (3 ở task-context-consumer, 1 ở test-helper), cùng MỘT nguyên nhân: `ArtifactFacade` (worker-sdk/src/types.ts:51) đã thêm `readWithMetadata`/`readStream`/`writeStream` mà test facades chưa cập nhật theo. Con số 8 có lẽ đếm từ lúc ts-jest nhân lỗi theo từng suite — không còn tồn tại sau fix.

**Fix (chỉ 2 file tests, không đụng src):**
- `test-helper.ts`: +`createHash`/`Readable` imports; facade `artifacts` thêm 3 method **triển khai thật trên cùng artifactsMap/writtenArtifacts/readArtifactCalls** (không stub ném-lỗi): readWithMetadata trả buffer+sizeBytes+sha256 **tính thật**; readStream = Readable.from(buffer đã lookup) và ghi nhận read-call như read(); writeStream gom iterable → **kiểm declared-size (mismatch ⇒ throw)** rồi store y hệt write (artifactId mới, role/purpose, map update). Đây là harness dùng bởi MỌI unit test business ⇒ semantics mới phải khả-dụng thật, không phải vừa-đủ-compile.
- `task-context-consumer.test.ts`: mockArtifactFacade (typed ArtifactFacade) +3 method hành vi thật (buffer 'mock-data', writeStream đẩy cùng writtenArtifacts); 2 TaskContext literal stub +3 method tối giản khớp hình sẵn có; thêm import Readable.

**Verify:** `npm run test:typecheck` **0** · `pnpm --filter @du/example-review test:unit` → **Test Suites: 13 passed · Tests: 119 passed, 119 total · exit 0** (dòng console.error thấy được là log redaction chủ đích của test failure-path, không phải fail) · `lint` + `build` src **0**. Không DB/Redis (unit tree); không commit/push.

## Nhật ký (tiếp)

- Cycle 126+ — FINDING 2: 4 TS2739 (khong phai 8 — bao chuan) do ArtifactFacade them 3 method ma test facade chua theo kip; fix test-helper (trieu khai that: sha256 that, size-check writeStream, map update) + consumer (mock facade + 2 stub literal); test:typecheck 0, test:unit 119/119, lint+build 0; chi 2 file tests, khong src. — Muc 54.
## 55 — CYCLE (rà soát guard p8-01-traceability của Codex-New): THIEU WINDOW GUARD — ĐÃ BỔ SUNG theo chuẩn fleet; 2 proof skip 0 ket noi; pnpm -r lint 13/13 packages sach (2026-09-25; Qwen-2)

**Hiện trạng Codex-New để lại:** file 618 dòng, hooks (beforeAll :212/afterAll :413) ĐÃ nằm đúng TRONG describe — cấu trúc sạch (khác bệnh cycle 103/104); mọi thao tác kết nối (validateTest*Target, new PgSqlClient, createServer, createApp) đều ở trong hook. NHƯNG describe(:144) **không gate** ⇒ `npx jest` thường (không env) vẫn boot PG/Redis ngoài window. Đánh giá: ĐẠT 8/10, thiếu đúng 1 lớp — guard.

**Fix của tôi (2 edit, giữ nguyên mọi dòng logic của tác giả):** thêm block WINDOW GUARD chuẩn cycles 103/104 (LIVE/liveDescribe + console.warn SKIPPED + comment giải thích) và đổi `describe(` → `liveDescribe(` — hooks vốn ở trong nên skip là skip tuyệt đối.

**Proof 1 (mặc định root URL):** chay khong env → 1 skipped / 1 total / exit 0, chi mot dong SKIPPED warn; ts-jest compile toan file (typecheck ngam) truoc khi skip.
**Proof 2 (cổng chết):** DATABASE_URL/REDIS_URL tro 127.0.0.1:9 → VAN skip exit 0, zero ECONNREFUSED ⇒ code path khong bao gio cham ket noi khi thieu gate.

**Typecheck+lint toàn repo:** `pnpm -r lint` = tsc --noEmit cho **13/13 packages** (contracts, document-kit, observability, egress, worker-sdk, connector-client, orchestrator, connector, document-core, example-review, tests/browser, tests/login, **tests/integration** — package của chính file này) — tat ca Done, exit 0.

Phan hoi cho Codex-New (qua coordinator): file nay viết ĐÚNG khuôn hook-trong-describe — chỉ quên gate; đã bổ sung, đề nghị các suite live tương lai nhân khuôn ngay từ đầu.

## Nhật ký (tiếp)

- — CYCLE rà soát: p8-01-traceability thieu WINDOW GUARD (hooks da dung choi, tinh trong bo cuc); ap LIVE/liveDescribe chuan 103/104; proof-skip x2 (mac dinh + cong che) deu skip exit 0 zero-connection; pnpm -r lint 13/13 package sach, gom tests/integration tsconfig phfu test files. Khong cham DB/Redis that, khong commit. — Muc 55.
## 56 — CYCLE 127 (OIDC-02 multi-replica session): RÀ SOÁT 2 SUITE + BỔ SUNG 4 KỊCH BẢN LỔ HỔNG THẬT — 31 pass/3 skip chuẩn-gate; pnpm -r lint 13/13; build 0; ZERO DB/Redis (2026-09-25; Qwen-2)

**Rà soát (item 1):** `redis-session-repository.test.ts` — gateway-seam design tốt (fake in-process chạy repository THẬT), đã có describe hai-replica + GETDEL one-shot + principal-index. `oidc02-multi-replica-offline.test.ts` — phủ SẴN 2 kịch bản packet yêu cầu (A cấp→B đọc qua resolveAdminActionAuthAsync; destroy/revokePrincipal cross-replica) + EXPIRY (absolute/idle/Redis-native TTL) + LOAD-BALANCER 4-replica + block Tester-1 gate DU_LIVE_INFRA chạy Redis THẬT với keyPrefix scoped, KHÔNG FLUSHDB. Hooks nằm trong describe, skip là skip tuyệt đối — đúng khuôn 103/104. Kết luận: ĐẠT chuẩn mực.

**Bổ sung (item 2) — 4 case đóng đúng 2 lỗ hổng coverage THẬT tìm thấy khi đọc:**
1. 'A destroys; B-side dispatcher resolution is null from that instant (401 at the route)' — trước đó chỉ test store-level null; nay chứng minh cả ĐƯỜNG HTTP-resolver fail-closed trên replica B ngay sau khi A destroy.
2. revokePrincipal trên A ⇒ B-side resolution null cho CẢ HAI session của principal (resolver-level, không chỉ get()).
3. ROTATE cross-replica (fixation defense trong topology LB — chưa từng được test): rotate trên A ⇒ id cũ chết trên B, id mới authenticate trên B đủ {kind:cookie, role, tenantId, csrfOk}.
4. Double-rotate: id tiền-rotate không thể rotate lại trên BẤT KỲ replica nào; chain sống tiếp từ id hiện hành trên replica khác.

**Verify (item 3):** jest 2 suite → **Test Suites: 2 passed · Tests: 31 passed, 3 skipped (live-block gate — 0 socket), 34 · exit 0** · `pnpm -r lint` **13/13 packages exit 0** · orchestrator `build` **0**. Không chạm DB/Redis thật.

**2 ghi nhận gửi Qwen-1 (không tự sửa):** (a) block live của oidc02 so sánh DU_LIVE_INFRA với "true" trong khi fleet chuẩn là "1" (15 suite đã gate đều dùng 1) — nên thống nhất một giá trị để Tester đỡ nối nhầm; (b) createIoredisSessionGateway đòi getdel (Redis >=6.2) — đúng chủ trương fail-the-boot đã ghi trong comment, OK.

Sẵn sàng cho Qwen-1 tích hợp RedisSessionRepository vào `oidc-boot.ts`: seam `AdminSessionStore` + `resolveAdminActionAuthAsync(config, headers, sessionStore)` đã được 3 lớp test (resolver/replica/rotation) pin chặt; `keyPrefix` per-deployment là việc composition còn lại (option đã có sẵn).

## Nhật ký (tiếp)

- 127 — OIDC-02: doc 2 suite (chat, gate dung); bo sung 4 case vao 2 lo hong that (resolver fail-closed sau destroy/revoke tren replica khac; rotate cross-replica + double-rotate); 31 pass/3 skip; pnpm -r lint 13/13; build 0; zero DB/Redis. Ghi nhan "true" vs "1" cho Qwen-1 thong nhat. — Muc 56.
## 57 — CYCLE 128: SỬA LIVE HARNESS OIDC-02 (evidence tester.md:6401-6430) — gate 1 + await-ready TRƯỚC mọi lệnh live; offline 31 pass/3 skip; lint+build 0 (2026-09-25; Qwen-2)

Hai lỗi sửa ĐÚNG chẩn đoán Tester-1/Reviewer:

(1) GATE: so DU_LIVE_INFRA với 'true' → '1' — thống nhất fleet chuẩn (tự vá đúng điều tôi kiến nghị ở §56); comment hướng dẫn trong file đổi thành set DU_LIVE_INFRA=1.
(2) ROOT-CAUSE Stream-isn't-writeable: gateway ioredis bật offline-queue OFF (đúng chủ trương fail-closed production) ⇒ mọi lệnh trước event ready reject tức thì. Fix tại NGUỒN: RedisSessionGateway thêm ready?(): Promise<void> (optional — fake không có connect phase); createIoredisSessionGateway: status==='ready' resolve ngay, ngược lại once('ready') + TIMEOUT 10s rồi reject loudly. CỐ Ý không reject theo 'error' — ioredis tự reconnect, transient error không terminal; 10s budget mới là ranh giới.

Live block: beforeAll thành async + await gateway.ready?.() TRƯỚC cả 3 test SHARE/REVOKE/EXPIRY — hết cửa lệnh trước ready.

Verify: jest 2 suite liên quan → 2 passed · 31 passed · 3 skipped (block Tester-1 gate đúng, zero socket) · exit 0. Orchestrator lint + build 0.

Unit tree sau fix: fail count dao 8↔22 qua 2 run liên tiếp, TOÀN BỘ lỗi mẫu là EADDRINUSE/ETIMEDOUT cổng 64xxx (dynamic range) ở các suite listen(0) của lane KHÁC (admin-shell-server/platform-mount/oidc-flow-integration + fallback quiet-band khi cạn dải) — environmental port-lottery đang suy thoái sau ca live Redis của Tester-1, KHÔNG có lỗi nào động tới code tôi sửa (ready?() additive; 2 suite của tôi xanh nguyên). Khuyến nghị lại cho fleet-owner: quiet-band + no-pool transport (§51/§53) cho các suite đó.

GỬI TESTER-1 RE-RUN: trong window :6380 — set DU_LIVE_INFRA=1; npx jest tests/oidc02-multi-replica-offline.test.ts --runInBand (cwd services/orchestrator). Kỳ vọng 16/16. Nếu 'not ready within 10s' ⇒ REDIS_URL sai/Redis chết: fail loudly là ĐÚNG, không phải bug harness.

## Nhật ký (tiếp)

- 128 — sua live harness OIDC-02 theo evidence tester.md:6401: gate true->1; gateway ready() (once-ready + timeout 10s, khong reject transient); beforeAll await ready truoc lenh dau; offline 31 pass/3 skip exit 0; lint+build 0; tree fail = port-lottery 64xxx lane khac (dao 8-22/run), khong phai do fix. Gui Tester-1 re-run. — Muc 57.
## 58 — CYCLE 138 (Reviewer audit 132-137): SENTINEL SINK-SCAN MATRIX cho SEC-INT-01/G-SEC — harness + 14 test offline mới; PHÁT HIỆN 1 GAP WRITE-PATH thật (2026-09-25; Qwen-2)

**1) Khảo sát 12 sink (mới 10, kế thừa 2 từ cycle 99) — ma trận trong \`SINK_CATALOG\`):**

| Sink | Nguồn ghi | Tình trạng bảo vệ hiện tại (đọc code, không đoán) |
|---|---|---|
| pg.connector_revisions | POST /connectors config JSONB + credential_source | **GAP — xem (2)** |
| pg.connector_invocations | ledger claim: chỉ lưu LocalInvocationRequest (input/ids), provider HTTP request (kèm bearer) KHÔNG vào JSONB | an toàn theo code; scan proof trong live |
| pg.secret_versions | encrypted BYTEA | ciphertext; scan tìm plaintext sentinel trong escape-encode |
| pg.connector_usage_outbox / webhook_deliveries / orchestrator_outbox | usage events / payload + last_error mã cố định (ADM-BASE-03) | scan whole-row to_jsonb |
| http.error_responses | boundary sanitizedInternalError + ProblemDetails literal | đã pin bằng adm-base-03; re-scan trong G-SEC |
| log.structured_buffer | observability redact() (chủ trương SEC reuse LOG-01 — không redactor song song) | scan capture buffer |
| redis.job_payload | BullMQ dispatch rows (ids/refs) | live-only: keyspace scan khi mở window |
| html.admin_panes + 2 sink admin_* cũ | masked fetchers / audit / idempotency | giữ nguyên, gộp vào cùng assertSinksClean |

**2) GAP THẬT tìm thấy (đề nghị coordinator dispatch lane connector/platform):** \`services/connector/src/http/server.ts\` POST /connectors chỉ soi shape (connectorId/adapter/credentialRef/config-JSON-object) **không validate config qua \`ConnectorRevisionConfigSchema\`** (contracts, cycle 94) ⇒ \`config.headers.authorization: Bearer sk-...\` vẫn được **persist nguyên văn vào JSONB**; \`redactConnectorRevision\` chỉ che khi ĐỌC. SEC-03 ghi rõ: *read redaction không phải write-time protection*. Fix đề xuất: gọi \`ConnectorRevisionConfigSchema.parse(body.config)\` trong createRevision (schema đã có sẵn, chỉ chưa nối) — 1 điểm nối, kèm live scan sink pg.connector_revisions proof.

**3) Harness + test offline (deliverable chính):**
- \`tests/harness/sentinel-scan/index.ts\`: SINK_CATALOG (id+medium+note), \`scanTextForSentinels\` (bỏ qua sentinel rỗng — chống footgun match-mọi-thứ), \`assertSinksClean\` → \`SinkLeakError\` **chỉ báo sinkId+sentinelId, không bao giờ chứa value** (test chứng minh), \`buildPgSinks(query)\` — mỗi sink PG = 1 query \`to_jsonb(t)\` toàn-row (không enum cột → cột mới cũng được phủ; secret_versions dùng encode() vì BYTEA), lỗi query **nổ to** — scan hỏng ≠ scan sạch; \`buildLogSink\` cho stdout-capture.
- \`tests/unit/sentinel-sink-matrix.test.ts\` — **14 case, positive-control trước, negative sau**: detect-by-id đúng ô ma trận; clean-matrix xanh; message không leak value; builder 8 query to_jsonb; db-lỗi→reject. \`npx jest --config tests/unit/jest.config.cjs --runInBand\: **3 suites · 23/23 · exit 0** (gồm 2 suite cũ của lane không đổi). Không DB/Redis, không commit.

**4) Việc còn của G-SEC (khi có window):** nối \`buildPgSinks(db.query)\` + http-probe sink + \`buildLogSink(stdoutSpy)\` + redis keyspace scan vào suite SEC-INT-01, planted-sentinel rotation qua connector API THẬT (kèm fix (2) nếu coordinator duyệt) — một lần chạy, một báo cáo matrix đầy đủ. \`oidc02 live block\` có thể复用 cùng helper.

## Nhật ký (tiếp)

- 138 — sentinel sink matrix: harness 12 sink + scanner leak-safe (bao cao bang ID) + 14 offline test (positive control buoc buoc), jest unit 23/23 exit 0; GAP that: POST /connectors khong validate config.headers truoc JSONB persist (read-redaction khong phai write-protection) — de xuat noi ConnectorRevisionConfigSchema, cho coordinator quyet; live SEC-INT scan con trong. Khong mo DB. — Muc 58.
## 59 — CYCLE 139 (Reviewer Finding 1): DEVELOPER-STARTUP-LOG CONSOLE-CAPTURE FIXTURE — 4 test FINDING-1 moi, non-vacuous ca 2 chieu; typecheck/full-unit 123/123; worker-sdk khong doi (2026-09-25; Qwen-2)

**Hien trang khosat (truoc khi viet):** worker-sdk/src KHONG co bat ky console.log nao; example-review main.ts chi co 1 dong console.error crash-banner (message, khong config); snippet config-loaded/workerToken trong audit la pattern QUY CHIEU (phan chuong nhung gi phai bi cam), chua ton tai trong code. Cach dat trung thuc: fixture + guard cho biec sau + pin hien tai, khong mo rong src trai pham vi.

**Deliverable 1 — tests/fixtures/console-capture.ts (chi trong tests/, khong dong production):** captureConsole() proxy 5 level (log/info/debug/warn/error), JSON-stringify object, Error → Name: message (khong mat payload), joined(), restore(); thiet ke chong void-green.
**Deliverable 2 — them describe FINDING 1 vao example-review.test.ts (4 case):**
- Non-vacuous: capture thay duoc ca 5 level + token long trong JSON va trong Error; sau restore console that van hoat dong (khong bat de — tranh xanh gia).
- Counterexample co chu dich: log theo dung kieu config-loaded/workerToken bi FORBIDDEN_LOG_SHAPE chan; banner an toan (ten queue/develop boolean) thoat — guard chay ca 2 chieu.
- Dynamic main-path: parseWorkerConfig loi chi neu TEN key, khong echo gia tri env co sentinel; va parse khong log gi ca (capture = rong).
- Static pin src/main.ts: loai comment, lay moi dong console.* that (assert so dong > 0 — pin chien code that, khong tap rong) va khong dong nao khuya FORBIDDEN_LOG_SHAPE. Neu ai paste snippet reviewer vao main.ts, test do RED.

**Verify:** npm run test:typecheck 0 (fixture doc lap typecheck duoc khi src chua dung) · full unit 13/13 suites · 123/123 (baseline 119 + 4 moi, khong case cu nao bi dong) · worker-sdk lint + build 0 — src khong can sua. Khong DB/Redis, khong commit/push.

**Ban do con lai cho Finding 1 (khi banner config-loaded duoc viet):** goi captureConsole() quanh main() voi env that + 2 assert (khong token trong joined; khong FORBIDDEN_LOG_SHAPE) — fixture da san. Vuong 2: ap dung cung FORBIDDEN_LOG_SHAPE cho startup log document-core.

## Nhật ký (tiếp)

- 139 — FINDING 1: console-capture fixture (5 level, JSON/Error stringify, restore, chong void-green) + 4 test FINDING-1 (non-vacuous, counterexample 2 chieu, parseWorkerConfig name-only, static pin main.ts); example-review 123/123 + typecheck 0; worker-sdk nguyen ven lint+build 0; khong mo DB/Redis. — Muc 59.
## 60 — CYCLE 140 (Reviewer Finding 2): R1-D-03 PINS — UNKNOWN phach biet qua HTTP + that dính UNKNOWN/Gap reconciliation; 15/15 suite, cluster 167/167; KHONG doi production; DB window = 0 (2026-09-25; Qwen-2)

**Phat hien truoc khi viet (khop ket luan Reviewer bang code that, ca hai ledger):**
- Reviewer dung mot phan: 'FAILED khong duoc gan o dau' — SAI: ledger.fail() gan FAILED tu IN_FLIGHT, failPending() tu PENDING (ping TRUE bang test #2 moi).
- Reviewer dung phan chinh: UNKNOWN -> FAILED khong the xay ra qua ledger API hien tai — ca InMemory lẫn Postgres predicate chi cho IN_FLIGHT/POLLING-token; claimPendingPoll chi PENDING/POLLING; cancel loai UNKNOWN. UNKNOWN la reconcile-only-terminal theo MAU, khong co duong ve. Ket luan: R1-D-03 van TRONG — can reconcile API that (UNKNOWN -> POLLING kem lease moi, roi complete/fail bang token do); packet cycle nay cam doi production, nen toi ping bang chung minh WHY, khong gia vờ da xong.

**3 test mới trong tests/r1-d-lifecycle-offline.test.ts (chi file test — production 0 dong doi):**
1. (a) GET tren dong UNKNOWN = envelope INVOCATION_UNKNOWN (status 200, wire-hinh-contract 'UNKNOWN' + runtime-hinh 'unknown' ping CA 2 tang; grant that qua ContractSignedVerifier-path verifier cau truc), va mot id THAT-su khong ton tai van 404 NOT_FOUND — hai truong hop phach biet ro. Server connector THAT (createConnectorServer) tren quiet-band loopback (dung lai tests/harness/listen-loopback tu cycle 102 — khong them port-lottery moi).
2. (b-chen) FAILED gan duoc tu IN_FLIGHT (pin chong tien-de 'chi tai creation' cua Reviewer).
3. (b) UNKNOWN sticky: fail/complete/cancel/markPending/failPending/claimPendingPoll/replay-invoke TU CHOI het (rejects INVOCATION_UNKNOWN / false / undefined), record van UNKNOWN — gap pin + comment chi ro reconcile API con thieu.

**Verify:** suite r1-d **15/15 exit 0** · cluster 14-file connector **167/167 exit 0** · lint+build **0/0**. Mot phat hien MOI ve ha tang (khong phai do toi): FULL 16-suite connector run TRIET RE hang >240s — chung minh KHONG phai do diff nay: tru file r1-d cua toi ra van hang; trio hang-rieng-cua-toi 25/25; 2 gate-suite chay doi 7-skip-lien-tuc. Day la order-dependent hang ho port-state cua box sau ca live Tester-1 (trc day full-run xong trong ~7s) — de nghi lane owner/Test chay --detectOpenHandles bisect o cycle rieng; toi khong mo rong pham vi.

## Nhật ký (tiếp)

- 140 — R1-D-03: 3 pin tests (GET UNKNOWN-envelope 200 vs 404 that; FAILED tu IN_FLIGHT ping-TRUE tien-de Reviewer; UNKNOWN sticky gap-pin ca 2 ledger semantics) — chi file test, quiet-band server that; r1-d 15/15, cluster 167/167, lint+build 0; R1-D-03 reconcile API van TRONG (gap duoc ping, khong gia xong); full-suite hang = hien tuong moi khong do diff (da chung minh loai-tru). — Muc 60.
## 61 — CYCLE 141: R1-D-03 MOCK-PROVIDER RECONCILIATION qua HTTP boundary that — 11 test (202-replay/crash-reconcile/retryable/outage/Vault-fail-closed); 11/11 x3, full package 187P+7S; + sua loc tiem an SEC-INT-01 (VAULT_REF 4-segment -> canonical 7-segment); DB window = 0 (209-25; Qwen-2)

**Deliverable 1 — tests/r1-d-03-mock-provider-reconciliation.functional.test.ts (chi file test; production 0 dong doi):** boundary THAT: createConnectorServer + DurableConnectorRuntime + FetchProviderTransport + grant HMAC contract-path that (ContractSignedGrantVerifier/HmacSignedGrantSource), ledger/quota in-memory, mock provider kich ban 202/503/429/hang/refused + counter calls/resultGenerations + capture Idempotency-Key/authorization. Bands tinh 423xx (provider) / 428xx (connector) / 433xx (dead port), khong dong voi 414xx (r1d) hay 412-417xx.

**A (reconciliation provider-side):** A1 202->202-wire PENDING + key=invocationId + Bearer legacy decrypt that qua fetch that. A2 replay TRUOC nextPollAt khong dispatch (calls=1); replay DUNG hạn -> poll duoi CUNG key -> SUCCEEDED, provider result sinh dung 1 lan; replay sau terminal phuc vu tu ledger (calls=2); GET 200 SUCCEEDED. A3 TENh-nhu-crash: process 1 accept roi chet (record PENDING), process 2 (server+runtime MOI tren cung durable ledger) replay reconcile -> SUCCEEDED, key xuat hien 2 lan, result 1 lan.

**B (retryable/outage):** B1 503 -> 502 PROVIDER_UNAVAILABLE + ledger FAILED; replay KHONG re-dispatch (calls=1); GET 200 FAILED envelope. B2 429 -> 429 PROVIDER_RATE_LIMITED. B3 van chuan transport-throw orphan IN_FLIGHT: 502 -> replay 409 INVOCATION_UNKNOWN -> GET 200 UNKNOWN envelope — pin GAP: HTTP boundary KHONG co API resolve UNKNOWN ( reconcile API that van TRONG o ca 2 tang ledger+HTTP). B4 connection-refused -> 502 + record IN_FLIGHT.

**C (VaultDevFixture mode loi — user chon scope 'HTTP boundary orchestrator' + 'fixture error mode'):** C1 outage -> 502 sau bounded retry (reads=2 = maxAttempts), provider calls=0. C2 deny (missing secret, non-retryable) -> 401 CREDENTIAL_INVALID, reads=1, provider calls=0, legacy reads=0 — SEC-05 no-fallback pin khi cipher legacy ACTIVE van nam trong store. C3 path tenant-b vs grant tenant-a -> 403 BINDING_DENIED TRUOC moi Vault read (reads=0, provider=0). C4 anchor happy-path: sentinel tu Vault den Bearer provider that (1 read, 1 call) — Chung minh cac pin 0-count o tren do dung thu.

**Verify:** file moi 11/11 x3 chay lien tiep (run1 exit 0, Run2Exit=0, Run3Exit=0 literal) · connector src typecheck `npx tsc --noEmit` Exit Code 0 (tsconfig chi include src; test file duoc ts-jest diagnostics bao lead trong ca 3 run) · connector FULL package (cache-warm): `Test Suites: 2 skipped, 17 passed, 17 of 19 total` · `Tests: 7 skipped, 187 passed, 194 total` (2 suite skip = durable-integration + black-box-durable, [SKIP-QUALIFIED] gate CONNECTOR_INTEGRATION, khong phai mat day) · luu y: full-run LANH DONG trong >600s (cold ts-jest compile ca graph — khop quan sat cycle 140); chay lai cache-warm sach. Khong mo DB/Redis, khong commit/push.

**Deliverable 2 (ngoai packet, fix trong lane cua toi):** SEC-INT-01 loc tiem an — VAULT_REF cu `du/connector/secint/prod` (4 segments) + account `du-conn-secint-main` SE FAIL khi mo window: matchesVaultAccountPath yeu cau 7 segments `du/tenants/{t}/connectors/{c}/accounts/{a}` -> workflow.ts:137 tra 422 va createPendingRevision tra 403 BINDING_DENIED. Da doi sang canonical path (`du/tenants/secint/connectors/secint-openai/accounts/secint-main`, account khop segment cuoi) + fixture scopes `du/tenants`; chan dung bang production matcher = true (node doi chieu dist) + file gate van compile, 7 test tiep tuc skipped khi khong co DU flag. KHONG mo window.

**Follow-on de xuat:** (1) reconcile API that (UNKNOWN -> POLLING kem lease moi) — B3/A-pin da cho san ca 2 chieu; (2) MAX_PROVIDER_POLL_ATTEMPTS=16 exhaustion -> markUnknown chi ping duoc o tang ledger (backoff tran ngap thoi gian offline) — neu muon pin HTTP-level can seam now/random trong runtime; (3) cold full-suite >10ph can detectOpenHandles bisect (lan cu, van mo).

## 62 — CYCLE 142: W-VAULT01-BIND-1R (re-giao tu Codex-6 mat kenh) — BINDING (tenant_id, connector_id, account_id) CHO REVISION STORAGE O TANG DB; 32 test moi (24 fake-DB + 8 schema-pin), 6 ca cu vault-isolation van xanh; chain 3 full-suite exit 0; DB window = 0 (Qwen-2)

**Pham vi packet:** ID VAULT-01 (tasks/SEC-OIDC-VAULT-2026-09-24.md). Review 150-161 chi services/connector/src/db/repository.ts:258-278 + 296-380 CHUA co binding (tenant_id, connector_id, account_id) dang tin; flow anh huong: connector credential revision write/read → PG. Boundary: chi sua services/connector + migrations cua no; khong cham packages/contracts va services/orchestrator; khong DB window; khong commit. **Da dung het.**

**Dinh nghia win/lose tung phan:**

**(1) Migration 008_connector_revision_binding.sql (MOI, 172 dong) — binding that o tang DB:** (a) tenant_id TEXT NOT NULL DEFAULT '' (sentinel rong = UNBOUND; KHONG dung chu 'default' de tranh va cham tenant that trung ten) + account_id TEXT (NULL duoc cho legacy rows); (b) ham connector_revision_account_id(jsonb) = split_part(path,'/',7) cho vault-kv2 dung cho backfill/constraint; (c) 6 CHECK constraint: tenant shape ('' hoac regex ^[a-z0-9][a-z0-9._-]{0,63}$), account shape, source kind IN (legacy-db, vault-kv2), account_id = ham projection, **vault_path_matches_binding** (7 segment path phai = dung bo (tenant_id, connector_id, account_id) cua ROW — foreign binding / encoded separator / extra segment vi pham CHECK ngay tuc thoi insert), **bound_source_is_vault** (row bound khong duoc mang legacy-db credential); (d) TRIGGER connector_revisions_chain_guard BEFORE INSERT OR UPDATE: chain = (connector_id, credential_ref) — chan 1 chain 2 tenant, chan legacy-db gia nhap chain bound, chan 2 ACTIVE/chain; moi vi pham RAISE EXCEPTION ERRCODE 23514; (e) pg-client migrate() da dang ky 008 sau 007; replay-safe (ADD IF NOT EXISTS / DROP+ADD CONSTRAINT / CREATE OR REPLACE / DROP TRIGGER IF EXISTS); khong down-migration, cung discipline 005-007. UNBOUND rows ('') giu nguyen semantics chia-se legacy truoc-binding (SEC-00 "tuong thich legacy explicit") nhung KHONG the bi ghi de thanh bound row.

**(2) repository.ts — enforce binding tu nguon trusted, khong tin client payload:** type moi ConnectorRevision.tenantId (+ optional accountId) chieu truc tiep tu cot DB — binding doc len la cua ROW, khong phai cua caller. deriveRevisionBinding(input) fail-closed TRUOC bat ky SQL nao: legacy+claimed-tenant → BINDING_DENIED; vault thieu tenantId → INVALID_INPUT; claimed khong khop path-tenant → BINDING_DENIED; malformed → INVALID_INPUT (test pin db.calls=0). INSERT moi them cot tenant_id=$8, account_id=$9. MOI lenh doc/UPDATE revision deu mang tenant_id predicate: get/getActiveRevision exact-selector; **getRevision dual-predicate** "(tenant_id = $3 OR tenant_id = '')" + "ORDER BY CASE WHEN tenant_id = $3 THEN 0 ELSE 1 END LIMIT 1" — bound row CUA TENN KHAC khong bao gio thoat ra khoi DB duoi mat foreign selector (DB chan, khong phai service), unbound legacy giu compat; va (connector_id, revision) collision duoc route bang dinh-dan bound-truoc. activateRevision CAS + target FOR UPDATE + retire + disable deu scope tenant_id; getActiveCredential/revoke gan EXISTS-chain-guard (008 bind ref→tenant 1-mot-1) nen foreign selector khong resolve duoc secret cua chain khac.

**(3) Boundary khac (services.ts / http/server.ts / config.ts):** invoke tai revision bang getRevision(connectorId, rev, {tenantId: claims.tenantId}) — claims tu grant DA VERIFY (server-side, khong phai body), doi chieu LAN 2 voi binding cua row (isBoundRevisionTenant && != claims → BINDING_DENIED); vault path check dung tenant CUA ROW (trusted) khi row bound; legacy branch chan bound row (CREDENTIAL_INVALID — invariant 008). createPendingRevision: binding cua revision moi = tenant nam TRONG chinh path canonical cua no (assertVaultAccountPrefix voi pathTenant) — khong phai scope chain cu. Wire tuong thich nguoc: POST /connectors body.tenantId OPTIONAL (thieu = unbound legacy nhu he); routes revisions/activate/retire/disable/test nhan ?tenant= hoac body.tenantId; orchestrator adapter hien tai (khong gui tenant) tiep tuc thay va dung legacy chain nhu cu — muon bound chain thi lane VAULT-03 PHAI gui tenantId (duoc ghi o follow-on). redactConnectorRevision chieu tenantId/accountId nhu metadata (khong phai secret).

**Bang chung (offline; label packet: W-VAULT01-BIND-1R-reassignment offline unit/fake-DB):**
- cwd D:\Git\dugate\du-rework\services\connector — tests/revision-binding.db.test.ts (MOI, 24 test) tren **FakePgRevisions**: emulator CO Y TINH soi dung 008 (cung tap violation rules, raise SQLSTATE 23514, va THROW moi SQL shape la khong duoc ke khai → neu repository mai nay bo tenant predicate thi suite VO, khong im lang). Nhom: derive fail-closed 6 (pin db.calls=0), storage guards 7 (persist cot; rogue CHECK path/kind; 3 chain guard), SQL predicates 5 (collision routing bound-first; missing-khong-match → undefined; 5/5 statement mang tenant_id = $; foreign activate = false + rows khong doi; disable chi chain selector), projections 2, invocation-boundary 4 (foreign tenant → BINDING_DENIED + vault reads=0 + provider calls=0; happy anchor 1 read/1 call; bound-legacy chan; unbound compat pin). **KHONG tuyen bo bang PG that** — live-PG la gate rieng cua Tester, khong chen vao packet nay.
- tests/revision-binding.schema.test.ts (MOI, 8 test): pin HINH 008 (tung cau CHECK/trigger/ERRCODE/shape nhu dinh nghia tren) + 008 nam SAU 007 trong migrate() list + cac menh de replay-safe.
- tests/vault-account-isolation.test.ts: 6 ca cu mismatch cu + 1 happy **VAN XANH**; revision literal gio mang tenantId that va fake repo loc theo scope.tenantId — mismatch bi chan ngay o tang chieu-xuat DB, khong chi service logic.
- CHUOI 3 RUN LIEN TIEP full package: cd D:\Git\dugate\du-rework\services\connector && npx jest --config jest.config.cjs --runInBand --forceExit → **ev2-A.log / ev2-B.log / ev2-C.log**, ca ba run wrapper in literal "Exit Code: 0", tom tat giong het: "Test Suites: 2 skipped, 19 passed, 19 of 21 total" · "Tests: 7 skipped, 219 passed, 226 total" (2 skip suite = black-box-durable + durable-integration gate live — [SKIP-QUALIFIED], khong in PASS line; khong phai mat day). Raw logs giu tai services/connector/ cho coordinator.
- npx tsc --noEmit -p tsconfig.json (src): **Exit Code: 0** (empty output). Root tests/integration/jest.config.cjs chay offline: KHONG co dong "error TS" → p8-01/p4-08/connector-usage/sec-int-01 deu compile OK voi type moi; cac FAIL con lai o day la "fetch failed" cua live-window (toi da kiem tra: khong phai do diff nay, khong tinh pass, khong sua).

**Fix flake tieu chuan hoa (ngoai packet, trong lane, minh bach ly do — cap nhat lan dau chu ky):** May phat Windows ephemeral-port lottery (cycle 102 document san): truoc banding, full-run THAT BAI 3 lan o 3 suite khac nhau (security-lifecycle ETIMEDOUT x2, runtime-foundations fetch x1; network-boundaries pinned/gzip fail 2 attempt doc lap) trong khi standalone pass → port lottery. Ap DUNG le harness: (a) network-boundaries — helper sendRetryingPoolArtifact cho 3 test real-connect (chi retry PROVIDER_UNAVAILABLE khi listener.requests=0 — cung hinh thai refusal-only ma chinh file da lam san cho ca FIX-CR-08 stream); (b) runtime-foundations x2 + reliability-security x1: listen(0) → listenLoopback(server, 43440/43500/43560 + pid offset); (c) security-lifecycle: composition.port qua reserveQuietPort(436xx/437xx/438xx) + fetchRetryingConnect chi n ETIMEDOUT/ECONNREFUSED. Ket qua: 3 full-run exit 0 lien tiep. Khong assertion nao bi nong long: moi retry chi dung voi ket noi chua tung den listener.

**Su co — thu nhan trung thuc:** (1) Round-trip read_file→write_file tren file >500 dong (repository.ts, 589d) da luu nhiem header "Showing lines..." + cat tail toRecord; phat hien qua tsc, phuc hoi bang python splice (giu head + dung toRecord nguyen van ban da doc luc dau chu ky), xac nhan bang tsc 0 + toan bo jest xanh; rut kinh nghiem: file lon chi sua bang edit tool hoac python. (2) Patch dau cua emulator sai phan segment (dung JS split 8 doan thay vi split_part 7) → 11 FAIL lan dau, da sua.

**Follow-on de xuat:** (1) LIVE-PG gate cho 008 (Tester, gate rieng): migrate that + insert foreign-binding → expect 23514, va chan CHECK/trigger tren PG that — offline khong the thay; (2) lane VAULT-03/orchestrator: gui tenantId trong POST /connectors + ?tenant= cho admin routes khi muon bound chain (mac dinh hien tại = unbound, tuong thich nguoc); (3) khi Orchestrator chuyen multi-tenant day du: doi list()/management doc thanh scoped.

**KHONG:** mo cua so DB (0), commit/push (0), cham packages/contracts|orchestrator (0 dong diff — kiem tra bang git status).

## Nhật ký (tiếp)

- 141 — R1-D-03 mock-provider reconciliation tai HTTP boundary that: 11 test (A1-A3 202-replay+crash-reconcile cung Idempotency-Key, provider result dung-1-lan; B1-B4 502/429/IN_FLIGHT-orphan-gap/connection-refused; C1-C4 Vault outage/deny/mismatch provider-calls-0 + C4 Bearer anchor). 11/11 x3 exit 0 · tsc src 0 · full package 187P/7S/0F (2 skip gate = [SKIP-QUALIFIED]). Fix SEC-INT-01 VAULT_REF 4-segment -> canonical 7-segment + fixture scopes (loc tiem an 422/403 khi mo window), verified bang production matcher; khong mo DB/Redis, khong commit. Reconcile API that van TRONG (gap pinned B3). — Muc 61.



- 142 — W-VAULT01-BIND-1R (VAULT-01, re-giao tu Codex-6): migration 008 binding that (tenant_id NOT NULL DEFAULT '' + account_id + 6 CHECK vi/du path-binding + chain-guard trigger 23514 replay-safe, dang ky migrate()), repository deriveRevisionBinding fail-closed truoc SQL + moi statement mang tenant_id predicate (getRevision dual-predicate bound-first — chan cross-tenant o tang DB), invoke/mgmt scope tu grant+path trusted, wire tuong thich nguoc (orchestrator adapter khong đổi). Tests MOI: 24 revision-binding.db (fake-DB emulator soi 008, unknown-SQL throw) + 8 schema-pin; 6+1 vault-isolation van xanh voi projection bound; fix 3 ephemeral-bind flakes theo le cycle-102 (bands 434xx-438xx). Chain 3 full-suite lien tiep Exit Code: 0 (ev2-A/B/C — 19P/2S suites, 219P/7S tests), tsc src 0, root integration compile sach khong error TS (fail con lai = live-window, khong tinh). Thu nhan 2 su co (round-trip >500-dong, emulator segment off-by-one). Khong DB window, khong commit, khong cham contracts/orchestrator. — Muc 62.
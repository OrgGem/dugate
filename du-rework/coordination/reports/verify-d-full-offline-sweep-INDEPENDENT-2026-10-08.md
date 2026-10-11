# VERIFY ĐỘC LẬP D — quét toàn bộ suite offline orchestrator — 2026-10-08

- **Vai trò:** verify độc lập D, **CHỈ ĐỌC**. Không sửa source/test, không tạo/xoá test, không commit/add/push,
  không tick gate, không hand-edit `docs/21-openapi.json`, **không đọc `.env.live`**.
- **Offline:** KHÔNG khởi động PostgreSQL/Redis, KHÔNG claim DB window. Scope `du-rework` only.
- **CWD mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` (trừ bước 5b).
- **Environment:** Node **v24.21.0**; runner `node node_modules/jest/bin/jest.js --config jest.unit.config.cjs`.
- **Mốc:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` (không đổi suốt phiên);
  `git status --porcelain` = **90** lúc bắt đầu → **92** lúc kết thúc. **Cây đang được nhiều lane ghi song song**
  (trong phiên có thêm `verify-a-*`, `verify-b-*`, `verify-c-*`, `tasks/*`) ⇒ đây là **snapshot tại thời điểm chạy**,
  không phải một commit cố định. Lane này chỉ ghi **receipt này** (raw logs để ở `%TEMP%\verify-d\`, ngoài repo,
  có thể bị xoá — mọi literal cần thiết đã chép nguyên văn vào đây).

---

## BƯỚC 1 — full offline sweep, lần 1

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs
```
**exit code 1**
```
Test Suites: 6 failed, 14 skipped, 229 passed, 235 of 249 total
Tests:       40 failed, 118 skipped, 5098 passed, 5256 total
Snapshots:   0 total
Time:        79.748 s, estimated 121 s
```

**Danh sách suite FAILED (6):**
```
FAIL tests/admin-audit-mount.test.ts
FAIL tests/admin-audit-query.test.ts
FAIL tests/admin-error-boundary-offline.test.ts
FAIL tests/artifact-read-authorization.test.ts
FAIL tests/public-upload-encryption-gateway.test.ts
FAIL tests/v1-boot-typed-denial.test.ts
```

## BƯỚC 2 — full offline sweep, lần 2 (phát hiện flaky)

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs
```
**exit code 1**
```
Test Suites: 6 failed, 14 skipped, 229 passed, 235 of 249 total
Tests:       40 failed, 118 skipped, 5098 passed, 5256 total
Snapshots:   0 total
Time:        73.857 s, estimated 76 s
```

**So sánh lần 1 vs lần 2:** giống hệt **từng dòng** số liệu (6/14/229 · 40/118/5098); danh sách FAILED
`Compare-Object` cho **diff rỗng** ⇒ **cùng đúng 6 suite, không có flaky ở mức suite**. Khác duy nhất: `Time`
(79.7s vs 73.9s) — không phải kết quả test.
*(Lưu ý: một test bên trong `public-upload-encryption-gateway` là assertion ngân sách RSS — xem §RED #6, nó đỏ
**deterministic** ở đây nhưng thuộc lớp phụ thuộc môi trường.)*

## BƯỚC 3 — chạy riêng từng suite FAILED/SKIPPED

Nguồn danh sách skipped: chạy thêm một lượt `--json --outputFile` (read-only, ghi ra `%TEMP%`) để lấy
`numFailedTestSuites=6`, `numPendingTestSuites=14` — khớp đúng dòng tổng của jest.

### 3a. 6 suite FAILED — chạy riêng (xác nhận lại, exit 1 cả 6)

| Suite | Exit | Literal `Tests:` khi chạy riêng |
|---|---:|---|
| `artifact-read-authorization.test.ts` | **1** | `Tests: 5 failed, 85 passed, 90 total` |
| `public-upload-encryption-gateway.test.ts` | **1** | `Tests: 1 failed, 11 passed, 12 total` |
| `admin-error-boundary-offline.test.ts` | **1** | `Tests: 1 failed, 41 passed, 42 total` |
| `admin-audit-query.test.ts` | **1** | `Tests: 25 failed, 1 passed, 26 total` |
| `v1-boot-typed-denial.test.ts` | **1** | `Tests: 2 failed, 8 passed, 10 total` |
| `admin-audit-mount.test.ts` | **1** | `Tests: 6 failed, 6 total` |

Tổng test đỏ khi chạy riêng: 5+1+1+25+2+6 = **40** = đúng `Tests: 40 failed` của full run ⇒ **không test nào chỉ
đỏ khi chạy chung** (không có order-dependency).

### 3b. 14 suite SKIPPED — chạy riêng (exit **0** cả 14, toàn bộ test bị skip)

| # | Suite | Exit | `Tests:` | Lý do (nguyên văn từ suite) |
|---|---|---:|---|---|
| 1 | `data-02-04-live-s3.test.ts` | 0 | `5 skipped, 5 total` | `SKIPPED - set DU_LIVE_INFRA=1 inside the exclusive DB window.` |
| 2 | `pm-m02-ingress-verification.test.ts` | 0 | `8 skipped, 8 total` | `SKIPPED - enable only in an approved disposable infra window with DU_LIVE_INFRA=1 and DU_PM_M02_INGRESS_VERIFY=1.` |
| 3 | `f3-tenants-route-live.test.ts` | 0 | `11 skipped, 11 total` | `SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.` |
| 4 | `runtime-hitl.test.ts` | 0 | `7 skipped, 7 total` | nt |
| 5 | `runtime-recovery.test.ts` | 0 | `9 skipped, 9 total` | nt |
| 6 | `runtime-webhook.test.ts` | 0 | `9 skipped, 9 total` | nt |
| 7 | `gate-authenticate-808-pg16.test.ts` | 0 | `2 skipped, 2 total` | `gate-authenticate-808-pg16.test.ts:12` — *"Skipped unless `GATE_AUTH_PG_URL` is set, so CI needs no database."* |
| 8 | `runtime-facade.test.ts` | 0 | `14 skipped, 14 total` | `SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.` |
| 9 | `runtime-version-lifecycle.test.ts` | 0 | `7 skipped, 7 total` | nt |
| 10 | `runtime-health.test.ts` | 0 | `4 skipped, 4 total` | nt |
| 11 | `f3-tenant-list-live-db.test.ts` | 0 | `2 skipped, 2 total` | `SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window.` |
| 12 | `runtime-admin-auth.test.ts` | 0 | `7 skipped, 7 total` | `SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.` |
| 13 | `admin-local-users-migration.test.ts` | 0 | `1 skipped, 1 total` | `SKIPPED - set DU_LOCAL01_LIVE_MIGRATION=1 to run the private-schema migration smoke.` |
| 14 | `vault-live.test.ts` | 0 | `3 skipped, 3 total` | `SKIPPED — set DU_LIVE_INFRA=1 with running Vault.` |

**Tất cả 118 test skipped đều là live/infra-gated** (DB window, Redis thật, S3 thật, Vault thật, private-schema
migration). **Skipped KHÔNG phải pass** — không có suite nào trong 14 suite này được chứng minh chạy trong phiên
offline này.

### 3c. ⚠️ Phát hiện thêm: 4 suite "passed" nhưng có test BỊ SKIP bên trong (không nằm trong 14 suite trên)

Chạy `--json` cho thấy 4 suite có status `focused` với test `pending` — jest **vẫn đếm chúng vào 229 suite passed**:

| Suite | passed | **pending** | tổng |
|---|---:|---:|---:|
| `oidc02-process-replicas-offline.test.ts` | 11 | **7** | 18 |
| `pm-m02-ingress-fence.test.ts` | 5 | **6** | 11 |
| `oidc02-multi-replica-offline.test.ts` | 13 | **3** | 16 |
| `admin-keyset-explain.test.ts` | 5 | **13** | 18 |

Cộng pending: 7+6+3+13 = **29**. Kiểm chứng số học: 14 suite skipped có 5+8+11+7+9+9+2+14+7+4+2+7+1+3 = **89**
test; 89 + 29 = **118** = đúng `Tests: 118 skipped` của jest. Mọi test pending đều gated `DU_LIVE_INFRA=1`
(Redis thật / 2 process thật / EXPLAIN trên DB thật).

⇒ Ai đọc "229 passed" như "229 suite xanh hoàn toàn" sẽ **đếm thừa 4 suite / 29 test**. Đây là bẫy báo cáo, không
phải lane nào nói sai — receipt này ghi rõ.

**Kiểm tra "xanh không trung thực" khác:** grep toàn `tests/` cho `fdescribe|fit(|it.only|describe.only|test.only`
⇒ **0 hit**. Không có focus-based silent skipping, không có test nào bị `.only` che.

## BƯỚC 4 — 7 harness `.cjs` chạy bằng `node` (KHÔNG đưa vào jest)

| # | Lệnh (`node <file>`) | Exit | Literal dòng PASS |
|---|---|---:|---|
| 1 | `tests/admin-toast-error-boundary-offline.cjs` | **0** | `PASS admin toast/error boundary offline harness (14 assertions)` |
| 2 | `tests/api-docs-build-label-offline.cjs` | **0** | `PASS screen imports docs/21-openapi.json with ?raw` |
| 3 | `tests/f7-overview-usage-tile-offline.cjs` | **0** | `PASS: real OverviewScreen usage tile — 8 scenarios (real totals, tenant from session, platform/unscoped/failed fail-closed, unreadable payload, empty window, Operations tile intact)` |
| 4 | `tests/operations-download-live-offline.cjs` | **0** | `PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)` |
| 5 | `tests/portal-auto-refresh-offline.cjs` | **0** | `PASS: OPU-G2 auto refresh + data age — 9 scenarios (opt-in only, age from last success, stale-on-failure retention, cleanup on toggle-off/unmount)` |
| 6 | `tests/tenant-select-offline.cjs` | **0** | `PASS: real TenantSelect element tree — 8 scenarios (names-not-ids, state suffix, unknown value, loading/failed/empty/cycle/multi-page)` |
| 7 | `tests/usage-screen-offline.cjs` | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |

Cả 7 file đều tồn tại và **7/7 PASS, exit 0**. (Đúng như cảnh báo trong đề bài: nếu đưa các `.cjs` này vào jest thì
`testMatch: ['**/*.test.ts']` sẽ cho `No tests found`, exit 1 — **đó không phải test đỏ**; tôi không làm vậy.)

## BƯỚC 5 — typecheck

| # | Lệnh | cwd | Exit | Literal |
|---|---|---|---:|---|
| 5a | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `services/orchestrator` | **0** | `output_bytes=0` — không có dòng `error TS` nào |
| 5b | `pnpm --filter @du/admin-web typecheck` | `apps/admin-web` | **0** | `output_bytes=122` = **banner pnpm** (`> @du/admin-web@0.0.0 typecheck` + dòng lệnh), **0 dòng `error TS`** |

Không có dòng error TS nào để chép ở cả hai.

---

# DANH SÁCH TEST ĐỎ (40 test / 6 suite) — block lỗi NGUYÊN VĂN

## RED #1 — `tests/artifact-read-authorization.test.ts` (5 đỏ / 90, exit 1)
Tên 5 test đỏ:
```
● R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation
● R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant
● CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact
● CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong
● CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one
```
Block đầu tiên, nguyên văn:
```
  ● R1-A artifact read authorization and storage-facade boundary › does not grant
reads for STAGING artifacts, even in the same operation

    expect(received).rejects.toMatchObject(expected)

    - Expected  - 1
    + Received  + 1

      Object {
    -   "code": "STATE_CONFLICT",
    +   "code": "PERMISSION_DENIED",
      }

      373 |     const service = makeService(db);
      374 |
    > 375 |     await expect(service.requestAccess(STAGING_OUTPUT,
readRequest())).rejects.toMatchObject({
          |
      ^
      376 |       code: 'STATE_CONFLICT',
      377 |     });
```
Hai test lease còn lại có dạng `- {"code":"PERMISSION_DENIED","status":403}` / `+ {"code":"LEASE_LOST","status":409}`.
**Đây chính là MISMATCH đã triage độc lập hôm nay** — xem
`coordination/reports/triage-artifact-read-mismatch-INDEPENDENT-2026-10-08.md` (docs `28:1399` nói 403 vs code
`artifacts.ts:707` trả 409 `LEASE_LOST`). **Không sửa gì ở đây.**

## RED #2 — `tests/public-upload-encryption-gateway.test.ts` (1 đỏ / 12, exit 1)
```
● public upload encryption gateway › streams chunked encryption with downstream backpressure and keeps the object size exact
```
```
  ● public upload encryption gateway › streams chunked encryption with downstream
backpressure and keeps the object size exact

    expect(received).toBeLessThan(expected)

    Expected: < 171966464
    Received:   217735168

      707 |     // The mock object store retains ciphertext; this budget includes
that
      708 |     // copy and bounded stream buffers, while rejecting another
full-file copy.
    > 709 |     expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024);
          |                       ^
      710 |   });

      at Object.<anonymous> (tests/public-upload-encryption-gateway.test.ts:709:23)
```
**Kiểm flaky (chạy riêng 3 lần liên tiếp):** `1 failed, 11 passed, 12 total` cả 3 lần, exit 1 cả 3 lần,
`Received` = 218615808 / 218267648 / 219680768 (ngân sách 171966464). ⇒ **đỏ deterministic** trong môi trường này,
nhưng là **assertion ngân sách RSS** (lớp phụ thuộc GC/môi trường) — không kết luận được là lỗi sản phẩm hay
ngưỡng quá chặt nếu không có phép đo trên môi trường chuẩn.

## RED #3 — `tests/admin-error-boundary-offline.test.ts` (1 đỏ / 42, exit 1)
```
● W-ADMBASE03-ERR-1 browser-tier unhandled boundary (real loopback HTTP) › IdP callback leg escaping upstream: 500 HTML = code + correlationId, zero sentinel on wire and in ALL log sinks
```
```
    expect(received).toMatchObject(expected)

    - Expected  - 1
    + Received  + 1

    @@ -1,8 +1,8 @@
      Object {
        "correlationId": "25df6c0d-9770-474a-9ac1-96ce5c099976",
    -   "environment": "test",
    +   "environment": "prod",
        "errorClass": "VaultError",
        "invocationId": null,
        "level": "error",
        "operationId": null,
        "service": "orchestrator",
```

## RED #4 — `tests/admin-audit-query.test.ts` (25 đỏ / 26, exit 1)
25 test đỏ trải trên 4 describe: `W-ADM-UX-03 audit query: forwarding and error clarity` (10),
`W-ADM-UX-10 audit pane: empty state and error boundary` (6),
`W-ADM-UX-10 audit query: hostile input is rejected by name, never reflected` (9).
Block đầu tiên, nguyên văn:
```
  ● W-ADM-UX-03 audit query: forwarding and error clarity › forwards a FULL query
string to the route unchanged

    expect(received).toBeDefined()

    Received: undefined

      159 |     await open('?severity=warning&actor=ops&resource=doc-1&from=2026-09-0
1T00:00:00Z&to=2026-09-28T23:59:59Z&limit=25&cursor=abc');
      160 |     const u = auditHit();
    > 161 |     expect(u).toBeDefined();
          |               ^

      at Object.<anonymous> (tests/admin-audit-query.test.ts:161:15)
```
25 block còn lại cùng một dạng: `auditHit()` là `undefined` ⇒ **shell không hề gọi upstream** (mọi assert sau đó
đổ theo). Xem A/B ở §KẾT LUẬN: nguyên nhân là môi trường.

## RED #5 — `tests/v1-boot-typed-denial.test.ts` (2 đỏ / 10, exit 1)
```
● V1 boot missing profile cipher key policy › continues boot without either key and emits one warning naming the denied operation
● V1 boot missing profile cipher key policy › does not warn when either supported key is present
```
```
  ● V1 boot missing profile cipher key policy › continues boot without either key
and emits one warning naming the denied operation

    ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime
artifact grants

      133 |   if (!raw) {
      134 |     if (env.NODE_ENV === 'production' && (env.ARTIFACT_STORAGE_BACKEND
?? 'postgres') === 'postgres') {
    > 135 |       throw new Error('ORCHESTRATOR_INTERNAL_BASE_URL is required for
production PostgreSQL Runtime artifact grants');
          |             ^
      136 |     }
      137 |     return undefined;
      138 |   }

      at runtimeGrantBaseUrlFromEnv (src/main.ts:135:13)
      at main (src/main.ts:289:21)
      at withBootEnv (tests/v1-boot-typed-denial.test.ts:183:18)
      at Object.<anonymous> (tests/v1-boot-typed-denial.test.ts:247:11)
```

## RED #6 — `tests/admin-audit-mount.test.ts` (6 đỏ / 6, exit 1)
```
● W-ADM-UX-03 audit mount: live ledger through the real route › the shell mounts and GET /admin/audit answers 200 for a signed-in admin
● W-ADM-UX-03 audit mount: live ledger through the real route › the pane renders the REAL ledger event served by the route
● W-ADM-UX-03 audit mount: live ledger through the real route › the pane is NOT the not-wired error state
● W-ADM-UX-03 audit mount: live ledger through the real route › the default fetcher called the audit route with the bearer token
● W-ADM-UX-03 audit mount: live ledger through the real route › the Audit Log tab is present in the shell nav
● W-ADM-UX-03 audit mount: live ledger through the real route › toolbar query params are forwarded to the route as real query values
```
```
  ● W-ADM-UX-03 audit mount: live ledger through the real route › the shell mounts
and GET /admin/audit answers 200 for a signed-in admin

    expect(received).toBe(expected) // Object.is equality

    Expected: 302
    Received: 503

      144 |       body: new URLSearchParams({ token: TOKEN, redirect: '/admin/audit'
}).toString(),
      145 |     });
    > 146 |     expect(res.status).toBe(302);
          |                        ^

      at adminCookie (tests/admin-audit-mount.test.ts:146:24)
      at Object.<anonymous> (tests/admin-audit-mount.test.ts:152:20)
```
Cả 6 test đỏ ở cùng một helper `adminCookie` (`:146`) — POST `/admin/login` trả **503** thay vì **302**.

---

# KẾT LUẬN TRUNG THỰC

**1) Con số thật:**
- **249 suite** được discover: **229 "passed"**, **6 failed**, **14 skipped**.
- Nhưng **229 không phải 229 suite xanh hoàn toàn**: **4 suite trong đó có 29 test pending** (bảng §3c) ⇒ số suite
  **xanh hoàn toàn = 225**.
- **5256 test**: **5098 passed**, **40 failed**, **118 skipped**. `118 skipped` = 89 (14 suite skip toàn bộ) + 29
  (4 suite skip một phần) — khớp số học.
- **Không flaky:** 2 lần full run giống hệt nhau về mọi con số và cùng danh sách 6 suite đỏ; 40 test đỏ khi chạy
  riêng = 40 test đỏ trong full run ⇒ **không phụ thuộc thứ tự**.

**2) 40 test đỏ chia làm 3 nhóm nguyên nhân (phân loại, KHÔNG sửa):**

| Nhóm | Số test | Suite | Bằng chứng |
|---|---:|---|---|
| **A. Phụ thuộc môi trường `NODE_ENV=production`** | **34** | `admin-audit-query` (25), `admin-audit-mount` (6), `v1-boot-typed-denial` (2), `admin-error-boundary-offline` (1) | **A/B đã chạy:** với `NODE_ENV=test` (chỉ đổi biến môi trường của tiến trình con, **không sửa file**), cả 4 suite **xanh hoàn toàn**: `6 passed/6`, `26 passed/26`, `10 passed/10`, `42 passed/42`, exit **0** cả 4. Shell này có `NODE_ENV=production` ⇒ guard production bật (cookie posture ⇒ login 503; `main.ts:135` ném; log `environment: "prod"`). |
| **B. MISMATCH docs↔code đã triage** | **5** | `artifact-read-authorization` | `triage-artifact-read-mismatch-INDEPENDENT-2026-10-08.md` — docs `28:1399` nói 403 / code `artifacts.ts:707` trả 409 `LEASE_LOST`; owner phải phân xử. |
| **C. Assertion ngân sách RSS** | **1** | `public-upload-encryption-gateway` | Đỏ 3/3 lần chạy riêng, `Received` 218–220 MB vs ngân sách 171.9 MB. Lớp phụ thuộc GC/môi trường. |

**3) Có test nào được báo xanh một cách không trung thực không?**
- **Không tìm thấy test xanh giả do `.only`/`fit`/`fdescribe`** (grep 0 hit) — không có focus che test.
- **Có một bẫy báo cáo thật:** 4 suite có test pending vẫn được jest đếm vào `numPassedTestSuites` ⇒ nếu ai đó
  trích "229 suite passed" như bằng chứng phủ xanh thì **sai 4 suite / 29 test**. Receipt này ghi rõ để không ai
  trích như vậy.
- **`skipped` không phải `pass`:** 118 test bị skip toàn bộ vì gate live (DB/Redis/S3/Vault/migration) — **chưa
  được chứng minh chạy** trong phiên offline này, kể cả các suite "xanh một phần" ở §3c.

**4) Typecheck:** cả hai (service + admin-web) **exit 0, không có dòng `error TS` nào**.

**5) Ranh giới:** receipt này **không sửa gì**, **không commit**, **không tick gate**, không claim DB window. Cây
đang được các lane khác ghi song song (porcelain 90 → 92), nên đây là **snapshot tại thời điểm chạy** — nếu chạy
lại sau khi các lane kia dừng, số liệu có thể khác. Việc phân xử nhóm A (pin `NODE_ENV` trong config hay sửa kỳ
vọng của 4 suite) và nhóm B (docs hay code canonical) thuộc **owner/coordinator**, không thuộc lane verify này.

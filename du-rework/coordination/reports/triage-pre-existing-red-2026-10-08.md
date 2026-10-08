# TRIAGE read-only — 11 suite đỏ có sẵn (2026-10-08)

- **Mode:** READ-ONLY. Không sửa source/test, không commit/push, không tick `VERIFIED`/`ACCEPTED`,
  không hand-edit `docs/21-openapi.json`. **0 file trong repo bị thay đổi** bởi lane này (chỉ receipt + raw).
- **Lease tôn trọng:** không chạm WFA-T26/T27, không chạm `apps/admin-web/src/**`, không chạm
  `services/connector/src/**`.
- **Environment:** Windows; Node **v24.21.0**; jest **30.2.0**; `--config jest.unit.config.cjs` (offline,
  `DU_LIVE_INFRA` không set ⇒ 13 suite live bị skip).
- **Tree pin:** HEAD `df3f955` + working tree **dirty** (nhiều lane đang chạy song song — trong lúc triage
  có file test mới xuất hiện: `f5-bff-tenant-cursor-offline`, `f6-api-key-tenant-select-offline`).
  Vì vậy mọi số ở đây gắn với **thời điểm chạy**, không phải một commit.
- **Raw + `SHA256SUMS.txt`:** `coordination/reports/raw/triage-pre-existing-red-2026-10-08/`.

## 0. Kết luận nhanh

| Leg | Câu hỏi | Kết luận |
|---|---|---|
| 1 | `admin-shell-session-lifecycle.test.ts:821` — `record.event` undefined | **BUG PRODUCT** (không phải bug test). Emitter truyền event dạng **object**; allow-list của `@du/observability` **cấu trúc-không-thể** giữ object ⇒ field bị **bỏ im lặng**. Doc của chính shell hứa điều ngược lại. Chi tiết §1. |
| 2 | `artifact-read-decrypt-offline` FLAKY? | **KHÔNG tái hiện được.** 4/4 lần chạy riêng PASS (32 test, exit 0) **và PASS trong full run 241 suite**. Suite không có port/timer/env/DB ⇒ rủi ro flake thấp. Không tìm thấy phụ thuộc thứ tự. §2. |
| 3 | 7 suite đỏ còn lại | **11/11 suite đều đỏ khi chạy RIÊNG** ⇒ **deterministic, không phụ thuộc thứ tự**. Tổng test đỏ khi chạy riêng = **102 = đúng bằng** số đỏ của full run ⇒ không test nào chỉ đỏ khi chạy chung. Bản đồ nguyên nhân + owner §3. |
| — | Attribution bằng git | **Bất khả thi:** lịch sử bị squash; mọi file test trỏ về cùng commit `df3f955` (xem §4). Owner dưới đây suy ra từ **coordination reports**, có ghi nguồn. |

**Cross-check quan trọng:** cộng số test đỏ của 11 lần chạy riêng =
1+11+29+18+6+1+2+6+25+1+2 = **102** = đúng `Tests: 102 failed` của full run. Đây là bằng chứng định lượng
cho "không có order dependency".

## 1. LEG 1 — `admin-shell-session-lifecycle.test.ts:821`: `record.event` = undefined

### 1.1 Tái hiện

```
cd du-rework/orchestrator/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent \
  --runTestsByPath tests/admin-shell-session-lifecycle.test.ts
→ FAIL: 1 failed, 50 passed, 51 total, EXIT=1
   Expected: {"kind":"auth.login_failed","method":"POST","pathname":"/admin/login","reason":"invalid_token"}
   Received: undefined            (tests/admin-shell-session-lifecycle.test.ts:821)
```
Raw: `raw/01-leg1-session-lifecycle.txt`. Suite này **đỏ cả khi chạy riêng** ⇒ deterministic.

### 1.2 Test truyền mẫu gì vào, và nó đọc cái gì

`tests/admin-shell-session-lifecycle.test.ts:793-828`:
1. `jest.spyOn(process.stdout,'write')` để hứng stdout (:798) — sink mặc định của `@du/observability` ghi
   JSON ra stdout.
2. Boot shell THẬT: `createAdminShellServer({port:0, cookieSecret, adminToken:'at'})` (:803).
3. POST `/admin/login` với `token=SENTINEL-SOCKET-LEAK-6666` (:806).
4. Lọc đúng **1** dòng có `"message":"[admin-shell] security event"` (:813-817) — khẳng định này **PASS**,
   tức dòng log **có** được ghi.
5. `JSON.parse(first)` rồi đòi `record.event` = `{kind, reason, method, pathname}` (:820-826) — **đây là chỗ đỏ**.

⇒ Không phải "assertion đọc nhầm biến": dòng log tồn tại, nhưng **field `event` không có trong JSON**.

### 1.3 Vì sao `event` mất — chứng minh trực tiếp

- **Emitter (product):** `src/app/admin/shell-server.ts:752-755`
  ```ts
  const securityAudit: AdminSecurityAuditSink = options.securityAudit ?? ((event) => {
    logger.warn('[admin-shell] security event', { event });   // ← object lồng
  });
  ```
  Doc ngay trên đó (`:104-110`) hứa: *"ONE structured console line per event (**[admin-shell] security event
  + JSON of the closed AdminSecurityEvent** — fixed vocabulary, never a credential)"*.
- **Logger:** `packages/observability/src/logger.ts:124-142` — `warn(message, fields)` **có** merge
  `...fields` vào record. Nên mất mát **không** xảy ra ở đây.
- **Chỗ bỏ field:** `packages/observability/src/log-metadata.ts:17-42` — allow-list theo **shape**:
  - `:7` `event` **có** trong `IDENTIFIERS`, NHƯNG `:29-32` chỉ nhận `child === null`, **string** khớp regex,
    hoặc **number** hữu hạn. `event` ở đây là **object** ⇒ **không nhánh nào khớp ⇒ key bị bỏ hoàn toàn**.
  - `:16` ghi rõ chủ đích: *"Allow metadata by shape; no arbitrary strings/objects survive any sink."*
- **Probe tái hiện (read-only, không ghi file repo — `raw/02-leg1-logger-probe.txt`):**
  ```
  logger.warn('[admin-shell] security event', { event })
  → {"subsystem":"admin-shell","timestamp":"…","level":"warn",…,"message":"[admin-shell] security event"}
     (KHÔNG có "event")

  logger.warn('[admin-shell] security event', { kind, reason, method, pathname })
  → {"subsystem":"admin-shell","kind":"auth.login_failed","reason":"invalid_token","method":"POST",…,
     "message":"[REDACTED]"}
     (kind/reason/method SỐNG; "pathname" MẤT)
  ```
  Phát hiện thứ hai quan trọng không kém: **`pathname` không nằm trong `IDENTIFIERS`** (`log-metadata.ts:4-9`)
  ⇒ kể cả khi flatten, `AdminSecurityEvent` (`rbac.ts:232-238`, có `pathname?: string`) **vẫn không thể**
  biểu diễn đủ trong log metadata. Ngoài ra `message` bị `[REDACTED]` nếu chuỗi không nằm trong
  `SAFE_LOG_MESSAGES` (`log-metadata.ts:21-22`) — một ràng buộc nữa mà emitter phải biết.

### 1.4 Kết luận Leg 1: **BUG PRODUCT**, không phải bug test

- Test khẳng định **đúng theo hợp đồng mà chính product tuyên bố** (`shell-server.ts:104-110`).
- Hành vi ship ra **mâu thuẫn** với hợp đồng đó: dòng audit an ninh mất toàn bộ payload sự kiện ⇒
  hậu quả thật ngoài test: **audit log an ninh không truy được `kind/reason/method/pathname`**, chỉ còn
  `message` — trong khi đây là log dùng cho điều tra sự cố.
- **Không thể đóng bằng một dòng sửa test** mà không có quyết định contract. Hai hướng hợp lệ:
  - **(A) Giữ hợp đồng:** flatten ở emitter (`{kind, reason, method, pathname}`) **+ thêm `pathname` vào
    `IDENTIFIERS`** (`log-metadata.ts:4-9`) — chạm package dùng chung, có ý nghĩa an ninh (allow-list là
    hàng rào chống rò), cần owner quyết định.
  - **(B) Đổi hợp đồng:** sửa doc `shell-server.ts:104-110` + test để chỉ mong các field allow-listed, và
    chấp nhận audit line không có payload.
- **Đề xuất:** (A), vì mục đích của dòng log này là audit an ninh; nhưng (A) **không** thuộc một lane đơn lẻ
  (`@du/observability` × admin shell) ⇒ cần packet có lease 2 phía. **Không tự sửa trong triage này.**

## 2. LEG 2 — `artifact-read-decrypt-offline`: FLAKY hay DETERMINISM?

| Lần chạy | Lệnh | Exit | Kết quả |
|---|---|---:|---|
| Riêng #1 | `--runTestsByPath tests/artifact-read-decrypt-offline.test.ts` | **0** | 1 suite, **32 passed / 32** |
| Riêng #2 | nt | **0** | 32/32 |
| Riêng #3 | nt | **0** | 32/32 |
| Riêng #4 | nt | **0** | 32/32 |
| **Full run** (241 suite, 5.215 test) | `--config jest.unit.config.cjs` | 1 (do 11 suite khác) | **`PASS tests/artifact-read-decrypt-offline.test.ts`** |

Raw: `raw/03-leg2-alone-runs.txt`, `raw/04-leg2-full-run.txt`, `raw/08-leg2-assessment.txt`.

**Kết luận: KHÔNG tái hiện được flake.** Cụ thể:
- Không có phụ thuộc thứ tự: suite **PASS trong full run** — chính điều kiện mà báo cáo nói là fail.
- Suite **không có** yếu tố rủi ro flake: grep file test cho `listen(|port|setTimeout|setInterval|NODE_ENV|
  process.env|Date.now|5433|6380|DATABASE_URL` → **0 hit thật** (chỉ khớp chuỗi con trong
  `transport`/`passes`/`reports`). Đây là suite thuần in-process: `CryptoStorageFacade` + `KeyProvider` giả,
  không socket, không DB, không Redis, không đồng hồ.
- Bộ đỏ của full run **trùng khít** lần full run trước đó của tôi (cùng 11 suite) ⇒ môi trường này ổn định.

**Đánh giá:** *không phải flaky, cũng không phải order-dependency* — theo mọi bằng chứng tôi có được.
Điều còn thiếu: **raw log của lần fail** (từ run của Codex). Đề xuất: **chưa mở issue flake**; nếu Codex còn
log, dán log đó vào — nếu không, ghi nhận là "claim không tái hiện" và đóng. Rủi ro còn lại: khác biệt môi
trường (node version, bộ suite, cờ env) chứ không phải thứ tự.

## 3. LEG 3 — 11 suite đỏ: chạy riêng + nguyên nhân + owner

Tất cả **đều đỏ khi chạy riêng** (cột Exit = exit code lần chạy riêng). Raw: `05-leg3-alone-runs.txt`,
`06-leg3-failure-details.txt`, `07-leg3-other4-details.txt`, `09-remaining4-alone.txt`.

| # | Suite | Riêng | Đỏ/Tổng | Nguyên nhân gốc (file:line) | Lớp | Owner (theo report) |
|---|---|---:|---|---|---|---|
| 1 | `admin-operations-sql` | **1** | 18/42 | Fake DB của helper `tests/helpers/operations-page-fixture.ts:110` ném `unexpected operations-list SQL` khi `list-query.ts:563` phát SQL `SELECT *, to_char(created_at AT TIME ZONE 'UTC', …) AS __cursor_sort_key …` | **Fixture drift** | Qwen Admin (W-ADMUX02 / W-ADMIN-0019) |
| 2 | `admin-operations-sort` | **1** | 11/11 | Cùng gốc: interpreter riêng của suite, `tests/admin-operations-sort.test.ts:225` chỉ nhận `/^SELECT \* FROM operations/i` | **Fixture drift** | Qwen Admin |
| 3 | `admin-operations-sort-http-offline` | **1** | 29/32 | Cùng gốc: `tests/admin-operations-sort-http-offline.test.ts:245` ném `unexpected operations-list SQL` ⇒ route THẬT trả **500** (`Expected 200, Received 500`, `:335`) | **Fixture drift** | Qwen Admin |
| 4 | `artifact-read-authorization` | **1** | 6/90 | 6 assertion về **lease semantics** (`STATE_CONFLICT` vs `PERMISSION_DENIED`, `LEASE_LOST`, ưu tiên hết hạn) trong `artifacts.ts` `requestAccess`/`assertLease` | **Pre-existing, đã tài liệu hoá** | Qwen Platform (suite CR28-03) + product lease lane |
| 5 | `enc-meta-sentinel-runtime-refs` | **1** | 1/10 | Test **GREEN pin** (`resumeOperation seals response_ref…`, `:369`) chết bằng `HttpError: operation not found` từ `runtime.ts:1433` | **Regression candidate** (pin đã xanh 2026-10-05) | ENC-META lane |
| 6 | `public-upload-encryption-gateway` | **1** | 2/12 | Fake DB của suite ném `unexpected test DB query: UPDATE artifacts SET operation_id=$2 …` (query mới ở `submission.ts:660`) | **Fixture drift** | ENC-05 / RFX gateway lane |
| 7 | `admin-shell-session-lifecycle` | **1** | 1/51 | §1 — object field bị allow-list bỏ | **Product bug** | admin-shell × `@du/observability` |
| 8 | `admin-audit-mount` | **1** | 6/6 | POST `/admin/login` trả **503** thay vì 302 (`:146`) — shell chưa được cấu hình trong ambient env này | **Ambient-env sensitive** | admin-shell/audit lane |
| 9 | `admin-audit-query` | **1** | 25/26 | `auditHit()` undefined ⇒ shell không gọi upstream (cùng họ env với #8) | **Ambient-env sensitive** | admin-shell/audit lane |
| 10 | `admin-error-boundary-offline` | **1** | 1/42 | Lệch `toMatchObject` ở test biên IdP-callback 500-HTML | **Assertion drift (1 test)** | ADM-BASE-03 / error-boundary lane |
| 11 | `v1-boot-typed-denial` | **1** | 2/10 | Boot ném `ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime artifact grants` (`src/http/errors.ts:135`) — **guard production mới** mà test chưa biết | **Product guard vs test expectation** | artifact-grants / boot lane |

### 3.1 Ba mẫu hệ thống (quan trọng hơn từng suite)

1. **Một nguyên nhân, ba suite, 58 test (#1+#2+#3).** Cả ba dùng **fake DB tự viết và strict** (ném khi gặp
   SQL lạ). Product đổi SQL ở `list-query.ts:563` ⇒ cả ba đỏ, và một trong ba đỏ thành **500 trên wire**.
   Đây **không phải 3 bug độc lập** — sửa/align 3 interpreter (hoặc chốt lại shape SQL) là xong cả cụm.
   *Chưa* kết luận bên nào "đúng" (product hay kỳ vọng test) — đó là quyết định của owner.
2. **Ambient env quyết định pass/fail (#8, #9, một phần #11).** `NODE_ENV=production` + biến môi trường
   thiếu làm shell trả 503/guard ném. Report cũ đã ghi hiện tượng này: `cc-conv02-2026-10-03.md:70` gọi bộ
   admin-shell là "11 suite standing đúng bộ admin-shell (**ambient `NODE_ENV`**)", và
   `cc-rfx-server-2026-10-02.md:84` đã **A/B** 5 suite này với `server.ts` ở bản HEAD → *"fail y hệt"*
   ⇒ không phải regression của packet đó.
3. **Fake DB strict = bẫy hệ thống.** #6 cùng dạng với #1–#3: product thêm query ở `submission.ts:660`,
   fake DB của test không biết ⇒ đỏ. Bốn suite (#1,#2,#3,#6) đỏ vì **cùng một cơ chế**.

### 3.2 Hai suite cần chú ý riêng

- **#5 `enc-meta-sentinel-runtime-refs`:** khác biệt bản chất — test đỏ là một **GREEN pin**, không phải
  "RED gap detector by design". Report `encmeta-resultref-impl-2026-10-05.md:15` ghi đã **FLIP pin** sang
  GREEN, và `encmeta-admin-projection-fix-2026-10-05.md:31` ghi 3 suite **21 passed, exit 0 ×3**. Nay pin
  GREEN đỏ ⇒ **nghi regression** trong đường `resumeOperation`/`runtime.ts:1433` (không phải "đỏ có chủ đích").
  **Cần owner xác minh trước khi xếp vào nhóm pre-existing.**
- **#4 `artifact-read-authorization`:** 6 test đỏ **khớp chính xác** danh sách đã tài liệu hoá ở
  `regression-attribution-894-2026-10-05.md:10-15` (kèm test hash "Same failure/test hash as 825B") ⇒
  **pre-existing, không phải mới**. Không cần điều tra lại từ đầu.

## 4. Phương pháp attribution & giới hạn

- **git log/blame KHÔNG dùng được:** `git log -1` cho **mọi** file test đều ra cùng commit
  `df3f955` (2026-10-07, "promote canonical workspace"), và blame trỏ về commit nhập khối
  `4308cc54` (2026-10-06) từ `du-rework/migration-candidates/...` — lịch sử bị squash, không mang thông tin lane.
- Vì vậy owner ở §3 lấy từ **coordination reports** (đã dẫn nguồn từng dòng), theo các receipt:
  `qwen-admin.md` (W-ADMIN-0019-DELTA29 — align 3 fake-DB harness), `qwen-fence-test-align-2026-10-02.md`
  (own `admin-operations-sql`), `qwen-conv12-shell-router-split-2026-10-02.md:92` (ghi chú **fixed-port**
  của `admin-operations-sort-http-offline`), `regression-attribution-894-2026-10-05.md:10-15`,
  `sec-enc-04-worker-output-encryption-2026-10-06.md:58,69`, `cc-enc-meta-sentinel-2026-10-03.md:5`,
  `encmeta-resultref-impl-2026-10-05.md:15`, `codex-rfx-gateway-v2-2026-10-02.md:5`,
  `qwen-rfx-crypto-2026-10-02.md:115` (Δ6), `cc-rfx-server-2026-10-02.md:84`, `cc-conv02-2026-10-03.md:70`,
  `business-contract-fix-820-2026-10-05.md:26`, `backfill-cli-825-2026-10-05.md:56`.
- **Giới hạn:** đây là **suy luận có nguồn**, không phải chứng minh sở hữu; report cũ có thể đã lỗi thời so
  với cây hiện tại. Việc gán owner cuối cùng thuộc coordinator.

## 5. Đề xuất (không tự thực hiện)

1. **Packet sửa 1 root cause** cho #1+#2+#3 (align 3 interpreter với shape SQL hiện tại **hoặc** chốt lại
   shape) — ROI cao nhất: 58/102 test đỏ.
2. **Packet riêng cho #7** (F-2-style): quyết định (A)/(B) ở §1.4, lease 2 phía
   `packages/observability` × `src/app/admin` — vì đây là **audit an ninh mất payload**, không phải cosmetic.
3. **#5 phải được xác minh là regression hay không** trước khi xếp "pre-existing".
4. **#4 giữ nguyên trạng thái đã tài liệu hoá** — không điều tra lại; chỉ cần owner lease-semantics quyết.
5. **#8/#9/#11**: ghi nhận là **ambient-env sensitive**; nên có một quyết định chung (pin env trong
   `jest.unit.config.cjs` hoặc inject config) thay vì mỗi lane tự đoán.
6. **#6**: align fake DB với query mới của `submission.ts:660`.
7. **#10**: 1 assertion — rẻ, giao cho lane error-boundary.
8. **Leg 2:** đóng claim flake (không tái hiện); chỉ mở lại nếu có raw log fail.

## 6. Ranh giới

Read-only: **không** sửa source/test, **không** commit/push, **không** tick `VERIFIED`/`ACCEPTED`, **không**
reconcile ledger. Mọi kết luận ở đây là **bằng chứng triage**, không phải acceptance. Raw logs:
`raw/01-leg1-session-lifecycle.txt`, `02-leg1-logger-probe.txt`, `03-leg2-alone-runs.txt`,
`04-leg2-full-run.txt`, `05-leg3-alone-runs.txt`, `06-leg3-failure-details.txt`, `07-leg3-other4-details.txt`,
`08-leg2-assessment.txt`, `09-remaining4-alone.txt`, `SHA256SUMS.txt`.

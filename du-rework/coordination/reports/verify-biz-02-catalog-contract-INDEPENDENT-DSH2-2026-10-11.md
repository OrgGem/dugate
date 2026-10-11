# Verify độc lập (DSH2) — BIZ-02 Business catalog contract conformance — 2026-10-11

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/services/orchestrator/**` và `packages/contracts/**` (chỉ đọc).
**Tuân thủ COORDINATOR-CONTRACT:** chỉ **đọc** + chạy test/probe offline; **KHÔNG** sửa mã/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài (db giả ghi lại truy vấn); receipt **0 ký tự nháy kép** (tự đếm, §7).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (khớp `engines`).
**Đối tượng:** `tests/business-catalog-contract-conformance.test.ts` (sha256 `57ab63e6b8fd3d8798db99cf5e94df058fffe621237911d4601713b0733669c6`, 214 dòng, `??`) và receipt `coordination/reports/receipt-biz-02-catalog-contract-test-2026-10-11.md`.
**Raw:** `coordination/reports/raw/verify-biz-02-catalog-contract-2026-10-11/DSH2/` — `01-biz-02-suite.log`, `02-orchestrator-typecheck.log`, `03-dsh2-probe.log`, `04-probe.cjs`, `05-limit-diag.cjs`, `SHA256SUMS.txt`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/business-catalog-contract-conformance.test.ts` | **PASS, exit 0** — `Test Suites: 1 passed, 1 total` · `Tests: 7 passed, 7 total` · `Time: 2.516 s` |
| Typecheck orchestrator | **exit 0**, 0 diagnostics |
| Keyset pagination (page/total/cursor 2 chiều/tie-break) | **XÁC NHẬN** — probe A2/A4/A5 |
| Boundary | **XÁC NHẬN có điều chỉnh** — limit 1..200 phục vụ đúng (`probe = limit+1`); **ngoài khoảng thì route CLAMP chứ không 422**, trong khi schema contract **từ chối** ⇒ **F1 (§4)** |
| Platform/tenant access control | **XÁC NHẬN** — tenant operator token → **401 UNAUTHENTICATED, 0 truy vấn**; platform `?tenantId=` **không** tạo predicate tenant (SQL/params/body giống hệt giữa 2 tenant) |
| Claim phạm vi của receipt (route catalog theo tenant chưa có) | **ĐÚNG** — quét 189 file `src`, **0** hit `business_catalog` / `tenants/{tenantId}/businesses` |
| Probe độc lập của tôi | **8/8 PASS**, exit 0 |

**Một dòng cho coordinator:** BIZ-02 **đạt verify độc lập** — suite 7/7 exit 0, typecheck sạch, và probe riêng của tôi xác nhận toàn bộ hành vi mà receipt mô tả (envelope, COUNT population, keyset 2 chiều + tie-break `business_id`, cursor sai sort → 422 trước khi truy vấn, platform-only 401, `?tenantId` bị bỏ qua); **một điểm lệch cần owner quyết (F1)**: route **clamp** `limit` ngoài khoảng (0/-1/1.5→1, 201→200, `abc`/thiếu→50) còn `AdminBusinessListQuerySchema` **từ chối** chính các giá trị đó, và suite hiện **không** phủ hành vi ngoài khoảng của route.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd `services/orchestrator`) | Exit | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/business-catalog-contract-conformance.test.ts` | **0** | `PASS` · 7 dòng `√` · `Test Suites: 1 passed, 1 total` · `Tests: 7 passed, 7 total` · `Time: 2.516 s` |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | 0 dòng output |
| 3 | probe độc lập DSH2 (`04-probe.cjs`) | **0** | `PROBE_RESULT 8/8 checks passed` |

Artifact:

| File | sha256 (24 ký tự đầu) | mtime | lines | git |
|---|---|---|---|---|
| `tests/business-catalog-contract-conformance.test.ts` | `57ab63e6b8fd3d8798db99cf` | 00:53:24 | 214 | `??` |
| `src/http/routes/admin.ts` | `8e7c05eca629317cd3e62916` | 10-10 22:35:28 | 1170 | ` M` |
| `src/modules/admin-read/business-list.ts` | `ee306b48e98a30c9e4452773` | 10-07 04:30:18 | 102 | **sạch** |
| `src/modules/admin-read/keyset.ts` | `d841f4722a72bff84d54380e` | 10-07 04:30:18 | 266 | **sạch** |
| `packages/contracts/src/public-api.ts` | `f5594486f979d6b0c3c4f6f1` | 10-10 21:09:30 | 771 | ` M` |

---

## 2. Audit 7 test của suite (đều load-bearing)

| # | Test | Assertion đáng giá |
|---|---|---|
| 1 | `keeps the global route query vocabulary closed…` | allow-list **đúng 3** tên; schema nhận `{}` và `limit=200`; **từ chối** 201, `tenantId`, `q` (strict) |
| 2 | `returns a bounded legacy global page…` | envelope đúng 5 khoá + `ListPageBaseSchema` hợp lệ; `items` 2, `total` 4 (từ COUNT), `limit` 2; SQL có `FROM business_versions`, `DISTINCT ON (business_id)`, ORDER BY + tie-break, `LIMIT $n` với **param cuối = 3** (limit+1); count params rỗng; **không** `tenant_id` |
| 3 | `walks forward and backward…` | cursor giải mã đúng `id/direction/sort`; `prevCursor` trang 1 = null; trang tiến dùng `<` với params `[timestamp, business-b]`; trang lùi dùng `>` + ORDER BY **ASC**; nội dung 2 trang đúng |
| 4 | `emits the same unique tie-break ordering for every shared sort value` | vòng qua **cả 4** `ADMIN_RESOURCE_LIST_SORT_VALUES`, khẳng định cột (`createdAt`→`created_at`, `updatedAt`→`updated_at`) + hướng + tie-break `business_id` |
| 5 | `rejects a cursor paired with another sort before querying` | 422 `INVALID_SCHEMA` + **0 truy vấn** |
| 6 | `does not let a tenant operator use the legacy global route…` | 401 `UNAUTHENTICATED` + **0 truy vấn** |
| 7 | `does not turn a platform request tenantId query into a tenant ownership predicate` | hai `tenantId` khác nhau → body **bằng nhau**, SQL/params **bằng nhau**, và không SQL nào chứa `tenant_id` |

Suite dùng **route thật** (`handleAdminRoutes`) + **contract/cursor dùng chung** + db giả ghi lại truy vấn ⇒ không vacuous, không copy logic.

---

## 3. Probe độc lập — 8/8 (harness riêng, token/input riêng)

| # | Kiểm | Kết quả đo |
|---|---|---|
| A1 | Vocabulary + biên schema | allow-list = `[limit, cursor, sort]`; shape khớp allow-list; `{}`, 1, 2, 200 nhận; **0, -1, 201, 1.5, 'abc'** bị từ chối; 4 key lạ (`tenantId`, `q`, `businessId`, `owner`) bị từ chối; sort lạ bị từ chối |
| A2 | Envelope + SQL bound | 200; envelope 5 khoá + hợp lệ; `total=4`; page SQL `DISTINCT ON` + tie-break DESC + `LIMIT $n` (param cuối **3**); count params rỗng; **không** predicate tenant |
| A3 | Biên `limit` (xem §4) | route **clamp**: `0→1`, `-1→1`, `1.5→1`, `201→200`, `abc→50`, thiếu→50, tất cả **200**; schema **từ chối** đúng các giá trị đó ⇒ **F1** |
| A4 | 4 sort | `createdAt:asc/desc`, `updatedAt:asc/desc` → đúng cột + hướng + tie-break `business_id` |
| A5 | Cursor sai sort | 422 `INVALID_SCHEMA`, **0 truy vấn** |
| A6 | Tenant operator | 401 `UNAUTHENTICATED`, **0 truy vấn** (route dùng `assertAdminAuth` — `admin.ts:389`) |
| A7 | `?tenantId` của platform | body giống hệt, SQL/params giống hệt giữa 2 tenant, **không** `tenant_id` ở bất kỳ câu nào |
| A8 | Claim phạm vi của receipt | 189 file `src` được quét, **0** hit `business_catalog`/`tenants/{tenantId}/businesses`; route toàn cục vẫn ở `admin.ts:388` |

---

## 4. F1 — Lệch giữa schema công bố và hành vi route cho `limit` ngoài khoảng (MEDIUM-LOW)

**Bằng chứng đo (route thật, db giả):**

| Input | Route trả | `body.limit` | Param probe |
|---|---|---:|---:|
| `limit=0` | 200 OK | **1** | 2 |
| `limit=-1` | 200 OK | **1** | 2 |
| `limit=1.5` | 200 OK | **1** | 2 |
| `limit=201` | 200 OK | **200** | 201 |
| `limit=abc` | 200 OK | **50** | 51 |
| (thiếu `limit`) | 200 OK | **50** | 51 |

**Cùng các giá trị đó, `AdminBusinessListQuerySchema.safeParse` trả `success: false`** (schema là `.strict()` với `limit` `int().min(1).max(200).default(50)`).

**Nguyên nhân (đọc code):** route dùng `parseAdminResourceListQuery(ctx.searchParams, ADMIN_BUSINESS_LIST_QUERY_PARAMS)` (`admin.ts:390`) — parser dùng chung **clamp** về `[1, 200]` và bỏ qua key lạ — **không** dùng `AdminBusinessListQuerySchema`; trong khi contract công bố cho chính endpoint này lại **strict**.

**Vì sao suite không bắt được:** suite khẳng định **schema** (test 1) và hành vi route **trong khoảng** (test 2–4); không test nào gửi `limit` ngoài khoảng hoặc key lạ tới **route**, nên sự lệch này nằm ngoài độ phủ.

**Đánh giá tác động (trung thực):**
- **Không** chứng minh được tác động bảo mật: clamp là fail-safe và vẫn bị chặn trên (`≤200`), key lạ bị **bỏ qua** chứ không áp dụng, route vẫn platform-only (401 với operator).
- Tác động là **hợp đồng/consumer**: client tự kiểm request theo schema sẽ kỳ vọng **422** cho `limit=201` nhưng nhận **200** với 200 dòng; `limit=abc` **âm thầm** thành 50 (khác "giá trị mặc định" mà client tưởng). Với client phân trang, đây là khác biệt dễ gây hiểu sai.
- **Đề xuất (owner quyết):** hoặc (a) route validate bằng chính `AdminBusinessListQuerySchema` để 422 như công bố, hoặc (b) ghi rõ trong contract rằng endpoint này **clamp** (schema chỉ là mô tả tham số hợp lệ, không phải cổng từ chối) — và thêm test route-level cho `limit=0/201/abc` + key lạ để khoá hành vi đã chọn.

---

## 5. Đối chiếu receipt

| Claim của receipt | Verdict |
|---|---|
| Suite mới tại `tests/business-catalog-contract-conformance.test.ts` | **ĐÚNG** (214 dòng, `??`) |
| PASS 7/7, exit 0, đúng lệnh/cwd | **ĐÚNG** (lệnh #1) |
| Phủ: vocabulary đóng, envelope chung, keyset SQL, total population, duyệt tiến/lùi, cursor ràng buộc sort, `business_id` tie-break | **ĐÚNG** — 7 test khớp đủ danh sách (§2) |
| Tenant operator **không** dùng được route toàn cục; `tenantId` của platform **không** tạo predicate sở hữu | **ĐÚNG** (test 6–7 + probe A6/A7) |
| Dùng route thật + code cursor/schema dùng chung + db giả; không DB/dịch vụ ngoài | **ĐÚNG** |
| **Giới hạn phạm vi:** endpoint catalog theo tenant (`business_catalog` / `/tenants/{tenantId}/businesses`) **chưa** được implement, receipt **không** claim acceptance cho tenant catalog | **ĐÚNG** — probe A8 xác nhận không tồn tại trong `src` |
| Không sửa mã sản phẩm, không tick gate, không git | **ĐÚNG** — file test `??`, không có gì staged |

---

## 6. GAP / open items

1. **F1 (§4)** — cần owner chốt: route 422 theo schema, hay contract ghi rõ cơ chế clamp; kèm test route-level cho biên và key lạ.
2. **Chưa có bằng chứng DB thật:** toàn bộ là db giả ghi lại truy vấn ⇒ chưa chứng minh SQL chạy đúng trên PostgreSQL (kiểu `DISTINCT ON`, keyset với `timestamptz`). Đây là giới hạn đã biết của cả suite và lượt verify.
3. **Route catalog theo tenant vẫn là việc mở** (receipt tự khai) — lượt này chỉ xác nhận **chưa tồn tại**, không đánh giá thiết kế đề xuất.
4. **`admin.ts` và `public-api.ts` đang ` M`** (chưa commit) ⇒ kết luận gắn sha256 tại §1; lane khác sửa tiếp thì phải chạy lại.
5. **Ghi chú trung thực về probe của tôi:** lượt chạy đầu lỗi `MODULE_NOT_FOUND` vì tôi resolve `@du/contracts` từ sai thư mục (`packages/contracts/node_modules`); sau khi trỏ về `services/orchestrator/node_modules` thì probe chạy. Một lần nữa, A3 ban đầu tôi kỳ vọng 422 cho `limit=0` — kỳ vọng đó **sai** so với hành vi thật (clamp), và chính nó phát hiện **F1**. Không đụng sản phẩm trong cả hai lần.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy jest/tsc/probe offline; **không** sửa mã sản phẩm/test/config/docs; **không** `git add`/commit/push; **không** tick gate; không DB/Redis/mạng ngoài.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-biz-02-catalog-contract-2026-10-11/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`.
- Tự kiểm theo COORDINATOR-CONTRACT: **0 ký tự nháy kép** (đếm bằng mã hoá ký tự), **0 dòng trailing whitespace**; không hành động ghi nào ngoài `coordination/reports/**`.

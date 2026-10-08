# FIX TRIAGE #1 — cụm fake-strict-DB (58 test đỏ) — 2026-10-08

- **Nguồn:** `coordination/reports/triage-pre-existing-red-2026-10-08.md` §3.1 (mẫu #1: "một nguyên nhân,
  ba suite, 58 test").
- **Kết luận điều tra:** **PRODUCT KHÔNG SAI.** Câu SQL ở `list-query.ts:564` là **hợp đồng đã được pin**;
  thủ phạm là **4 test double/assertion cũ** trong tầng test. Vì vậy **không sửa một dòng nào trong `src/`**
  — sửa tại **seam double** đúng như yêu cầu "không sửa 58 test cho khớp, không nong long assertion".
- **Lease đã dùng (đúng 4 file test, 0 file product):**
  `tests/helpers/operations-page-fixture.ts`, `tests/admin-operations-sql.test.ts`,
  `tests/admin-operations-sort.test.ts`, `tests/admin-operations-sort-http-offline.test.ts`
  (diff: **66 insertions / 10 deletions**).
- **Compliance:** không commit/push, không chạm `docs/21-openapi.json` (mtime **03:06:23**, trước phiên),
  không tự tick gate triage, không tick `VERIFIED`/`ACCEPTED`. `src/modules/operations/list-query.ts`
  **vẫn sạch so với HEAD** (đã kiểm bằng `git status`).
- **Environment:** Node **v24.21.0**, jest **30.2.0**, `--config jest.unit.config.cjs`.
- **Raw + `SHA256SUMS.txt`:** `coordination/reports/raw/triage1-list-query-2026-10-08/`.

## 0. Kết quả

| | Trước | Sau |
|---|---|---|
| Cụm 3 suite | **58 failed** (18 + 11 + 29), 3 suite đỏ | **85 passed** (42 + 11 + 32), **3 suite xanh, exit 0** |
| Toàn bộ offline suite | 11 suite đỏ / **102 test đỏ** | **8 suite đỏ / 44 test đỏ** (−3 suite, **−58 test**) |
| Test xanh toàn cục | 4.997 | **5.058** (+61) |

8 suite đỏ còn lại **đúng bằng** các nhóm khác đã ghi trong receipt triage (leg 1 observability, artifact
lease-semantics, ENC-META, gateway, admin-audit ×2, error-boundary, v1-boot) — **không nằm trong lease này**.

## 1. Vì sao KHÔNG sửa product (bằng chứng)

Câu SQL thật (`list-query.ts:564`):
```sql
SELECT *, to_char(<sortKey> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS __cursor_sort_key
FROM operations … ORDER BY <sortKey> <dir>, id <dir> LIMIT $n
```
Projection này **không phải thứ vô tình**, nó được pin ở 3 nơi:

1. `tests/operations-list-cursor-sort-binding.test.ts:341-343` — assert **nguyên văn cả câu SQL** (kể cả
   `to_char(created_at AT TIME ZONE 'UTC', …) AS __cursor_sort_key`), và suite này **đang xanh**.
2. `tests/operations-list-contract-conformance.test.ts:70,204,306,367` — match đúng shape đó, **đang xanh**.
3. `list-query.ts:468-469` — lý do tồn tại: *"pg Date truncates microseconds. SQL supplies the exact boundary
   separately."* Fallback `operationsListBoundaryKey:470` chỉ chạy khi row **thiếu** cột này.
4. Mọi field sort đều là timestamp (`OPERATIONS_LIST_SORT_COLUMN_SQL:394-398`: `created_at`, `updated_at`,
   `deadline_at`) ⇒ `AT TIME ZONE 'UTC'` luôn hợp lệ, **không** có nhánh SQL sai.

⇒ Revert projection sẽ **làm đỏ 2 suite đang xanh**. Ngược lại, 3 interpreter cũ chỉ nhận
`/^SELECT \* FROM operations/i` — tức **từ chối một câu SQL hợp lệ** và báo nhầm thành
`unexpected … SQL`, kéo cả suite xuống. Đó là **defect của test double**, không phải của route.

**Git state (kiểm để loại trừ "lane khác đang sửa dở"):** cả `list-query.ts` và 4 file test đều **sạch so với
HEAD** (`df3f955`) ⇒ mâu thuẫn này **đã nằm trong bản promote**, không phải thay đổi dở dang.

## 2. Phân rã 58 test đỏ (đính chính receipt triage)

| Nhóm | Số test | Nguyên nhân | Cách sửa |
|---|---:|---|---|
| **A1** | **51** | 4 double dùng `/^SELECT \* FROM operations/i`, từ chối câu SQL có projection | thay bằng matcher chung ở **seam double** |
| **A2** | **1** | `admin-operations-sql.test.ts:442` assert `not.toMatch(/'|;|--/)` — proxy này cũ nay bắt nhầm **literal compile-time** của projection (`'UTC'`, format string) | strip **đúng các literal compile-time đã đặt tên** rồi mới assert (không nới lỏng: quote/`;`/`--` nào khác vẫn đỏ) |
| **B** | **6** | khối B của `admin-operations-sort-http-offline` login **503** vì `NODE_ENV=production` ⇒ `parseCookieSecurePolicy` bật `requireSecure` ⇒ shell từ chối mint cookie (`auth-dispatch.ts:120-130`) | pin `cookiePolicy` như 10+ suite khác đã làm |

**Đính chính so với triage:** receipt triage gán cả 29 test của suite http-offline cho nguyên nhân SQL. Thực
tế **23 là SQL (A1) + 6 là ambient-env (B)** — nhóm B là *root cause khác*, đã được triage liệt kê riêng ở
mẫu #2 nhưng nằm cùng file nên bị gộp số. Ghi lại để không nhân sai nguyên nhân.

## 3. Fix đã làm (4 file test, không đụng assertion nào bị nới)

1. **`tests/helpers/operations-page-fixture.ts`** — thêm **2 matcher dùng chung**:
   - `OPERATIONS_LIST_PAGE_SQL_RE` = `/^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i`
     (câu page hiện đại — dùng cho các suite chỉ chạy route mới).
   - `OPERATIONS_LIST_ANY_SQL_RE` = `/^SELECT \*(?:, to_char\(.+ AS __cursor_sort_key)? FROM operations/i`
     (câu page hiện đại **hoặc** câu list của **legacy compat facade** — `legacy-host-adapter.ts:429`).
   - Dùng `ANY` ở cả 3 chỗ của helper: dispatcher `query` (:135), `pageQuery` (:158), `calls_with_page` (:175).
2. **`admin-operations-sort.test.ts`** — interpreter riêng dùng `OPERATIONS_LIST_PAGE_SQL_RE` (guard `:224`).
3. **`admin-operations-sort-http-offline.test.ts`** — interpreter riêng (`:181`) + `pageQueries()` (`:321`)
   dùng matcher chung; **thêm `cookiePolicy: { requireSecure: false, trustProxyProtocol: false }`** vào
   `createAdminShellServer` (`:681` mở object, pin ở **`:692`**) theo đúng convention đã có ở
   `admin-shell-server.test.ts:121`, `admin-shell-platform-mount.test.ts:195`, `aweb0x`, `bff-*`, `f5-*`,
   `tenant-list-*` (10+ suite).
4. **`admin-operations-sql.test.ts`** — interpreter riêng (`:253`) dùng matcher chung; assertion proxy ở
   `:442` được thay bằng bản **đặt tên literal compile-time** (A2).

**Tự báo lỗi của chính tôi (không giấu):** lần siết đầu tiên tôi cho helper chỉ nhận shape **có projection**,
và điều đó **tự tạo 1 regression**: test `the x-api-key path is fenced by the KEY` chạy qua **legacy**
statement (`SELECT * FROM operations … ORDER BY created_at DESC LIMIT $2`) nên bị double mới từ chối. Suite
tự bắt được (7→2 đỏ), tôi sửa bằng `OPERATIONS_LIST_ANY_SQL_RE` và ghi lại đây. Đây cũng là lý do tồn tại
của matcher `ANY`.

## 4. Fail-first (giữ cả log đỏ và xanh)

| Bước | Lệnh (cwd `orchestrator/services/orchestrator`) | Exit | Kết quả | Raw |
|---|---|---:|---|---|
| **RED** (trước khi sửa) | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent --runTestsByPath tests/<suite>.test.ts` × 3 | **1** | `admin-operations-sql` **18 failed**/42 · `admin-operations-sort` **11 failed**/11 · `admin-operations-sort-http-offline` **29 failed**/32 → **58** | `01-fail-first-RED.txt` |
| **GREEN** (sau khi sửa) | cùng lệnh × 3 | **0** | **42/42 · 11/11 · 32/32 = 85 passed** | `02-cluster-GREEN.txt` |
| Trung gian | — | 1 | `03-remaining-failures.txt` (7+6 còn lại), `04-sql-suite-remaining2.txt` (2 còn lại: A2 + legacy) | nt |
| Liên quan | `… jest … tests/operations-list-contract-conformance.test.ts tests/operations-list-cursor-sort-binding.test.ts tests/admin-operations-query.test.ts tests/admin-operations-view.test.ts tests/admin-operation-view-model.test.ts tests/admin-operation-cockpit.test.ts tests/admin-operations-sort-wiring.test.ts tests/admin-sort-allowlist.test.ts tests/admin-keyset-explain.test.ts tests/rcr-luna-http-encryption.test.ts` | **0** | **10 suite / 471 passed / 13 skipped** | `05-related-suites-and-tsc.txt` |
| Typecheck | `pnpm exec tsc --noEmit -p tsconfig.json` | **0** | sạch (`output_bytes=0`) | nt |
| Toàn cục | `… jest … --config jest.unit.config.cjs --silent` | **1** | **8 suite đỏ / 44 test đỏ** (trước: 11/102); 221 suite xanh / 5.058 test xanh | `06-full-offline-suite-after.txt` |

## 5. Kiểm tra thêm (không tạo báo động giả)

- **`rcr-luna-http-encryption.test.ts:47,184`** dùng matcher **không neo** `/SELECT \* FROM operations/i` —
  đã kiểm: câu **đọc một operation** vẫn là `SELECT * FROM operations WHERE id=$1`
  (`runtime.ts:1793,1808`) nên branch đó **còn sống** và assertion "không đọc operations" ở `:184`
  **không rỗng**. Không sửa, không phải finding.
- **Proxy `'|;|--`**: grep toàn `tests/` — chỉ còn **1** chỗ, chính là bản đã sửa ở
  `admin-operations-sql.test.ts:459`. Không còn suite nào mang proxy kiểu này.
- **Không sửa gì trong `src/`**: `list-query.ts` sạch; 3 file `src` có mtime mới trong ngày (06:14, 07:46)
  đều **trước** bản sửa đầu tiên của tôi (08:37) và thuộc lane khác.

## 6. Còn lại / ngoài lease

- 8 suite đỏ còn lại **không đổi** và **không thuộc** lease này: `admin-shell-session-lifecycle` (product bug
  observability — receipt triage §1), `artifact-read-authorization` (lease semantics, pre-existing),
  `enc-meta-sentinel-runtime-refs` (GREEN pin nghi regression), `public-upload-encryption-gateway`,
  `admin-audit-mount`, `admin-audit-query`, `admin-error-boundary-offline`, `v1-boot-typed-denial`.
- **Nhóm B (ambient env) mới sửa ở 1 suite.** Cùng cơ chế còn ở `admin-audit-mount` + `admin-audit-query`
  (login 503 / không gọi upstream). Đề xuất vẫn như triage: một quyết định chung (pin env trong
  `jest.unit.config.cjs` **hoặc** inject `cookiePolicy` từng suite) — **không tự mở rộng** trong task này.
- Không cập nhật `docs/28-test-inventory.md` / `docs/35-acceptance-baseline.md` (ngoài lease).

## 7. Ranh giới

Báo cáo thực thi + bằng chứng; **không** claim `VERIFIED`/`ACCEPTED`, **không** tick gate triage, **không**
reconcile ledger. Không commit, không push: 4 file nằm nguyên ở working tree.

# FIX — WFA §8 finding LOW: legacy page-token cursor unscoped — 2026-10-08

## ⚠️ ĐỌC TRƯỚC: 1 suite của lane khác bị ảnh hưởng (không sửa được theo lease)

Fix này **làm đỏ đúng 1 test** ở `tests/rv01-loopback-http-offline.test.ts` — **không phải regression sản
phẩm**, mà là **test double của suite đó pin y nguyên văn câu subquery CŨ**:

- `rv01-loopback-http-offline.test.ts:362`:
  `/\(created_at, id\) < \(select created_at, id from operations where id = \$(\d+)\)/`
  — regex này đòi dấu `)` **ngay sau** placeholder. Sau fix, subquery có thêm scope ⇒ không khớp ⇒ double
  **không áp boundary nào** ⇒ trang 2 trả 2 row thay vì 1.
- Test đỏ: `GET /operations answers {operations, next_page_token} and pages by plain uuid` (`:1328`, assert ở
  `:1365`), literal `Expected 1 / Received 2`.
- **Lease cấm tôi sửa file này** ("KHÔNG được sửa file khác, KHÔNG được sửa tests/ của lane khác") ⇒ tôi
  **không chạm**. Cần owner của rv01 cập nhật **1 dòng** (nới regex để nhận subquery có scope; và nên **áp
  luôn scope** như interpreter của tôi để double không còn pass rỗng).
- Đã grep toàn `tests/`: **chỉ rv01** pin shape này (các hit `FROM operations WHERE id=$1` khác là câu đọc
  một operation, không liên quan).

## Finding (verbatim từ `coordination/reports/wfa-section8-security-review-2026-10-08.md`)

> **LOW - legacy page-token cursor unscoped:** `src/compat/legacy-host-adapter.ts:405-430` (esp. `:420-429`);
> `src/modules/runtime/runtime.ts:1845-1852`. Outer list query is tenant/API-key scoped but its page-token
> scalar subquery loads `created_at`/`id` by operation id only. `runtime.listOperations` has the same pattern;
> no call site for that helper was found. Outer result rows remain scoped.

## Trạng thái: ĐÃ SỬA (RED → GREEN) + tsc xanh; chờ **verify độc lập**

Không tick gate nào (không `ACCEPTED`/`VERIFIED`), không sửa WFA plan file, không commit/add/push.

## 1. Reachability (kiểm trước khi sửa)

- `listLegacyOperations` **có** call site thật: `src/compat/legacy-http-mount.ts:714` (route list legacy) ⇒
  leak **reachable**, không phải code chết.
- `runtime.listOperations` **không** có call site nào trong repo (grep: 1 hit = chính định nghĩa) ⇒ đúng như
  finding; vẫn vá vì lease yêu cầu và vì helper chết hôm nay có thể được nối dây ngày mai.

## 2. Decision + lý do

**Thêm scope predicate vào CHÍNH subquery, mirror đúng scope của outer query. Không đổi shape ngoài, không
thêm param, không fail-closed bằng cách khác.**

| Lựa chọn | Lý do chọn / loại |
|---|---|
| **Mirror scope vào subquery** (chọn) | Đúng yêu cầu finding. Hai param `$1` (tenant) và `$3` (apiKeyId) **đã tồn tại** ⇒ không thêm placeholder ⇒ **không đổi vị trí `$n`** ⇒ không phá các test đang pin shape SQL khác. Token ngoài scope ⇒ subquery `NULL` ⇒ so sánh row-value `NULL` với mọi row ⇒ **trang rỗng = fail-closed**, không rò, không "thành công giả". |
| Đọc token bằng một query riêng có scope | Thêm round-trip, đổi shape nhiều hơn, không cần thiết. |
| Bỏ hẳn subquery / đổi sang cursor mã hoá | Ngoài phạm vi finding, phá hợp đồng `page_token` legacy (plain uuid id). |
| Đưa `deleted_at IS NULL` + filters vào subquery | **Loại**: đó là *visibility/filter*, không phải *authorization*. Thêm vào sẽ biến row biên bị soft-delete giữa 2 trang thành trang rỗng ⇒ hỏng walk hợp lệ. Scope vá đúng bằng scope finding. |

## 3. Thay đổi (file:line)

### 3.1 `src/compat/legacy-host-adapter.ts` — `listLegacyOperations` (lease: cả file)

- Scope **đặt tên một lần** và dùng cho **cả** outer WHERE **và** subquery, để hai bên không thể lệch nhau:
  ```ts
  const tenantScope = 'tenant_id = $1';
  const apiKeyFence = "(pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3)";
  const where: string[] = [tenantScope, 'deleted_at IS NULL', apiKeyFence];
  ```
- Subquery page-token (trước → sau):
  ```sql
  -- trước
  (created_at, id) < (SELECT created_at, id FROM operations WHERE id = $N)
  -- sau
  (created_at, id) < (SELECT created_at, id FROM operations WHERE id = $N AND tenant_id = $1 AND (pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3))
  ```
- `$2` vẫn là LIMIT; `states`/`processors` vẫn được bind từ `$4` trở đi ⇒ **thứ tự placeholder không đổi**.

### 3.2 `src/modules/runtime/runtime.ts` — `listOperations` (**chỉ `:1845-1852`**, đã kiểm bằng `git diff`)

```sql
-- trước
AND created_at < (SELECT created_at FROM operations WHERE id=$2)
-- sau
AND created_at < (SELECT created_at FROM operations WHERE id=$2 AND tenant_id=$1)
```
Outer của helper này chỉ scope **tenant** (không có fence api_key) ⇒ mirror **đúng** tenant, **không** tự
thêm scope hẹp hơn. Diff nằm trọn trong hunk `@@ -1844,7 +1844,12 @@` ⇒ không sửa chỗ khác.

### 3.3 Test mới (file riêng của lane này)

`tests/fix-section8-legacy-cursor-offline.test.ts` — 8 test, offline (không DB/listener/env).

**Điểm cốt lõi: fake DB là interpreter TRUNG THỰC** — nó resolve boundary bằng **đúng những predicate mà câu
subquery phát ra**, không hơn (giống PostgreSQL). Nhờ vậy suite **đỏ thật trước fix** và **xanh thật sau
fix**, không phải stub trả page cố định. Nó cũng **ghi lại row mà subquery đã đọc** (`capture.boundary`) ⇒
bằng chứng leak là dữ liệu, không phải suy luận.

## 4. RED (fail-first) — literal

```
FAIL tests/fix-section8-legacy-cursor-offline.test.ts
    × the boundary subquery carries the same tenant scope the outer query uses
    × a foreign-tenant page token resolves no boundary and returns an empty page
    × a same-tenant page token owned by another api key is not resolvable either
    × scope indices survive the states and processors filters being appended
    √ an own page token still walks the caller own rows (no over-fencing)
    × the cursor subquery carries the same tenant scope the outer query uses
    × a foreign-tenant cursor resolves no boundary and returns no rows
    √ an own cursor still walks, and the no-cursor path is unchanged
Test Suites: 1 failed, 1 total
Tests:       6 failed, 2 passed, 8 total
EXIT=1
```

**Đỏ vì đúng lý do** (không phải lỗi harness) — fake in ra row mà subquery thật sự đọc được:
- token **tenant khác** → `Received: {"id":"op-b-newest","tenant_id":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",…}`
  ⇒ subquery **đọc row của tenant khác**;
- token **cùng tenant, api_key khác** → `Received: {"id":"op-a-other-key","api_key_id":"key-bbbb","pipeline_json":"[{\"workflow\":\"wf-b\"}]"}`
  ⇒ **vượt api_key fence**;
- 2 test guard (token của chính mình) **xanh cả trước lẫn sau** ⇒ fix **không over-fence**.

**Tự báo (không giấu):** bản nháp đầu có **1 expectation sai của tôi** — tôi tưởng `runtime.listOperations`
có fence api_key, thực tế helper chỉ scope tenant; đã sửa expectation **trước khi chạm source**. Đó không
phải 1 trong 6 assertion đỏ ở trên.

## 5. GREEN — literal

```
PASS tests/fix-section8-legacy-cursor-offline.test.ts
    √ the boundary subquery carries the same tenant scope the outer query uses
    √ a foreign-tenant page token resolves no boundary and returns an empty page
    √ a same-tenant page token owned by another api key is not resolvable either
    √ scope indices survive the states and processors filters being appended
    √ an own page token still walks the caller own rows (no over-fencing)
    √ the cursor subquery carries the same tenant scope the outer query uses
    √ a foreign-tenant cursor resolves no boundary and returns no rows
    √ an own cursor still walks, and the no-cursor path is unchanged
Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
EXIT=0
```

## 6. Bảng lệnh / exit / literal

cwd cho mọi lệnh: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

| # | Lệnh | Exit | Literal |
|---|---|---:|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (sau sửa) | **0** | `tsc_output_bytes=0` |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/fix-section8-legacy-cursor-offline.test.ts` (**trước** sửa) | **1** | `Tests: 6 failed, 2 passed, 8 total` |
| 3 | y hệt #2 (**sau** sửa) | **0** | `Tests: 8 passed, 8 total` |
| 4 | `… jest … --silent <16 suite legacy + runtime liên quan>` | **0** | `Test Suites: 16 passed, 16 total` / `Tests: 391 passed, 391 total` |
| 5 | `… jest … --config jest.unit.config.cjs --silent` (full offline) | **1** | `Test Suites: 9 failed, 13 skipped, 222 passed, 231 of 244 total` / `Tests: 45 failed, 116 skipped, 5067 passed, 5228 total` |
| 6 | `… jest … --silent --runTestsByPath tests/rv01-loopback-http-offline.test.ts` (×2) | **1** | `Tests: 1 failed, 47 passed, 48 total` (cả 2 lần) |

**Đọc #5 cho đúng:** trước fix của tôi, full suite là **8 suite đỏ / 44 test đỏ**; sau fix là **9 suite / 45
test**. Chênh lệch **+1 suite / +1 test = đúng rv01** (mục ⚠️ đầu receipt), **không** phải 8 suite kia đổi
trạng thái. 16 suite legacy+runtime liên quan **391/391 xanh**.

## 7. Ràng buộc đã giữ

- **Đúng 3 file**: `legacy-host-adapter.ts` (M), `runtime.ts` (M, diff trọn trong `:1845-1852`),
  `tests/fix-section8-legacy-cursor-offline.test.ts` (mới). Không file nào khác.
- NO commit / NO `git add` / NO push. Không hand-edit `docs/21-openapi.json` (mtime **03:06:23**, không đổi).
- Không tick `ACCEPTED`/`VERIFIED`, không sửa WFA plan file, **không chạy live DB**, không claim DB window.
- Không hạ test, không nới assertion, không xoá test đỏ: 6 assertion đỏ ban đầu **giữ nguyên** và nay xanh.

## 8. Còn lại cho owner khác

1. **rv01** (mục ⚠️): nới regex `:362` + nên áp scope trong double. Không thuộc lease này.
2. 8 suite đỏ có sẵn còn lại (không liên quan finding này, đã phân loại ở
   `coordination/reports/triage-pre-existing-red-2026-10-08.md`).

## 9. Raw

`coordination/reports/raw/fix-section8-low-legacy-cursor-2026-10-08/`:
`01-RED.txt` (+ `01-RED-full.txt`), `02-red-detail-own-cursor.txt`, `03-GREEN.txt`, `04-related-suites.txt`,
`05-full-offline-suite.txt`, `06-rv01-check.txt`, `07-rv01-detail.txt`, `SHA256SUMS.txt`.

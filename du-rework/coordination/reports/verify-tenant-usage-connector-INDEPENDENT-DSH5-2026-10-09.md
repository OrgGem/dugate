# VERIFY ĐỘC LẬP (DSH5) — tenant roster + usage + connector knownIds (15 suite) — 2026-10-09

**Vai trò:** tester độc lập (không phải implementer). **Không sửa gì.**
**Quy tắc đã tuân thủ:** scope chỉ `D:/Git/dugate/du-rework` (bỏ qua nocobase/legacy root); không sửa source/test/docs; không đọc `.env.live`; **không commit/`git add`/push**; **không tick gate** (không viết VERIFIED/ACCEPTED); **OFFLINE** — không PostgreSQL/Redis, **không claim DB window**.
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233`.
**Node:** `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` → `node -v` = **v24.21.0** (đã kiểm trước khi chạy).
**Lưu ý shell:** packet mô tả `cat -v` + `sed` (bash) để bỏ ANSI/CRLF; trên PowerShell tôi làm tương đương: `-replace "\e\[[0-9;]*m",'' -replace "\r",''` trên toàn bộ log rồi mới trích dòng.
**Raw:** `du-rework/coordination/reports/raw/verify-tenant-usage-connector-INDEPENDENT-DSH5-2026-10-09/` (`lenh1-15suite-node24.log`, `sup1..3-group-*.log`, `SHA256SUMS.txt`).

## BẰNG CHỨNG — lệnh gộp 15 suite trong **1 tiến trình**

```
& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs \
  tenant-list-cursor-codec-offline tenant-list-bff-offline f5-bff-tenant-cursor-offline \
  f6-api-key-tenant-select-offline f2-overview-tenant-select-offline f4-component-tenant-select \
  usage-drilldown usage-aggregation usage-contracts-integration-offline \
  admin-connector-render admin-connector-view-model bff-connectors-actions \
  p745-connector-actions p745-connector-boot-composition p745-connector-management-proxy
```

**REAL_EXIT=`$LASTEXITCODE` đo ngay sau lệnh (không pipe): `REAL_EXIT=0`**

**3 dòng summary (nguyên văn, đã bỏ ANSI/CRLF):**
```
Test Suites: 15 passed, 15 total
Tests:       215 passed, 215 total
Time:        7.14 s
```

**15/15 suite có dòng `PASS`** (nguyên văn, đã sắp xếp; dòng của `p745-connector-boot-composition` bị PowerShell chèn tiền tố stderr `node.exe : ` nên hiện thành `PASS tests/p745...osition.test.ts:String) [], RemoteException` — **cùng một dòng PASS**, không phải suite thứ 16):
```
PASS tests/admin-connector-render.test.ts
PASS tests/admin-connector-view-model.test.ts
PASS tests/bff-connectors-actions.test.ts
PASS tests/f2-overview-tenant-select-offline.test.ts
PASS tests/f4-component-tenant-select.test.ts
PASS tests/f5-bff-tenant-cursor-offline.test.ts
PASS tests/f6-api-key-tenant-select-offline.test.ts
PASS tests/p745-connector-actions.test.ts
PASS tests/p745-connector-boot-composition.test.ts
PASS tests/p745-connector-management-proxy.test.ts
PASS tests/tenant-list-bff-offline.test.ts
PASS tests/tenant-list-cursor-codec-offline.test.ts
PASS tests/usage-aggregation.test.ts
PASS tests/usage-contracts-integration-offline.test.ts
PASS tests/usage-drilldown.test.ts
```

**FAIL: KHÔNG CÓ.** `FAIL_BLOCK_COUNT=0` (không block `●` nào), không dòng `FAIL ` nào, và dòng `Tests:` không có thành phần `failed`/`skipped`.

## BẰNG CHỨNG bổ sung — tách 3 nhóm (mỗi nhóm 1 tiến trình riêng)

| Nhóm | REAL_EXIT | `Test Suites:` | `Tests:` |
|---|---:|---|---|
| tenant (6 suite) | **0** | `Test Suites: 6 passed, 6 total` | `Tests: 36 passed, 36 total` |
| usage (3 suite) | **0** | `Test Suites: 3 passed, 3 total` | `Tests: 31 passed, 31 total` |
| connector (6 suite) | **0** | `Test Suites: 6 passed, 6 total` | `Tests: 148 passed, 148 total` |

36 + 31 + 148 = **215** ⇒ khớp chính xác con số của lệnh gộp (không suite nào bị rơi khi chạy gộp, không nhân đôi).

## Trạng thái 15 file mục tiêu (không do tôi sửa)

| Suite | git status | sha256 (12 ký tự đầu) |
|---|---|---|
| tenant-list-cursor-codec-offline | clean | `22436c1a1caa` |
| tenant-list-bff-offline | clean | `4f3b0e7f7db3` |
| f5-bff-tenant-cursor-offline | clean | `120af26c748b` |
| f6-api-key-tenant-select-offline | clean | `2a91568a16f4` |
| f2-overview-tenant-select-offline | clean | `970dd1a04794` |
| f4-component-tenant-select | **`??` (untracked)** | `24535472dd87` |
| usage-drilldown | clean | `67926e8431e0` |
| usage-aggregation | clean | `2fe007369a20` |
| usage-contracts-integration-offline | clean | `732b35f97573` |
| admin-connector-render | clean | `c377f7946719` |
| admin-connector-view-model | clean | `8ba45bc09be1` |
| bff-connectors-actions | clean | `99505654a0ab` |
| p745-connector-actions | clean | `f571865cbb57` |
| p745-connector-boot-composition | clean | `65895a5040f4` |
| p745-connector-management-proxy | clean | `1b32ec1c6c5f` |

## GAP

1. **Live-gated — KHÔNG chạy, KHÔNG tính là pass:** `migrations.test.ts`, `usage-summary.test.ts`, `artifact-grant-fencing.test.ts`, `artifacts-fencing-pg.test.ts` cùng toàn bộ `liveSuites` khác trong `jest.unit.config.cjs` (`admin-action-rbac-live`, `admin-audit`, `admin-base-routes`, `admin-error-boundary`, `admin-shell-live-pane`, `blob-wire-binary`, `ingress-bounded`, `operation-tenant-fence`, `runtime`, `webhook-reclaim-fence.live`, `workspace-reference`). 15 suite của lượt này **không** nằm trong danh sách gate ⇒ tất cả **thật sự đã chạy**.
2. **Không có bằng chứng live/deployment**: offline thuần (`jest.unit.config.cjs`), không PG/Redis/S3, **không claim DB window** ⇒ kết quả này không thay thế gate live/browser.
3. **Một lần chạy mỗi nhóm** (theo packet) ⇒ **không** có kết luận về flakiness; muốn khẳng định ổn định cần lặp nhiều tiến trình (các lượt trước đã lặp cho một số suite riêng lẻ: `usage-*`, connector 6 suite — đều trùng kết quả).
4. `f4-component-tenant-select.test.ts` là file **untracked** (`??`) — tồn tại trên đĩa và chạy xanh trong lượt này, nhưng **chưa được commit** nên không có "revision" để đối chiếu ngoài digest ghi ở trên.
5. Không có GAP về test bị bỏ qua: dòng `Tests:` của cả 4 lần chạy đều **không** có `skipped`.

## XÁC NHẬN

- **KHÔNG sửa gì**: không edit source/test/docs/config; artifact duy nhất của lượt này là receipt + raw log (14/15 file mục tiêu sạch vs HEAD, file thứ 15 là untracked có từ trước — digest không đổi sau khi chạy).
- **KHÔNG tick gate**, không viết VERIFIED/ACCEPTED; **KHÔNG commit/`git add`/push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.

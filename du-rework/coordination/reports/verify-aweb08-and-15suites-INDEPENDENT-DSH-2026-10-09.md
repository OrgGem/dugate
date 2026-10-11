# VERIFY ĐỘC LẬP (DSH) — aweb08-per-route-flag + 15 suite (tenant/usage/connector) cùng lúc — 2026-10-09

**Vai trò:** tester độc lập (không phải implementer). **Không sửa gì.**
**Ràng buộc đã tuân thủ:** `du-rework` only; KHÔNG sửa source/test/docs; KHÔNG commit / `git add` / push; **KHÔNG tick gate**; **OFFLINE** — không PostgreSQL/Redis, **không claim DB window**; không đọc `.env.live`.
**cwd:** `du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233`.
**Node:** lệnh bắt buộc chạy bằng `node` trong PATH = `C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe` (**v22.23.3**, đúng như câu lệnh packet viết `node …`). Bổ sung: chạy lại y hệt bằng node v24.21.0 (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`).
**Raw:** `du-rework/coordination/reports/raw/verify-aweb08-and-15suites-2026-10-09/DSH/` (`lenh1-16suite.log`, `sup1-16suite-node24.log`, `lenh2-tsc.log`, `SHA256SUMS.txt`).

## 1. LỆNH BẮT BUỘC — 16 suite trong **1 tiến trình**

```
cd du-rework/orchestrator/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb08-per-route-flag.test.ts \
  tenant-list-cursor-codec-offline tenant-list-bff-offline f5-bff-tenant-cursor-offline \
  f6-api-key-tenant-select-offline f2-overview-tenant-select-offline f4-component-tenant-select \
  usage-drilldown usage-aggregation usage-contracts-integration-offline \
  admin-connector-render admin-connector-view-model bff-connectors-actions \
  p745-connector-actions p745-connector-boot-composition p745-connector-management-proxy
```

**REAL_EXIT đo bằng `$LASTEXITCODE` NGAY sau lệnh (không pipe): `REAL_EXIT=0`** ✅ (kỳ vọng 0 — ĐẠT)

**Summary Jest (nguyên văn, đã bỏ ANSI/CRLF):**
```
Test Suites: 16 passed, 16 total
Tests:       222 passed, 222 total
Time:        7.686 s, estimated 16 s
```

**16/16 suite có dòng `PASS`** (danh sách đã sắp xếp; dòng của `f4-component-tenant-select` bị PowerShell chèn tiền tố stderr nên xuất hiện thêm một bản méo `PASS tests/f4-c...-select.test.ts:String) [], RemoteException` — **cùng một dòng PASS**, không phải suite thứ 17):
```
PASS tests/admin-connector-render.test.ts
PASS tests/admin-connector-view-model.test.ts
PASS tests/aweb08-per-route-flag.test.ts
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

**FAIL: KHÔNG CÓ** — `FAIL_BLOCK_COUNT=0` (không block `●`), không dòng `FAIL `, dòng `Tests:` không có thành phần `failed`/`skipped` ⇒ **không có suite nào bị bỏ qua ngầm**.

⇒ **aweb08 VÀ cả 15 suite XANH CÙNG LÚC trong một tiến trình duy nhất** — đúng mục tiêu cần xác minh.

## 2. Bằng chứng bổ sung (cùng 16 suite, node v24.21.0, 1 tiến trình)

```
Test Suites: 16 passed, 16 total
Tests:       222 passed, 222 total
Time:        4.933 s, estimated 8 s
REAL_EXIT=0
```
⇒ Con số **trùng khớp tuyệt đối** với lần chạy bằng node PATH (16/16 · 222/222 · exit 0) ⇒ kết quả không phụ thuộc runtime node trong phạm vi 2 bản đã thử.

## 3. Typecheck (bắt buộc #3)

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
**REAL_EXIT=0** ✅ (kỳ vọng 0 — ĐẠT) · `tsc_error_lines=0` (không output lỗi).

## 4. Bối cảnh fix được xác minh (đọc để ghi bằng chứng, không sửa)

- Hằng số mục tiêu nằm ở `src/app/admin/shell-server.ts:332`: `const DEFAULT_ADMIN_WEB_PATH = '/admin/web';` — dùng tại `:396` (`value === '' → { enabled: false, path: DEFAULT_ADMIN_WEB_PATH }`), `:399` (`{ enabled: true, path: DEFAULT_ADMIN_WEB_PATH }`), `:407` (`{ enabled: false, path: DEFAULT_ADMIN_WEB_PATH }`).
- File này đang **` M`** (thay đổi chưa commit, digest `525f8d08b99b56a1e7903647a49bf50df85098c8523321f477600cb452e50513`) ⇒ verification này gắn với **working tree**, không phải nội dung HEAD.
- `tests/aweb08-per-route-flag.test.ts` (file tồn tại, chạy xanh) gồm **8 test**: `absent env → unchanged behaviour (all routes + SPA fallback)`, `blank env → treated as absent (unrestricted)`, `partial allow-list → listed routes 200; others one consistent 404 with legacy link`, `unknown names are dropped; the rest of the list still applies`, `deliberately empty list (commas only) gates everything but the root`, `mount flag off → route absent (legacy 404 untouched)`, `DU_ADMIN_WEB_ROUTES present but DU_ADMIN_WEB off → still not mounted` (describe `AWEB-08-prep per-route rollout flag`).

## 5. GAP

1. **Live-gated — KHÔNG chạy, KHÔNG tính là pass:** `migrations.test.ts`, `usage-summary.test.ts`, `artifact-grant-fencing.test.ts`, `artifacts-fencing-pg.test.ts` và mọi `liveSuites` khác trong `jest.unit.config.cjs` (`admin-action-rbac-live`, `admin-audit`, `admin-base-routes`, `admin-error-boundary`, `admin-shell-live-pane`, `blob-wire-binary`, `ingress-bounded`, `operation-tenant-fence`, `runtime`, `webhook-reclaim-fence.live`, `workspace-reference`). 16 suite của lượt này **không** nằm trong danh sách gate.
2. **Không có bằng chứng live/browser/deployment**: offline thuần (`jest.unit.config.cjs`), không PG/Redis/S3, **không claim DB window**.
3. **Fix chưa được commit** (`shell-server.ts` ` M`, digest ở §4) ⇒ nếu file đổi tiếp, kết quả này không còn hiệu lực cho revision mới.
4. `tests/f4-component-tenant-select.test.ts` là file **untracked** (`??`) — xanh trong lượt này nhưng chưa vào git.
5. Chạy **1 lần bắt buộc + 1 lần bổ sung trên node v24** ⇒ chưa đủ để kết luận về flakiness dài hạn (hai lần đều trùng số).

## 6. XÁC NHẬN

- **KHÔNG sửa gì**: không edit source/test/docs/config; artifact duy nhất của lượt này là receipt + raw log (3 log + SHA256SUMS); digest các file mục tiêu không đổi sau khi chạy.
- **KHÔNG tick gate**, không viết VERIFIED/ACCEPTED (thuộc coordinator); **KHÔNG commit / `git add` / push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.

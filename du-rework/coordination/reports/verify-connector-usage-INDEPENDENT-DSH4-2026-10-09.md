# VERIFY ĐỘC LẬP LẦN 2 (lane DSH) — connector + usage + harness — 2026-10-09

**Vai trò:** verifier độc lập lần 2 (lane DSH). **Không sửa gì.**
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG edit source/test/config/docs; KHÔNG commit/`git add`/push; KHÔNG tick gate; KHÔNG đọc `.env.live`; **OFFLINE** (không PostgreSQL/Redis, **không claim DB window**); scope `du-rework`.
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · **node v24** = `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`, `-v` = **v24.21.0** · ambient `NODE_ENV=production` (jest pin lại trong tiến trình qua `tests/setup-node-env.cjs`).
**Cách đo:** mỗi lệnh **một tiến trình riêng**; `REAL_EXIT` lấy bằng `$LASTEXITCODE` **ngay sau** lệnh, **không pipe**; output ghi ra file bằng `*>`.
**Raw:** `du-rework/coordination/reports/raw/verify-connector-usage-2026-10-09/DSH4/` (`lenh1-connector.log`, `lenh2-usage.log`, `lenh3-usage-screen-harness.log`, `SHA256SUMS.txt`).

## 1. Bảng 3 lệnh × REAL_EXIT × literal

| # | Lệnh (node v24.21.0) | REAL_EXIT | `Test Suites:` | `Tests:` / output |
|---|---|---:|---|---|
| 1 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-connector-render.test.ts tests/admin-connector-view-model.test.ts tests/bff-connectors-actions.test.ts tests/p745-connector-actions.test.ts tests/p745-connector-boot-composition.test.ts tests/p745-connector-management-proxy.test.ts` | **0** | **`Test Suites: 6 passed, 6 total`** | **`Tests: 148 passed, 148 total`** |
| 2 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/usage-drilldown.test.ts tests/usage-aggregation.test.ts tests/usage-contracts-integration-offline.test.ts` | **0** | **`Test Suites: 3 passed, 3 total`** | **`Tests: 31 passed, 31 total`** |
| 3 | `& <node24> tests/usage-screen-offline.cjs` | **0** | — (harness `node`, không phải jest) | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |

**Đủ 10 file mục tiêu tồn tại** (kiểm `Test-Path` trước khi chạy: 9 `.test.ts` + 1 `.cjs` đều `True`), và **cả 6 suite của lệnh 1 đều có dòng `PASS` riêng** trong log:
```
PASS tests/p745-connector-boot-composition.test.ts
PASS tests/bff-connectors-actions.test.ts
PASS tests/p745-connector-actions.test.ts
PASS tests/admin-connector-view-model.test.ts
PASS tests/p745-connector-management-proxy.test.ts
PASS tests/admin-connector-render.test.ts
```
**Cả 3 suite của lệnh 2 đều có dòng `PASS` riêng:**
```
PASS tests/usage-drilldown.test.ts
PASS tests/usage-contracts-integration-offline.test.ts
PASS tests/usage-aggregation.test.ts
```

## 2. Kết luận từng nhóm

| Nhóm | Kết quả | Bằng chứng |
|---|---|---|
| **LỆNH 1 — connector (6 suite)** | **XANH** | exit 0 · `6 passed, 6 total` · `148 passed, 148 total` · 6/6 dòng PASS |
| **LỆNH 2 — usage (3 suite)** | **XANH** | exit 0 · `3 passed, 3 total` · `31 passed, 31 total` · 3/3 dòng PASS |
| **LỆNH 3 — usage harness `.cjs`** | **XANH** | exit 0 · 1 dòng `PASS:` (platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock) |

**Tổng: 9 suite + 1 harness, 179 test passed, 0 failed, 0 skipped, 3/3 lệnh exit 0.**

## 3. Danh sách test FAIL

**KHÔNG CÓ.** Không log nào chứa dòng `FAIL ` hoặc block `● ` (đã kiểm cả 2 log jest; kết quả rỗng). Không có test nào bị bỏ qua, không có suite nào bị skip trong 3 lệnh này (mọi dòng `Tests:` chỉ có `passed`).

## 4. Xác nhận

- **KHÔNG sửa gì**: không edit source/test/config/docs; **10/10 file mục tiêu sạch vs HEAD** (`git status --porcelain` cho cả 10 đường dẫn = **rỗng**); artifact duy nhất của lượt này là receipt + raw log.
- **KHÔNG tick gate** nào (VERIFIED/ACCEPTED/IMPLEMENTED đều của coordinator); **KHÔNG commit / `git add` / push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.
- **OFFLINE**: chỉ `jest.unit.config.cjs` + harness `node` thuần; **không** PostgreSQL/Redis/S3; **không claim DB window**; không chạy suite live nào.
- **Giới hạn:** mỗi lệnh chạy **một lần** (theo packet) ⇒ không có kết luận về flakiness; `tests/usage-screen-offline.cjs` là harness kiểm tra source/render offline (không render DOM thật, không browser); không đo được gì về hành vi live/deployment.

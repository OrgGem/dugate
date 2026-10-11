# SELF-VERIFY (coordinator leg) — tenant/usage + connector, 2026-10-08

**Vai trò:** coordinator, chạy lại bằng lệnh thật để kiểm chứng receipt của agent, KHÔNG tin báo cáo.
**Mode:** chỉ đọc + chạy test. Không edit source/test/docs. Không commit / `git add` / push. Không tick gate. Không đọc `.env.live`. **OFFLINE** (không PG/Redis, không claim DB window).
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233`.
**node:** `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` (v24.21.0) — node trên PATH của lane này là v22.16.0 nên phải gọi node tường minh.
**Cách đo:** `REAL_EXIT=$LASTEXITCODE` lấy ngay sau lệnh, không pipe; output ghi file rồi đọc tail có bóc ANSI/CRLF.

## 1. Kiểm chứng receipt `verify-tenant-usage-INDEPENDENT-CODEX3-2026-10-09.md`

| Nhóm | Claim của agent | Kết quả tôi tự chạy |
|---|---|---|
| tenant (6 suite) | 36 passed / 36 total · REAL_EXIT 0 | nằm trong lô chung bên dưới |
| usage (3 suite) | 31 passed / 31 total · REAL_EXIT 0 | nằm trong lô chung bên dưới |
| harness `.cjs` | PASS, REAL_EXIT 0 | không chạy lại (element-tree, không phải bằng chứng browser) |

**Lệnh:** 9 suite gộp một tiến trình:
`tenant-list-cursor-codec-offline`, `tenant-list-bff-offline`, `f5-bff-tenant-cursor-offline`, `f6-api-key-tenant-select-offline`, `f2-overview-tenant-select-offline`, `f4-component-tenant-select`, `usage-drilldown`, `usage-aggregation`, `usage-contracts-integration-offline`

**Raw:** `coordination/reports/raw/self-verify-tenant-usage-20261008-2317.log`

```
REAL_EXIT=0
Test Suites: 9 passed, 9 total
Tests:       67 passed, 67 total
Snapshots:   0 total
Time:        3.859 s
```

Đối chiếu số học: 67 = 36 (tenant) + 31 (usage) ⇒ **khớp đúng** receipt của Codex-3.

Spot check đơn lẻ: `tests/tenant-list-bff-offline.test.ts` → `Test Suites: 1 passed, 1 total` / `Tests: 3 passed, 3 total` / Time 2.301 s.

**Phán quyết: XANH — receipt đúng, không có phần thổi phóng.**

## 2. Kiểm chứng receipt `verify-connector-usage-INDEPENDENT-DSH4-2026-10-09.md`

**Lệnh (node v24.21.0):** 6 suite connector:
`admin-connector-render`, `admin-connector-view-model`, `bff-connectors-actions`, `p745-connector-actions`, `p745-connector-boot-composition`, `p745-connector-management-proxy`

**Raw:** `coordination/reports/raw/self-verify-connector-20261008-2320.log`

```
REAL_EXIT=0
Test Suites: 6 passed, 6 total
Tests:       148 passed, 148 total
Snapshots:   0 total
Time:        3.263 s
```

**Phán quyết: XANH — khớp receipt DSH4 (`6 passed` / `148 passed` / exit 0).** Phần usage 3 suite / 31 test của chính receipt đó đã nằm trong lô 67 ở mục 1 (cùng 3 file, cùng số) nên không chạy lại lần hai.

## 3. Trạng thái gate còn đỏ — KHÔNG tính là PASS

- `tests/artifact-read-authorization.test.ts`: **5 failed / 85 passed / 90 total, REAL_EXIT=1** (không chạy lại lượt này; hai leg độc lập DSH + QWEN đã tái lập cùng số, không flake). Gate **mở**. Bản sửa B (sửa test) **không được chọn** vì nó chốt ngầm cặp `409 + PERMISSION_DENIED` chưa ai duyệt; version C (sửa docs) an toàn hơn.

## 4. Không hành động gì khác

Không commit, không `git add`, không push, không sửa source/test/docs, không tick gate, không claim DB window, không đọc `.env.live`.
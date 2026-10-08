# WFA OpenAPI regen + tenants coverage — 2026-10-08

- **Scope:** `du-rework` only. Không commit, không push. `docs/21-openapi.json` chỉ do generator ghi (không hand-edit).
- **Bối cảnh:** F2 của review `wfa-docs-review-2026-10-08.md` → coordinator chọn hướng (a): **không** restore artifact cũ, mà bổ sung tenants coverage vào generator rồi regen.

## 1. Lệnh + kết quả (cwd `D:\Git\dugate\du-rework`, Node **v24.21.0** trên PATH)

| Command | Exit | Output chính |
|---|---:|---|
| `python tools/openapi/gen_openapi.py` | 0 | `NO-DROP paths=0 operations=0`; `path-count=61` (trước: 60), `schemas=53` (trước: 51), `dropped-paths=0` |
| `python tools/openapi/validate_openapi.py` | 0 | `paths=61 x-absent=9`, `WORKFLOW-FACADE-CONTRACTS-VALIDATED routes=2`, `SC-CB-CANONICAL-SCHEMAS-VALIDATED`, `OPENAPI-EXAMPLES-VALIDATED` |
- info version: **1.5.0** (giữ nguyên, không bump).
- Determinism: regen lần thứ 3 cùng `661703ed…` (2 lần liên tiếp sau patch → cùng hash).

## 2. Hash

| Mốc | SHA-256 |
|---|---|
| Trước regen (artifact lane WFA-DOCS) | `2bcab3997b76dfad28dcd4f986560f2f263c250f066fcf9a428c8b40530b4e1c` |
| Regen lần 1 (chưa có tenants; chỉ 4 dòng x-source) | `d516e8d491f31bba138dac850e8bbecf4325a45c806bbfe236d44442a145feb2` |
| **Mới (sau khi generator cover tenants)** | **`661703ed1251792b3f25a2de6da09d14b4c718a8f4be20644aee2b4b9459004e`** |

## 3. Diff `docs/21-openapi.json` (vs `2bcab399`) — 122 insertions, 4 deletions

- **+1 path** `/api/v1/admin/tenants` (GET): `x-source` = `admin.ts:413`, `x-api-family`/`tags` = `admin`, server = `localhost:3002`, security = `[{"AdminBearer":[]}]`, params = `limit`,`cursor`, responses = `200/401/403`.
- **+2 schema**: `AdminTenant` (`{id,name,state}` strict, uuid format trên id), `AdminTenantsPage` (5 field `items,nextCursor,prevCursor,total,limit`, strict, `items` → `$ref AdminTenant`).
- **4 dòng x-source** dịch theo `admin.ts` hiện tại: `:324→329`, `:543→585`, `:532→573`, `:570→612` (admin.ts vẫn tiếp tục nhận thay đổi từ lane khác → số dòng lớn hơn lần regen thứ nhất).
- Không thay đổi nào khác ngoài phần trên.

## 4. Sửa generator `tools/openapi/gen_openapi.py` (pure insertions, +123 dòng)

- `:168-174` — đọc `TENANT_LIST_QUERY_PARAMS` từ contract bằng `ts_list(_c, …)` + assert `== ["limit","cursor"]` (đúng pattern allow-list của operations list; single source of truth).
- `:496-522` — `TENANT_SCHEMA` + `TENANTS_PAGE_SCHEMA` dựng bằng `obj_schema(..., strict=True)`, khớp `AdminTenantSchema`/`AdminTenantsPageSchema` (`.strict()`) trong `packages/contracts/src/public-api.ts:627,636`.
- `:524-525` — đăng ký 2 schema vào `SCHEMAS`.
- `:863-875` — path definition theo đúng pattern guard `admin_source(…)` của 4 entry admin hiện có; guard literal `if (method === 'GET' && pathname === '/api/v1/admin/tenants')` khớp `http/routes/admin.ts:413` (trỏ đúng dòng route, đã verify trong output).
- `:1049` — assert `" /api/v1/admin/tenants" in after` ngay sau assert `admin audit surface missing` (theo pattern sẵn có);
- `:1122-1135` — guards trên file WRITTEN: params khớp `TENANT_LIST_QUERY_PARAMS`, 200 → `$ref AdminTenantsPage`, page → `$ref AdminTenant`, strict, item = đúng 3 field `{id,name,state}`.
- **Không** sửa `admin.ts`, **không** sửa contracts, **không** sửa `validate_openapi.py` (file ` M` của nó là thay đổi WFA-DOCS lane từ trước — workflow facade asserts, đã kiểm tra `git diff`, không thuộc scope này).

## 5. Docs cập nhật

| File:line | Thay đổi |
|---|---|
| `docs/28-test-inventory.md:2210` | hash `2BCAB399…` → `661703ED…`; `path-count` 60→61, `schemas` 51→53, `paths` 60→61; thêm câu "Cập nhật 2026-10-08: generator đã cover thêm `GET /api/v1/admin/tenants`…" |
| `docs/06-public-api.md:79` | "Generator 60 paths" → "61 paths" (T38 row, thêm "qua 2 lần regen") |
| `docs/19-traceability-audit-matrix.md:785` | "(60 paths, 0 drop)" → "(61 paths, 0 drop)" |
- Grep toàn `docs/` `2bcab399|d516e8d4` → 0 hit còn lại. Receipts lịch sử (`wfa-docs-2026-10-07.md:18`, `wfa-docs-review-2026-10-08.md:10`) mô tả theo thời điểm của run đó nên **không** chỉnh.
- `docs/19/28/35`: `docs/35` không trích hash/path-count → không sửa.

## 6. Ghi chú

- F2 trong `wfa-docs-review-2026-10-08.md` (regen lệch vì x-source drift) → **đã xử lý**: drift là thật, artifact cũ được thay bằng output generator mới nhất, và nguyên nhân gốc (generator thiếu tenants path) đã đóng.
- Tạo `tools/openapi/__pycache__/gen_openapi.cpython-313.pyc` bị đụng do lệnh `py_compile` kiểm tra cú pháp → đã `git checkout --` restore.
- Line ending `gen_openapi.py` (1011 CRLF / 66 LF hỗn hợp) giữ nguyên: patch byte-level qua Python, chỉ insert, LF-only vẫn = 66.
- Không commit, không push.
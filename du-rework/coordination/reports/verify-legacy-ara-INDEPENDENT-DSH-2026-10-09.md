# VERIFY ĐỘC LẬP (lane DSH) — legacy-http-mount + artifact-read-authorization — 2026-10-09

**Vai trò:** verifier độc lập (lane khác). **Không sửa gì.**
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG edit source/test/config/docs; KHÔNG commit/`git add`/push; KHÔNG tick gate; KHÔNG đọc `.env.live`; **OFFLINE** (không PostgreSQL/Redis, **không claim DB window**); scope `du-rework`.
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · **node** `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`, `-v` = **v24.21.0**.
**Cách đo:** mỗi lệnh **một tiến trình riêng**; `REAL_EXIT` lấy bằng `$LASTEXITCODE` **ngay sau** lệnh, **không pipe**; output ghi file bằng `*>`.
**Raw:** `du-rework/coordination/reports/raw/verify-legacy-ara-2026-10-09/DSH/` (`lenh1-legacy-http-mount.log`, `lenh2-artifact-read-authorization.log`, `SHA256SUMS.txt`).

## 1. Bảng 2 lệnh × REAL_EXIT × literal

| # | Lệnh (node v24.21.0) | Kỳ vọng packet | REAL_EXIT | `Test Suites:` literal | `Tests:` literal | Khớp kỳ vọng? |
|---|---|---:|---|---|---|---|
| 1 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-http-mount.test.ts` | `1 passed, 1 total` · `35 passed, 35 total` · exit 0 | **0** | **`Test Suites: 1 passed, 1 total`** | **`Tests: 35 passed, 35 total`** | **KHỚP** |
| 2 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts` | `1 failed, 1 total` · `5 failed, 85 passed, 90 total` · exit 1 | **1** | **`Test Suites: 1 failed, 1 total`** | **`Tests: 5 failed, 85 passed, 90 total`** | **KHỚP** |

Dòng `PASS` của lệnh 1 (nguyên văn trong log): `PASS tests/legacy-http-mount.test.ts`.

## 2. Kết luận từng suite

| Suite | Verdict | Bằng chứng |
|---|---|---|
| `tests/legacy-http-mount.test.ts` | **XANH** | exit 0 · `1 passed, 1 total` · `35 passed, 35 total` · không có `FAIL`/`●` |
| `tests/artifact-read-authorization.test.ts` | **ĐỎ (đúng như dự kiến)** | exit 1 · `1 failed, 1 total` · `5 failed, 85 passed, 90 total` · 5 block `●` |

## 3. Danh sách FAIL (nguyên văn tên + Expected/Received)

| # | Case | Expected → Received |
|---|---|---|
| 1 | `R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation` | `"code": "STATE_CONFLICT"` → **`"code": "PERMISSION_DENIED"`** |
| 2 | `R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant` | `"code": "PERMISSION_DENIED"` + `"status": 403` → **`"code": "LEASE_LOST"` + `"status": 409`** |
| 3 | `CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact` | `"code": "STATE_CONFLICT"` → **`"code": "PERMISSION_DENIED"`** |
| 4 | `CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong` | `"code": "PERMISSION_DENIED"` + `"status": 403` → **`"code": "LEASE_LOST"` + `"status": 409`** |
| 5 | `CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one` | `"code": "PERMISSION_DENIED"` + `"status": 403` → **`"code": "LEASE_LOST"` + `"status": 409`** |

Đây là **cùng 5 RED** đã được xác minh độc lập nhiều lượt trước đó (mismatch docs↔code, không phải flake): digest file test `3deb94faa3e78c039af9ffd1687e212efea5f354a2c92447bcbf12fcd1ca60b5` **không đổi** so với các lượt verify trước.

## 4. Ghi nhận thêm (không phải FAIL)

- `tests/legacy-http-mount.test.ts` hiện ở trạng thái **` M`** (modified, digest `4efe1219ba7f961ce2f0d7342a6e9ba2bf597ae5461c6f1741e868a28623a360`) và có **35 test** — tăng **+3** so với lượt tôi chạy trước đó (khi đó file sạch vs HEAD và cho `32 passed, 32 total`). Việc tăng số test **không** gây FAIL: vẫn `1 passed, 1 total` · `35 passed, 35 total` · exit 0.
- Không có suite nào bị skip trong 2 lệnh này (mọi dòng `Tests:` chỉ có `passed`/`failed`, không có `skipped`).

## 5. Xác nhận

- **KHÔNG sửa gì**: không edit source/test/config/docs; artifact duy nhất của lượt này là receipt + raw log; digest `tests/artifact-read-authorization.test.ts` **không đổi** sau khi chạy (`3deb94fa…`).
- **KHÔNG tick gate** nào (VERIFIED/ACCEPTED/IMPLEMENTED đều của coordinator); **KHÔNG commit / `git add` / push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.
- **OFFLINE**: chỉ `jest.unit.config.cjs`; **không** PostgreSQL/Redis/S3; **không claim DB window**; không chạy suite live nào.
- **Giới hạn:** mỗi suite chạy **một lần** theo packet ⇒ không có kết luận mới về flakiness (các lượt trước đã đo 2 tiến trình độc lập cho suite 2); không phân tích nguyên nhân mismatch docs↔code trong lượt này (đã có receipt điều tra riêng).

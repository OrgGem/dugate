# VERIFY ĐỘC LẬP (DSH) — đợt feature Admin Portal AP-01..AP-05 — 2026-10-09

**Vai trò:** tester độc lập (không phải implementer). **Không sửa gì.**
**Ràng buộc đã tuân thủ:** `du-rework` only; KHÔNG sửa source/test/docs; KHÔNG commit / `git add` / push; **KHÔNG tick gate**; **OFFLINE** (không PostgreSQL/Redis, không claim DB window); không đọc `.env.live`.
**HEAD:** `72e225ae5465e5a648c34bf31fbabbd182763233` · **node:** `C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe` = **v22.23.3**.
**Raw:** `du-rework/coordination/reports/raw/verify-ap01-to-ap05-2026-10-09/DSH/` (`buoc1-typecheck-admin-web.log`, `buoc1b-typecheck-admin-web-fallback.log`, `buoc2-build-admin-web.log`, `buoc3-aweb08.log`, `SHA256SUMS.txt`).

## BƯỚC 1 — typecheck `apps/admin-web`

**Lệnh packet (nguyên văn):** `cd du-rework/orchestrator/apps/admin-web` → `node ../../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

- **REAL_EXIT=1** — **KHÔNG phải lỗi type**, mà là **path không tồn tại**. Nguyên văn:
  ```
  Error: Cannot find module 'D:\Git\dugate\du-rework\node_modules\typescript\bin\tsc'
  ```
  (`Test-Path du-rework/orchestrator/node_modules/typescript/bin/tsc` = **False** — packet đã lường trước trường hợp này.)
- **Fallback đúng như packet chỉ định:** `node D:/Git/dugate/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (path này `Test-Path` = **True**)
  - **REAL_EXIT=0** ✅
  - **`type_error_lines=0`** — không có lỗi type nào.

## BƯỚC 2 — production build `@du/admin-web`

**Lệnh:** `cd du-rework` → `pnpm --filter @du/admin-web build`

- **REAL_EXIT=0** ✅
- Log (nguyên văn, đã bỏ ANSI):
  ```
  > @du/admin-web@0.0.0 build D:\Git\dugate\du-rework\orchestrator\apps\admin-web
  > tsc --noEmit -p tsconfig.json && vite build
  vite v6.4.3 building for production...
  ✓ 2692 modules transformed.
  dist/index.html                   0.47 kB │ gzip:   0.29 kB
  dist/assets/index-B1YUmtvj.css   47.25 kB │ gzip:   9.28 kB
  dist/assets/index-DYaO4iP7.js   949.84 kB │ gzip: 237.45 kB
  ✓ built in 9.85s
  ```
- **`dist/index.html` tồn tại** ✅ — `D:\Git\dugate\du-rework\orchestrator\apps\admin-web\dist\index.html`, 470 B, mtime `2026-10-09 01:16:30`; `dist` có **3 file** (`index.html`, `assets/index-B1YUmtvj.css`, `assets/index-DYaO4iP7.js`).
- Ghi nhận: script build **tự chạy `tsc --noEmit` trước `vite build`** ⇒ typecheck cũng đã pass bên trong build (bằng chứng cộng thêm cho bước 1).
- **Warning không chặn build** (không phải lỗi): `WARN Unsupported engine: wanted {"node":">=24.21.0 <25"} (current v22.23.3)` · `(!) "base" option should start with a slash` · `(!) Some chunks are larger than 500 kB after minification`.
- `apps/admin-web/dist` **không tạo entry git** (status rỗng ⇒ được ignore) ⇒ build không làm bẩn cây.

## BƯỚC 3 — regression suite orchestrator

**Lệnh:** `cd du-rework/orchestrator/services/orchestrator` → `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb08-per-route-flag.test.ts`

- **REAL_EXIT=0** ✅
- Literal:
  ```
  PASS tests/aweb08-per-route-flag.test.ts
  Test Suites: 1 passed, 1 total
  Tests:       7 passed, 7 total
  Time:        2.948 s
  ```
- **7/7 test xanh** (đúng kỳ vọng packet), tên nguyên văn:
  ```
  √ absent env → unchanged behaviour (all routes + SPA fallback)
  √ blank env → treated as absent (unrestricted)
  √ partial allow-list → listed routes 200; others one consistent 404 with legacy link
  √ unknown names are dropped; the rest of the list still applies
  √ deliberately empty list (commas only) gates everything but the root
  √ mount flag off → route absent (legacy 404 untouched)
  √ DU_ADMIN_WEB_ROUTES present but DU_ADMIN_WEB off → still not mounted
  ```

## ĐÁNH GIÁ KẾT QUẢ

| Bước | Kỳ vọng | Thực tế | Kết luận |
|---|---|---|---|
| 1. typecheck admin-web | exit 0, không lỗi type | lệnh path-tương-đối của packet **fail vì thiếu module** (exit 1, không lỗi type); **fallback tsc gốc repo: exit 0, 0 lỗi** | ✅ **ĐẠT** (qua fallback đúng như packet quy định) |
| 2. production build | exit 0 + `dist/index.html` | **exit 0**, `2692 modules transformed`, `dist/index.html` 470 B + 2 asset, `built in 9.85s` | ✅ **ĐẠT** |
| 3. aweb08 regression | exit 0 + `7 passed, 7 total` | **exit 0** · `1 passed, 1 total` · `7 passed, 7 total` | ✅ **ĐẠT** |

⇒ **Toàn bộ 3 cổng xác minh của đợt AP-01..AP-05 đều ĐẠT trên cây hiện tại.** Không phát hiện regression ở suite `aweb08-per-route-flag`; app admin-web typecheck sạch và build production ra artifact hợp lệ.
*(Tham chiếu ngoài phạm vi lượt này — không tính vào 3 bước trên: lượt verify trước đó chạy gộp `aweb08 + 15 suite tenant/usage/connector` = `16 passed, 16 total` · `222 passed, 222 total` · exit 0, và lặp lại y hệt trên node v24.21.0; receipt `verify-aweb08-and-15suites-INDEPENDENT-DSH-2026-10-09.md`.)*

## GAP

1. **Code đợt AP-01..AP-05 chưa commit**: `apps/admin-web/src/**` có **nhiều file ` M`** (app-shell, api-docs, api-keys, businesses, connectors, operations, overview, profiles, secrets, security…) ⇒ kết quả này gắn với **working tree**, không phải một revision đã chốt.
2. **Đường dẫn `tsc` trong packet không tồn tại** ở repo này (`du-rework/orchestrator/node_modules/typescript/bin/tsc` = False) — nên mọi lượt sau cần dùng fallback `D:/Git/dugate/node_modules/typescript/bin/tsc`; đây là **lệch tài liệu/lệnh**, không phải lỗi code.
3. **Không có bằng chứng browser/live**: không chạy Playwright/DOM thật, không chạy orchestrator server, không PostgreSQL/Redis — **không claim DB window**; build production không chứng minh hành vi runtime trong browser.
4. **Warning engine**: pnpm cảnh báo Node v22.23.3 < yêu cầu `>=24.21.0 <25` (repo pin `.node-version`/`.nvmrc` = 24.21.0). Build vẫn xanh nhưng đây là khác biệt môi trường cần biết.
5. Không kiểm tra `dist/` byte-for-byte so với lần build trước (không có baseline build cũ để so).

## XÁC NHẬN

- **KHÔNG sửa source/test/docs**: chỉ chạy 3 lệnh; thao tác ghi duy nhất ngoài receipt/raw là **output build** vào `apps/admin-web/dist` (được git ignore, không tạo entry trong `git status`).
- **KHÔNG tick gate** (không viết VERIFIED/ACCEPTED — thuộc coordinator); **KHÔNG commit / `git add` / push**; không chạm `docs/21-openapi.json`; **KHÔNG đọc `.env.live`**.

# AP-04 receipt — Workflows unblock guidance banner (2026-10-09)

- **Task:** `AP-04-WORKFLOWS-UNBLOCK-GUIDANCE-2026-10-09` · **Plan:** `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md:90` (AP-04, APPROVED, owner trong plan: display guidance cho banner Δ-DEV-03).
- **Path lease (duy nhất được ghi):** `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx`
- **Mode:** display guidance only — không sửa data, không sửa backend, không enable route workflows.

## 1. Thay đổi (file trong lease)

`git diff --numstat` → **27 insertions, 0 deletions** (pure append, không dòng nào bị xoá).

Banner `AlertBanner variant="warning" title="Workflows route is disabled"` (đoạn cũ giữ nguyên, thêm một danh sách điều kiện ngay dưới nó trong cùng `<ul>`) giờ liệt kê **5 điều kiện operator cần biết trước khi mở khóa**, mỗi điều kiện kèm nơi kiểm chứng:

| # | Hướng dẫn hiển thị | Bằng chứng đã đối chiếu (file:line) |
|---|---|---|
| 1 | **Deployment gate — owner: deployment owner (quyết định của user).** Δ-DEV-03 giữ route `/admin/workflows` user-gated nên màn hình tự nó không bật được. | `coordination/dispatch-specs/2026-10-05-0305-WAVE-801.md:121` (route disabled with an honest reason); `coordination/coordinator-state.json:1732` (Delta-DEV-03 route /admin/workflows — user-gated) |
| 2 | **Rollout allow-list:** khi đặt `DU_ADMIN_WEB_ROUTES` thì phải có tên `workflows` — và tên này **chưa nằm trong** `ADMIN_WEB_ROUTE_NAMES`, nên hiện tại nó bị bỏ qua kèm warning và route vẫn trả 404 document. | `src/app/admin/shell-server.ts:426-447` (`parseAdminWebRoutes`, unknown bị drop + `:446` warning); `:335-352` (danh sách `overview, profiles, api-docs, api-keys, connectors, operations, businesses, usage, security, secrets, identity, settings` — **không** có `workflows`); `:630-644` (gate trả 404 document) |
| 3 | **Workflow schema catalog:** migration `0037_legacy_workflow_schema_catalog.sql` phải được apply để bảng catalog và index one-active-revision tồn tại. | file tồn tại: `orchestrator/services/orchestrator/migrations/0037_legacy_workflow_schema_catalog.sql` (`:12` PK, `:15` unique index) |
| 4 | **Encryption key / Vault Transit:** seam metadata-crypto phải dựng trên provider ENC-02 Vault Transit và compose lúc boot; nếu thiếu thì admission schema workflow fail-closed với `SCHEMA_CRYPTO_UNAVAILABLE` (503, "Workflow schema storage is temporarily unavailable"). | `src/modules/runtime/metadata-crypto.ts:15` (Vault Transit provider), `:88` (wrapped DEK theo ENC-02), `:280` (build seam trên ENC-02 Vault Transit provider); `src/compat/legacy-http-mount.ts:445-448` (`SCHEMA_CRYPTO_UNAVAILABLE` → 503 text cố định) |
| 5 | **Runtime readiness:** facade admission + schema pin đã implement nhưng named process chains và nhiều node adapter chưa có evidence acceptance runtime → xem WFA plan trước khi hứa end-to-end. | `coordination/reports/wfa-verification-2026-10-07.md:105` ("WFA-T01..03, WFA-T15..24 ... T25..28 remain open. No full WFA-T01..38 acceptance claim is made.") |

Không có import mới, không có state mới, không có fetch/API call nào — chỉ chữ trong JSX. Card bên dưới giữ nguyên.

## 2. Build check

**Lệnh trong đề bài KHÔNG chạy được trên workspace này** (ghi để không ai tin nhầm):

```
node ..\..\..\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
Error: Cannot find module D:\Git\dugate\du-rework\node_modules\typescript\bin\tsc
```

Nguyên nhân: layout pnpm — gói typescript nằm ở store `.pnpm`, không hoisted về `node_modules/typescript`. (Lưu ý bẫy ghi exit: chuỗi `& echo TSC_EXIT=%ERRORLEVEL%` in ra `0` là giá trị parse-time **giả**, nên tôi không dùng nó làm bằng chứng.)

**Chạy lại bằng path thật (tsc 5.9.3, cwd `orchestrator/apps/admin-web`):**

```
"%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe" "D:\Git\dugate\du-rework\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.json
(stdout/stderr rỗng — không có diagnostic)
REAL_EXIT: 0
```

**Kết luận build: PASS — typecheck sạch, exit 0.**

## 3. Xác nhận ranh giới

- **Không** `git commit`, **không** `git add`, **không** `git push`.
- **Chỉ 1 file được ghi:** `workflows-screen.tsx` (+27/-0). Không chạm file nào ngoài lease.
- **Không sửa backend:** `shell-server.ts`, `legacy-http-mount.ts`, `metadata-crypto.ts`, migration — chỉ **đọc** để đối chiếu bằng chứng. (`shell-server.ts` đang ` M` trong tree là của lane khác, tôi không có thao tác ghi nào lên nó.)
- **Không enable route workflows:** `DU_ADMIN_WEB_ROUTES` không được đặt, `ADMIN_WEB_ROUTE_NAMES` không được sửa, `router.tsx` không được sửa. Hướng dẫn ở mục 2 chỉ là chữ hiển thị nhắc operator.
- Các file ` M` / `??` khác trong `apps/admin-web/src` (global-tenant-selector, toast, tenant-context, các screen khác) là work của lane khác trong plan này — tôi không đụng vào.
- Ngoài receipt này, không file nào khác được tạo.
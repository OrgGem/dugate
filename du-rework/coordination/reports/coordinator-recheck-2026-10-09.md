# COORDINATOR RECHECK 2026-10-09 — đính chính hồ sơ verify + ghi nhận regression mới

**Vai trò:** coordinator (Claude Code, single dispatcher). OFFLINE. Không commit/push/`git add`/checkout. Không tick gate. Không đọc `.env.live`.
**Phạm vi:** du-rework only. Tài liệu này là coordination metadata, không đụng product/test.

## 1. ĐÍNH CHÍNH — hai receipt CODEX4/DSH5 KHÔNG bị phủ nhận; chúng ĐÚNG

Lượt trước coordinator đo được `22 failed / 193 passed / exit 1` trên leg 15-suite và kết luận sai rằng
`verify-tenant-usage-connector-INDEPENDENT-CODEX4-2026-10-09.md` và
`verify-tenant-usage-connector-INDEPENDENT-DSH5-2026-10-09.md` là sai sự thật.

**Kết luận đính chính: cả hai receipt ĐÚNG, đã được coordinator tái lập độc lập 2 lần.**

| Lần chạy | cwd | Kết quả | Exit |
|---|---|---|---|
| Subset 3 suite | `du-rework/orchestrator/services/orchestrator` | `Test Suites: 3 passed, 3 total` / `Tests: 22 passed, 22 total` | `REAL_EXIT=0` |
| Toàn bộ 15 suite | cùng cwd | `Test Suites: 15 passed, 15 total` / `Tests: 215 passed, 215 total` | `REAL_EXIT=0` |

Số liệu `215 = 36 (tenant) + 31 (usage) + 148 (connector)` khớp nguyên văn receipt DSH5; tổng 215/215 khớp receipt CODEX4.
Raw log: `coordination/reports/raw/coordinator-recheck-20261009/` (`recheck3.log`, `recheck15.log`).

**Nguyên nhân sai lệch đo:** file đích đang ở trạng thái trung gian hỏng, không phải receipt sai.

| Mốc | Sự kiện |
|---|---|
| 2026-10-08 23:36:47 | edit chưa commit #1 vào `shell-server.ts`: `DEFAULT_ADMIN_WEB_PATH` đổi `'/admin/web'` → `'admin'` (normalize thành `/admin`), nhưng thứ tự dispatch vẫn để admin-web check TRƯỚC BFF check ⇒ mount `/admin` che các route `/admin/api/*` ⇒ nhiều suite tenant/usage/connector đỏ. |
| (giai đoạn đo 22-fail) | coordinator chạy đúng lúc này, đo đỏ, quy sai nguyên nhân. |
| 2026-10-09 00:10:34 | edit chưa commit #2 vào `shell-server.ts`: BFF check đưa LÊN TRƯỚC + thêm guard `isBffPath()` trong `isAdminWebPath()` ⇒ 15-suite leg xanh trở lại. |

Cả hai edit đều **chưa commit**, `git diff` hiện còn `14 insertions / 11 deletions` trên `src/app/admin/shell-server.ts`.
Không có receipt nào cho edit 00:10:34 — đây là khoảng trống hồ sơ, được ghi lại ở đây.

## 2. REGRESSION MỚI — `aweb08-per-route-flag.test.ts` ĐANG ĐỎ

**Tái lập độc lập (coordinator, cùng cwd, Node v24.21.0):**

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb08-per-route-flag.test.ts
=> REAL_EXIT=1
   Test Suites: 1 failed, 1 total
   Tests:       3 failed, 4 passed, 7 total
```

3 case đỏ (tất cả đều là `/admin/web/*` trả 404 thay vì 200):

1. `partial allow-list → listed routes 200; others one consistent 404 with legacy link` — `tests/aweb08-per-route-flag.test.ts:120`
2. `unknown names are dropped; the rest of the list still applies` — `:145`
3. `deliberately empty list (commas only) gates everything but the root` — `:157`

**Root cause:** `src/app/admin/shell-server.ts:332` đang là
`const DEFAULT_ADMIN_WEB_PATH = 'admin';`
`normalizeAdminWebPath` (:387-392) tự thêm dấu `/` ở đầu ⇒ mount path là `/admin`, nên các request
`/admin/web`, `/admin/web/overview`, `/admin/web/security`, `/admin/web/profiles` trong suite không còn match mount.
Suite inject `adminWeb: { distDir: DIST }` không kèm `path` (`:80`) nên phụ thuộc DEFAULT.

**Hệ quả trạng thái hiện tại:** edit 00:10:34 sửa được leg 15-suite nhưng để lại DEFAULT sai, làm hỏng suite admin-web.
Hai mục tiêu này **độc lập với nhau**: sửa shadowing BFF không cần đổi DEFAULT.

**Đề xuất (chưa thực hiện — coordinator không tự sửa product):**

1. Khôi phục `DEFAULT_ADMIN_WEB_PATH = '/admin/web'` tại `shell-server.ts:332` (+ comment liên quan nếu có).
2. **Giữ nguyên** phần sửa 00:10:34: BFF check đứng trước trong handler + `isBffPath()` guard trong `isAdminWebPath()`.
3. Verify: chạy lại `tests/aweb08-per-route-flag.test.ts` **và** leg 15-suite, cả hai phải xanh cùng lúc.
4. Người thực hiện phải **fail-first**: chạy `aweb08-per-route-flag` RED trước khi sửa, ghi `REAL_EXIT` thật.

Lưu ý: `f4-component-tenant-select.test.ts` là file untracked (`??`) — không có revision để đối chiếu ngoài digest đã ghi trong receipt DSH5.

## 3. Gate live — không đổi

Các suite live-gated vẫn **không tính PASS offline**: `migrations.test.ts`, `usage-summary.test.ts`,
`artifact-grant-fencing.test.ts`, `artifacts-fencing-pg` và toàn bộ `liveSuites` trong `jest.unit.config.cjs`
(`admin-action-rbac-live`, `admin-audit`, `admin-base-routes`, `admin-error-boundary`, `admin-shell-live-pane`,
`blob-wire-binary`, `ingress-bounded`, `operation-tenant-fence`, `runtime`, `webhook-reclaim-fence.live`,
`workspace-reference`).

## 4. Không hành động

Không commit, không `git add`, không push, không `git checkout`, không tick gate, không đọc `.env.live`,
không sửa source/test. File này là receipt metadata.
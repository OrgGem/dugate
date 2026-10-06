# Dispatch spec — AWEB-01b browser evidence (2026-10-04 11:53 +07)

## Mục tiêu

Tạo **browser-level evidence** cho shell Admin Web đã mount (`/admin/web`, flag `DU_ADMIN_WEB`) — độc lập với verify HTTP của cc_2 trước đó; dựng harness để tái sử dụng cho các slice sau (AWEB-03b/04 cần browser evidence theo contract §5/§6.4).

## Việc cần làm

1. **Harness**: khởi động `createAdminShellServer` từ source (port 0, `NODE_ENV=test`) + mint cookie test-mode (seam đã dùng ở `aweb01-verify`); Playwright chạy trực tiếp với `npx playwright test` (KHÔNG dùng lệnh false-green `pnpm --filter @du/browser-tests test` — package không có script `test`).
2. **Spec tối thiểu** (đặt dưới `du-rework/tests/browser/admin-web/**`):
   - direct URL unauth `/admin/web` → trang login (302 → form);
   - login → app React render (root node, title, không lỗi console nghiêm trọng);
   - reload → session giữ, app render lại;
   - viewport 320px → không tràn ngang (assert `scrollWidth <= clientWidth + 1`), nav truy cập được;
   - keyboard: Tab đi được vào control chính, focus hiển thị;
   - theme: light + dark (`data-theme`) render.
3. **Evidence**: screenshot PNG cho các case chính → `du-rework/coordination/evidence/aweb01b/` (đặt tên rõ case/viewport); ghi literal output `npx playwright test` (số test chạy thực tế, pass/fail).
4. Ghi rõ giới hạn (ví dụ: chạy local server seam, không phải live stack).

## Lease

- **Được ghi:** `du-rework/tests/browser/admin-web/**` (file mới), `du-rework/coordination/evidence/aweb01b/**`, receipt.
- **KHÔNG sửa:** `apps/admin-web/src/**` (integrator/Antigravity đang giữ), orchestrator `src/**`, `tasks/**`, `docs/**`; không commit; không đụng container user.
- Nếu cần helper tạm ngoài `tests/browser` → chỉ trong `.cache/`, xoá sau khi chạy.

## Deliverable

- Receipt: `coordination/reports/aweb01b-browser-evidence-2026-10-04.md` — commands literal, bảng test case pass/fail, đường dẫn screenshot, giới hạn.

## Lane

- **cc_2** — `term_5f7e42da-6790-4449-8539-746626c5d078`. Dispatch 2026-10-04 11:53.

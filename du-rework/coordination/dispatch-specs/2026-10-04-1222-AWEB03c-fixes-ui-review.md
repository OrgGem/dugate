# Dispatch spec — AWEB-03c component findings fix + UI review verdict (2026-10-04 12:22 +07)

## Phần 1 — Fix findings trên components (lease Antigravity)

Từ review độc lập của integrator (`reports/aweb03b-overview-graft-2026-10-04.md` §1) — sửa trong `apps/admin-web/src/components/ui/**` + `src/app-shell/**`:

| # | Mức | Việc |
|---|---|---|
| F1 | minor | `button.tsx:47` `text-white` → dùng token (`--primary-foreground`/`--on-action`) |
| F2 | minor | `table.tsx:10` `shadow-xs` → thống nhất `--shadow-card` |
| F3 | minor a11y | `field.tsx:113-121` FormField: wire `aria-describedby`/`aria-errormessage` thật HOẶC sửa README (chọn cách đúng semantics, ghi rõ) |
| F4 | minor | barrel `index.ts` export cả `./demo`+`./fixtures` → tách production barrel vs demo (giữ subpath imports của integrator hoạt động; integrator đã đo −107 kB) |
| F6 | info | `app-shell.tsx:12` nav/footer nhãn "Bootstrap" → cập nhật theo Overview (route `/overview`); giữ link hiện có của integrator |
| F5 | info | Không sửa code; ghi quy ước callers truyền code/đã-bounded (README) |

Sau fix: build + typecheck xanh; nếu đổi props/export nào ảnh hưởng integrator → ghi rõ trong receipt (không tự sửa file integrator).

## Phần 2 — UI review packet cho route `/admin/web` + `/admin/web/overview` (contract §5)

- Chạy trên **build mới nhất** (sau fixes, `pnpm --filter @du/admin-web build`); có thể chạy lại browser suite hiện có (read-only) làm evidence: harness `tests/browser/admin-web/**` (cc_2/cc_1 mở rộng) — `npx playwright test --config admin-web/playwright.config.ts`.
- Đối chiếu theo contract §5: screen spec (route/role/tenant/state), hành trình, lỗi 401/403/409/422, loading/empty/denied/conflict, responsive 320px, keyboard/focus, a11y, light/dark, nhất quán token/component; review trên route/browser + diff source (không duyệt bằng demo component riêng lẻ).
- Nguồn evidence: `coordination/evidence/aweb03b/**` (15 ảnh) + chạy lại tùy nghi; ghi rõ build hash dùng để review.
- **Verdict bắt buộc**: `UI_APPROVED` hoặc `CHANGES_REQUIRED` cho từng route/build, kèm finding cụ thể (task ID, file:line hoặc URL/state, expected/actual, evidence). Không tự duyệt source component của mình (đã có integrator review riêng); verdict này là về màn tích hợp.

## Lease

- **Sở hữu:** `apps/admin-web/src/components/ui/**`, `src/styles/**`, `src/app-shell/**`, fixture/demo; đọc tự do phần còn lại.
- **KHÔNG sửa:** `src/lib/api/**`, `src/routes/**`, `src/features/**` (integrator), orchestrator, `tests/**` (chỉ chạy), `tasks/**`, `docs/**`; không commit; không đụng container user.

## Deliverable

- Receipt: `coordination/reports/aweb03c-fixes-and-ui-review-2026-10-04.md` — bảng fix + verdict UI (`UI_APPROVED`/`CHANGES_REQUIRED`) + findings + build hash/commands literal.

## Lane

- **antigravity_1** — `term_38afaa0e-081f-4e32-91b2-25459d048b0e`. Dispatch 2026-10-04 12:22.

# Dispatch spec — AWEB-01 Admin Web bootstrap (2026-10-04 11:15 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-01**.
- Contract: `docs/admin-ui-development-contract.md` (§1 kiến trúc, §2 lease, §3 tokens/component, §6 trình tự ghép).
- Inventory: `coordination/reports/aweb00-admin-inventory-2026-10-04.md` (§4 tokens, §5 port).
- **Giữa điều phối (coordinator defaults — user có thể đổi):** Q5 = "viết lại toàn bộ" (theo AWEB-00 §5); Q3 = Inter; Q2 = giữ `--cf-*` hiện tại (`--cf-blue` cho action, không đổi brand); Q4 = theo cơ chế rework (media-query) trong AWEB-01, quyết định theme-toggle để sau; Q10 = cơ chế flag server-side per-route (mặc định tắt, legacy nguyên trạng); Q11 = lane này giữ lease `pnpm-workspace.yaml` + lockfile trong lúc bootstrap.

## Việc cần làm (AWEB-01)

1. Bootstrap `du-rework/apps/admin-web` — **React + TypeScript strict + Vite + React Router Data Mode**; Tailwind + CSS variables + shadcn/ui (một primitive base duy nhất — mặc định Base UI); shell/navigation/theme tối thiểu; build static.
2. Thêm `apps/*` vào `pnpm-workspace.yaml`; cài dependencies; chạy shadcn CLI có review diff (dependency/alias/global CSS) — không `add --all`.
3. Token: một nguồn `src/styles/` map theo contract §3 (đối chiếu `--cf-*` trong `shell-render.ts:500+`; bảng map ở AWEB-00 §4). Không tạo bộ token thứ hai.
4. Mount **một route thử** (read-only, sau session gate hiện có) + flag server-side per-route (mặc định tắt, route legacy nguyên trạng); đảm bảo direct URL/reload/login/logout chạy.
5. Assets versioned + kiểm CSP/cache policy; ghi rõ cách serve static từ Orchestrator (dev-live + production build).

## Lease (một writer tại một thời điểm)

- **Sở hữu:** `du-rework/apps/admin-web/**`, `du-rework/pnpm-workspace.yaml`, `du-rework/pnpm-lock.yaml`.
- **Được phép sửa cho mount:** `services/orchestrator/src/app/admin/shell-router.ts`, `shell-server.ts`, `main.ts` (single-writer trong lúc packet chạy; ghi rõ từng dòng đã chạm vào receipt).
- **KHÔNG sửa:** `services/orchestrator/src/server.ts` (nếu buộc phải chạm → DỪNG, báo coordinator), `packages/contracts/**`, `tasks/**`, `docs/**`, file của lane khác (Claude đang giữ `modules/**`; Antigravity giữ `apps/admin-web/src/components/ui/**` — trong AWEB-01 lane này chỉ tạo skeleton thư mục, KHÔNG viết primitives; primitives thuộc AWEB-03/Antigravity).
- Không chạy đồng thời shadcn CLI với lane khác; không `git commit`; không restart container của user.

## Acceptance (theo plan)

- Direct URL/reload/login/logout chạy trên route thử; assets versioned; CSP/cache policy được kiểm; **legacy route còn truy cập được qua flag**.
- `pnpm --filter <admin-web> build` + typecheck xanh; shadcn diff đã review; không đưa auth/tenant/Profile policy vào primitives.

## Deliverable

- Receipt: `coordination/reports/aweb01-admin-web-bootstrap-2026-10-04.md` — commands + literal output (build/typecheck), cấu trúc app, cơ chế flag, file đã chạm (file:line), blockers, next.

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978` — vai **Admin UI integrator** (bootstrap + app shell + route rollout). Dispatch 2026-10-04 11:15.

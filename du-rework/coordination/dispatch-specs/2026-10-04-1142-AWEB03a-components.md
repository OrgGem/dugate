# Dispatch spec — AWEB-03a Component foundation (2026-10-04 11:42 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-03** (phần component chung của Antigravity; phần ghép Overview của integrator sẽ dispatch riêng sau AWEB-02).
- Contract: `docs/admin-ui-development-contract.md` §2 (lease), §3 (component + token), §5 (review), §6.1-6.2 (trình tự ghép).
- AWEB-00 §4/§5 (đề xuất tokens + port) + AWEB-01 (app đã bootstrap; `src/styles/tokens.css` mirror `shell-render.ts:500,503-504`; `components/ui/` skeleton README).

## Việc cần làm (AWEB-03a — component foundation)

1. **Tokens**: chốt `apps/admin-web/src/styles/**` — một nguồn duy nhất (đã có `tokens.css` + map shadcn semantic → `--cf-*`); bổ sung biến cần cho status/focus/typography nếu thiếu. Q mặc định: Q2 `--cf-blue` action, Q3 Inter, Q4 media-query — user có thể đổi.
2. **Primitives (Base UI + shadcn style hiện có)**: AppShell primitives (header/nav/layout), Field/Input/Select, Button, Dialog, Table, Status/Empty/Error, loading/disabled states.
   - Props/callback **thuần** — không fetch, không cookie, không biết URL API/role/tenant.
   - A11y: label + `aria-describedby`/`aria-invalid`, focus-visible, bàn phím (Dialog focus-trap + trả focus; Tabs roving tabindex), reflow 320 CSS px.
3. **Fixture/demo** cho từng component: light/dark, dữ liệu dài, empty/error/loading.
4. **Dir skeleton**: giữ `src/components/ui/` là write-set của lane; cập nhật README skeleton → mô tả API props.

## Lease

- **Sở hữu:** `apps/admin-web/src/components/ui/**`, `apps/admin-web/src/styles/**`, `apps/admin-web/src/app-shell/**`, fixture/demo component.
- **KHÔNG sửa:** `apps/admin-web/src/lib/api/**`, `src/routes/**`, orchestrator (`shell-server.ts`…) — đang thuộc AWEB-02 (cc_1); `tasks/**`, `docs/**`; không shutdown/restart container user.
- Không chạy shadcn CLI đồng thời với lane khác; nếu cần `add` primitive → chốt lease trong receipt.

## Acceptance

- Demo đủ state (light/dark, 320px, dữ liệu dài); keyboard/focus chạy; props thuần; typecheck + build app xanh (chạy `pnpm --filter @du/admin-web` — không sửa file ngoài lease nếu build đỏ do lane khác, ghi rõ).

## Review path

- Integrator (cc_1) review độc lập diff source component trước khi ghép; Antigravity **không tự duyệt** patch của mình. Sau khi graft Overview (AWEB-03b) có build + browser evidence, coordinator gọi Antigravity review **màn tích hợp**.

## Deliverable

- Receipt: `coordination/reports/aweb03a-components-2026-10-04.md` (danh sách component + props contract, fixture, commands literal, blockers).

## Lane

- **antigravity_1** — `term_38afaa0e-081f-4e32-91b2-25459d048b0e` (component chung + reviewer UI). Dispatch 2026-10-04 11:42.

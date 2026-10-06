# Dispatch spec — AWEB-00 Admin inventory (2026-10-04 11:05 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` (AWEB-00..08; mục 2 ownership, mục 3 bảng slice + acceptance, mục 4 gói bàn giao, mục 5 quyết định còn lại).
- Contract UI: `docs/admin-ui-development-contract.md`.
- Input phụ: ACUI-00..10 (`tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md`), ORCH-PAR (`tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md`), ADM-UX, LOCAL/OIDC.
- Code hiện tại: `services/orchestrator/src/app/admin/**` (renderer HTML hiện hành), `shell-router.ts`, `shell-server.ts`.
- Snapshot Profile: `coordination/reports/profile-parity-analysis-2026-10-04.md` (Claude, 10:39 — còn cập nhật, chỉ tham chiếu).

## Việc cần làm (AWEB-00 — CHỈ ĐỌC)

1. Inventory màn `/admin/*`: URL/query, role/action (từ shell-router/rbac), endpoint hiện trạng (đã nối thật / placeholder / thiếu), fixture hiện có; **phân loại từng màn**: `legacy working` | `scaffold` | `backend missing` | `UI missing`.
2. Ma trận **route → DTO → action → owner (ACUI/PAR/P6/LOCAL ID) → test** (file/suite hiện có hoặc cần thêm).
3. Đề xuất **visual tokens + đường port component legacy**: từng component legacy đối chiếu props/Tailwind tokens/dependency/a11y/license — chỉ đề xuất `port | viết lại | bỏ`, KHÔNG copy code.
4. Liệt kê **open questions** cần user/coordinator chốt (AWEB plan mục 5) — không tự quyết.

## Deliverable

- Receipt: `du-rework/coordination/reports/aweb00-admin-inventory-2026-10-04.md` — ma trận + phân loại + đề xuất + open questions; mọi claim có `file:line`.

## Ràng buộc

- **READ-ONLY**: không sửa source/test/plan/docs; không tick; không commit; không restart container; không chạm file lane khác (Claude đang giữ `orchestrator/src`; codex đang giữ `tasks/ADMIN-WEB-*` + plan docs).
- Không đụng hạ tầng live của user.
- Xong: báo receipt path + verdict ngắn.

## Lane

- cc_1 — `term_b89fe355-f097-4f25-90bd-98720a3ed978` (dispatch 2026-10-04 11:05).

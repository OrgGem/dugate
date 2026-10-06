# Dispatch spec — AWEB-02b tenantAdminTokens env wiring (2026-10-04 12:22 +07)

## Mục tiêu

Đóng gap duy nhất của AWEB-02 cho operator read trên deployment: `main.ts` chưa parse env cho `config.tenantAdminTokens` (receipt `aweb02-bff-foundation` §7; ServerConfig field + validation đã có).

## Việc cần làm

1. `services/orchestrator/src/main.ts`: parse env `tenantAdminTokens` → map `tenantId → token` đúng shape ServerConfig đang validate (xem field + validation hiện có; giữ fail-fast nếu shape sai).
   - Định dạng env: theo convention config hiện hành (nếu chưa có → đề xuất JSON map, ghi rõ trong receipt + ví dụ `.env` không chứa secret thật).
2. Không bật/tắt gì mặc định; không đổi policy fence (đã verify ở AWEB-02); không đụng `server.ts`.
3. Focused test mới cho parse (valid/malformed/missing) nếu hợp lease; chạy `tsc` + test liên quan; ghi literal.

## Lease

- **Sở hữu:** `services/orchestrator/src/main.ts` (single writer), file test focused mới `services/orchestrator/tests/**`.
- **KHÔNG sửa:** `shell-server.ts`, `bff/**`, `apps/admin-web/**`, `packages/contracts/**`, `server.ts`, `tasks/**`, `docs/**` (nếu cần doc `.env.example` → ghi doc-note trong receipt, không sửa). Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb02b-tenant-token-env-2026-10-04.md` — diff `main.ts`, format env chốt, literal test/tsc, doc-note.

## Lane

- **cc_2** — `term_5f7e42da-6790-4449-8539-746626c5d078`. Dispatch 2026-10-04 12:22.

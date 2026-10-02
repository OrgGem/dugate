# CONV-05 — Admin fetcher sanitization helper (CONV-D02) (từ plan CONVENTION)

## Bối cảnh

Plan `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` §CONV-05 + `CONV-D02`: ít nhất 5 fetcher
`src/app/admin/{api-key,business,connector,profile,operation,overview}-section-data.ts` có thân `readErrorBody`/`sanitiseErrorBody` trùng.
Bounded refactor — **KHÔNG chạm `server.ts`**, không đổi hành vi.

## Mục tiêu

1. Trích **sanitization của upstream error body** thành **1 helper** trong `app/admin/` (giới hạn **256 ký tự**, không echo secret upstream).
2. Đối chiếu từng fetcher các case 401/403/404/timeout/invalid JSON **trước khi** trích parser payload — chỉ trích thêm nếu matrix thật sự giống
   (theo CONV-D02: `parseFetchPayload`/`buildOkFromCatalog` **chưa chứng minh** semantics giống — nếu không giống, ghi exception thay vì ép generic).
3. Giữ nguyên discriminated result từng fetcher + timeout/status mapping; bỏ duplicate exact-body đã xác nhận; ghi trước/sau (dòng/symbol/import).

## Ranh giới

- Allowed: `services/orchestrator/src/app/admin/*-section-data.ts` + helper mới trong `app/admin/`. Read-only còn lại (audit module, `server.ts`, renderers, contracts).
- Không tick gate; không commit; không sửa `tasks/*.md`/AGENTS.md; không nhắm `nocobase-10`.

## Acceptance

- Focused Admin fetcher tests hiện có + `tsc --noEmit` orchestrator → exit 0; ghi literal.
- Không file >2.000 sau thay đổi; không circular import.
- Receipt: `coordination/reports/qwen-conv05-admin-fetcher-2026-10-02.md` (before/after số dòng + danh sách fetcher đã nối).

# CONV-12 — tách `shell-router.ts` cận ngưỡng (từ plan CONVENTION)

## Bối cảnh

Plan `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` §CONV-12: `services/orchestrator/src/app/admin/shell-router.ts` hiện **1.916 dòng** (cận ngưỡng).
Coordinator đã kiểm tra: file **sạch** (không còn thay đổi chưa commit; lần sửa cuối đã vào `df2fb2c`). Không có ACUI/P6 writer trên file này — đủ điều kiện chạy.

## Mục tiêu (theo packet)

1. Tách theo trách nhiệm: **session/OIDC gate**, **section fetch orchestration**, **mutation/CSRF**, **crypto-config**
   sang các module mới `src/app/admin/{section,auth,mutation}-dispatch.ts` (hoặc tên tương đương — ghi rõ trong receipt).
2. **Giữ nguyên** public signatures `dispatchShellRequest` / `dispatchShellRequestAsync` và URL matcher precedence cho `shell-server` consumer;
   cookie/CSRF/session revocation, role gate, GET/POST routing, `deferredSectionExtras`, redirect, `no-store` — bất biến.
3. Không import cycle; giữ `server.ts`/`shell-server.ts` read-only (trừ khi interface change có lease riêng — không có ở đây).

## Ranh giới

- Allowed: `src/app/admin/shell-router.ts`, module mới trong `src/app/admin/`, focused Admin shell tests.
- KHÔNG tick gate; không commit; không sửa `tasks/*.md`/AGENTS.md; không nhắm `nocobase-10`.

## Acceptance

- `shell-router.ts` **< 1.500 dòng** sau tách; focused session/router/mutation tests + `tsc --noEmit` orchestrator → exit 0;
  ghi literal before/after (dòng, symbol, consumer imports).
- Receipt: `coordination/reports/qwen-conv12-shell-router-split-2026-10-02.md`.

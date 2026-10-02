# WSD-SYNCPOST-CODE — giữ mã lỗi connector trên đường POST đồng bộ (diagnostics-only)

## Bối cảnh

Từ báo cáo 2cfix (chính lane này): `packages/worker-sdk/src/connector-invoker.ts:145` chỉ parse `code` cho 401/403/409 trên đường POST đồng bộ
→ mã (`PROVIDER_REQUEST_REJECTED`, `PROVIDER_UNAVAILABLE`, …) bị flatten thành `PROVIDER_UNAVAILABLE`. Retry **vẫn đúng**
(`worker.ts:519` dùng `=== 503` → 502 ra false) — đây là mất **chẩn đoán**, không phải retry mù.

## Mục tiêu

1. Giữ nguyên `error.code` (và message nếu có) từ envelope connector non-2xx trên đường sync POST thay vì ghi đè flatten.
2. **KHÔNG đổi semantics retry** (`retryable`/`=== 503` giữ nguyên) và không đổi wire connector; thuần cải thiện chẩn đoán.
3. Tests: 400/`PROVIDER_REQUEST_REJECTED`, 502/`PROVIDER_UNAVAILABLE`, nhánh cũ 401/403/409 — ghi hành vi trước/sau trong receipt.

## Ranh giới

- Chỉ `packages/worker-sdk/src/connector-invoker.ts` + tests của nó; không đụng connector service/server.ts; không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/qwen-wsd-syncpost-code-2026-10-02.md`.

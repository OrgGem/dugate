# CONN-2C-FIX — sửa hồi quy `retryable` sau 2c (A-1) + hoàn thiện passthrough khai báo (A-2)

## Bối cảnh

Audit `coordination/reports/qwen-connector-error-code-consumer-audit-2026-10-02.md` §3–§4:
- **A-1 (hồi quy do 2c):** `packages/connector-client/src/transport.ts:137-141` đặt `retryable: status === 429 || status >= 500`.
  Trước 2c, provider 4xx → service map 400 → false ✓; sau 2c → 502 → **true ✗** (từ chối tất định bị báo retryable).
- **A-2 (gốc):** `retryable` đã khai trên wire type (`packages/connector-client/src/types.ts:25-26`, W39-CC2 *passthrough*)
  nhưng **chưa bao giờ được gửi** (`services/connector/src/http/server.ts:75-77`) **hoặc đọc** (`transport.ts:129`).

## Mục tiêu

1. **Service gửi tín hiệu** (`services/connector/src`): thêm `error.retryable` (+ `retryAfterMs` nếu có) vào envelope lỗi HTTP
   theo taxonomy hiện có — `PROVIDER_REQUEST_REJECTED`/4xx-type → `false`; `429`/transient → `true`. Thuần **additive** (type đã khai).
2. **Client đọc** (`packages/connector-client/src/transport.ts`): parse `retryable` từ wire; khi wire thiếu → fallback phân biệt được
   502-rejection với 502-gateway (dùng `code` đã parse, hoặc thu hẹp heuristic — **ghi rõ lựa chọn + lý do trong receipt**).
3. **Tests cả hai phía:** wire có/thiếu `retryable`; 4xx-type → false; 502 `PROVIDER_REQUEST_REJECTED` → false; 429/503 transient → true.

## Ranh giới

- Chỉ `services/connector/src/**` + `packages/connector-client/src/**` + tests hai package (có thể 1 dòng README hai package nếu cần).
- KHÔNG đổi public docs/wire ngoài connector; không tick gate; không commit; không nhắm `nocobase-10`.
- Giữ additive: consumer cũ (không đọc field mới) không bị ảnh hưởng.

## Acceptance

- `services/connector` + `packages/connector-client` suites + `tsc --noEmit` hai package → exit 0 (ghi literal).
- Receipt: `coordination/reports/qwen-conn2cfix-retryable-2026-10-02.md` (trước/sau + lựa chọn fallback).

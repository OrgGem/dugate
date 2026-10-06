# CRX-01 — Metadata writer seam (P0)

Nguồn: `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md` mục **CRX-01** — đọc kỹ; **đọc lại source hiện tại**.

**File lease:** `services/orchestrator/src/server.ts` (vùng tạo submission/runtime/ingestion consumer) + `services/orchestrator/src/main.ts` + `services/orchestrator/src/modules/operations/submission.ts` + `services/orchestrator/src/modules/operations/ingestion-consumer.ts` + focused tests. **Không sửa file khác**; nếu bắt buộc → dừng, báo.
**(Lease `server.ts` hiện trống — lane này là writer duy nhất; nếu có lane khác cần server.ts, chờ receipt này.)**

## Việc

1. Tạo **một seam** `metadataCrypto` (từ encryption boot options đã có ở `main.ts:108-135`) **trước khi dựng** submission/runtime/ingestion consumer; truyền cùng key policy vào **cả ba**: `createSubmissionService`, `processIngestionTask` (ingestion-consumer), runtime path.
2. `server.ts:511-528` hiện tạo submission trước `metadataCrypto` và không truyền seam; `ingestion-consumer.ts:419-434` gọi `processIngestionTask` thiếu tham số — sửa để seal **luôn được cấp** trong app thật.
3. Kiểm tra các durable writer khác theo `ENC-META-01` (liệt kê cái đã kiểm; nêu cái còn hở nếu có).

## Acceptance (theo plan)

- Test qua `createApp`/entrypoint thật: submit inline, URL ingestion→READY, replay, và failure Vault → **quét sentinel**: không có `operations.input_ref` / `tasks.payload_ref` plaintext; **không dispatch nếu seal lỗi**.
- Focused tests + `tsc --noEmit` orchestrator; literal command/cwd/exit. Live S3/Vault nếu không chạy được → ghi gap.

## Ranh giới

- Không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/cc-crx01-metadata-seam-2026-10-03.md`.

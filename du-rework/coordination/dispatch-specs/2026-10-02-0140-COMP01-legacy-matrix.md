# COMP-01 slice A — legacy route shape characterization (READ-ONLY, no code changes)

## Mục tiêu

Characterization hình dạng route legacy cho 6 core API + workflows + operations/services/
billing: discriminator, sub-case, required/optional fields, file/url policy. Kết quả là
ma trận scope cho COMP-01 (slice A: route shape; slice sau: profile/connector/output),
KHÔNG phải implementation.

Bối cảnh: COMP-01 acceptance yêu cầu "ma trận 31 dòng map discriminator
`mode/type/task/action`, required/optional fields, profile parameter/connector, file/url
policy, output và business action đích; workflow dùng `process`". Task này làm phần
route-shape từ code cũ thật.

## Được phép đọc (read-only, TUYỆT ĐỐI không sửa file nào)

- `app/api/v1/docs/{ingest,extract,analyze,transform,generate,compare}/route.ts`,
  `app/api/v1/docs/workflows/route.ts`, `app/api/v1/docs/workflows/schema/route.ts`
  (legacy route thật: discriminator theo route nào — `mode`/`type`/`task`/`action`/`process`).
- `lib/endpoints/registry.ts` (SERVICE_REGISTRY: 6 services × N sub-cases, param schemas,
  connection chains), `lib/pipelines/format.ts` (operation serialization),
  `lib/endpoints/runner.ts`, `middleware.ts` (auth `x-api-key` handling).
- `app/api/v1/operations/**`, `app/api/v1/services/route.ts`,
  `app/api/v1/billing/**/route.ts` (poll/list/cancel/resume/download, services, billing).
- Rework counterpart để map tên (chỉ đọc, không sửa): 
  `businesses/document-core/src/manifest/document-core.manifest.ts`,
  `businesses/document-core/src/recipes/recipe-definitions.ts`,
  `businesses/document-core/src/recipes/step-keys.ts`.

## Cấm

- KHÔNG sửa bất kỳ file nào (kể cả test). Task này là characterization thuần túy.
- KHÔNG implement facade/alias/decoder nào — COMP-00 chưa chốt, implementation bị cấm.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG đụng `server.ts`, `contracts`, `tasks/*.md`, `AGENTS.md`.
- KHÔNG tái hiện lỗi bảo mật legacy (`x-api-key-id` tự khai, ADMIN fallback,
  list-no-resolve, plaintext fallback, fake `CANCELLED`).

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`:

1. Ma trận route: mỗi legacy route → file:line, method, discriminator field + giá trị,
   danh sách sub-case, required/optional input fields, file params
   (`files[]`/`file`/`source_file`/`target_file`/`file_urls`), `sync`/`webhook_url`/
   `output_format`/`language`/`pages` support, rework action đích (map tên).
2. Đếm sub-case đối chiếu 31 (4+6+7+5+6+3) — ghi khớp/lệch từng service, MISMATCH nào
   ghi file:line (kể cả JSON-body claim sai, catalog 28 sai, guide route không khớp).
3. Ghi rõ điểm legacy spec-vs-code đã thấy (route comment vs path thật, swagger từ registry).
4. Không cần chạy test. Nếu chạy lệnh đọc hiểu thì ghi literal.

## COMMON

Task read-only thuần túy (không sửa file nào) → không cần COMP-00, không va chạm lease
(COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có COMP-00). Không tái hiện
lỗi bảo mật legacy (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext
fallback, fake CANCELLED). Không tick gate. Không commit thay đổi lane khác. Không nhắm
nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution overlay. Test chuyên ngành
là evidence không phải blocker. DEV TEST ISOLATION.

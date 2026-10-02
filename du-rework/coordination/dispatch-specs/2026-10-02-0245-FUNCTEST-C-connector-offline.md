# FUNCTEST-C — offline functional tests: connector service (NO infra, NO source edits)

## Mục tiêu

Chạy toàn bộ functional test **offline (zero infra)** của `services/connector/tests`
để verify tasks P3/connector. Lane test chức năng (verify), KHÔNG phải implementation.

## Được phép chạy (chỉ test offline — TUYỆT ĐỐI không chạm infra)

- Chạy từ `services/connector` (`npx jest --runInBand <file>` từng suite, ghi literal + exit code).
- **BẮT BUỘC SKIP** (đòi PG `:5433`/Redis `:6380`/network/durable infra), không chạy dù bất kỳ lý do gì:
  - `network-boundaries.boundary.test.ts`
  - `black-box-durable.test.ts`, `durable-integration.test.ts`, `p8-03-convergence.test.ts`
    (có reference infra trong file — nếu inspect thấy offline thuần túy thì mới chạy, ngược lại SKIP + ghi lý do).
- Quy tắc skip chung: bất kỳ suite nào đòi kết nối PG/Redis/S3/Vault-live/docker
  → dừng suite đó ngay, ghi `SKIPPED-live`, KHÔNG tự khởi container, KHÔNG claim DB window.
- Ưu tiên chạy trước: `canonical-hash-parity`, `connector`, `composition`,
  `runtime-foundations`, `service-auth`, `secret-resolver`, `vault-*-offline*`,
  `r1-d-lifecycle-offline`, `r1-d-03-mock-provider-reconciliation.functional`,
  `reliability-security`, `security-lifecycle`, `webhook`, `invocation-access`.

## Cấm

- KHÔNG sửa bất kỳ file source/test nào (test đỏ chỉ ghi nhận failure literal + file:line).
- KHÔNG chạy test `businesses/document-core/**` (D3 lease đang active).
- KHÔNG `npm install`, không đụng lockfile, `server.ts`, `contracts/src`,
  `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy khi đọc code phục vụ debug test
  (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
  fake CANCELLED) — chỉ ghi nhận factual.

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`
(`codex-functest-c-connector-offline-2026-10-02.md`):

1. Bảng kết quả từng suite: tên file, số test pass/fail/skip, exit code, lệnh literal đã chạy.
2. Danh sách suite SKIPPED-live + lý do từng suite.
3. Test đỏ (nếu có): failure literal + file:line liên quan, KHÔNG tự sửa.
4. Tổng hợp: X/Y suites xanh, zero infra sử dụng.

## COMMON

Task verify bằng chạy test (không sửa file) → không cần COMP-00, không va
chạm lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có
COMP-00; D3 lease worker.ts/manifest/recipes không đụng; rework encryption
module không đụng). Exclusive lease không áp dụng (không giữ file). Không tái
hiện lỗi bảo mật legacy (x-api-key-id tự khai, ADMIN fallback, list-no-resolve,
plaintext fallback, fake CANCELLED). Không tick gate. Không commit thay đổi
lane khác. Không nhắm nocobase-10. Không sửa AGENTS.md, tasks/README.md,
execution overlay. Test chuyên ngành là evidence không phải blocker.
DEV TEST ISOLATION (parallel dev tests OK với per-lane DB/schema +
Redis prefix/DB + S3 prefix/bucket — lane này dùng zero infra nên không cần).

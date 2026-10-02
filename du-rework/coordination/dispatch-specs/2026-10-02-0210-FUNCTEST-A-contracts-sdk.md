# FUNCTEST-A — offline functional tests: contracts + SDK/packages (NO infra, NO source edits)

## Mục tiêu

Chạy toàn bộ functional test **offline (zero infra)** của `packages/contracts`,
`packages/worker-sdk`, `packages/connector-client`, `packages/document-kit`,
`packages/observability` để verify tasks COMP/contracts/SDK. Đây là lane test
chức năng mới của agent (chuyển từ characterization sang verify), KHÔNG phải
implementation.

## Được phép chạy (chỉ test offline — TUYỆT ĐỐI không chạm infra)

- `packages/contracts/tests/*.test.ts` (23 suites, toàn bộ offline).
- `packages/worker-sdk/tests/` — TRỪ 2 file:
  `network-boundaries.boundary.test.ts`, `workspace-reference-wiring.test.ts`.
- `packages/connector-client/tests/` — chỉ `client.test.ts`,
  `sdk-invoker.test.ts`, `transport.test.ts` (TRỪ `real-service.test.ts`,
  `network-boundaries.boundary.test.ts`).
- `packages/document-kit/tests/` toàn bộ (không suite nào cần DB).
- `packages/observability/tests/observability.test.ts`
  (`elasticsearch-collector.test.ts` chỉ chạy nếu offline thuần túy,
  thấy đòi infra thì SKIP + ghi nhận).
- Lệnh: chạy từng package từ thư mục package
  (`npx jest --runInBand`), ghi literal output + exit code từng suite.
- Quy tắc skip: bất kỳ suite nào đòi kết nối PG `:5433`/Redis `:6380`/
  ES/minio/docker → dừng suite đó ngay, ghi `SKIPPED-live`, KHÔNG tự
  khởi container, KHÔNG claim DB window.

## Cấm

- KHÔNG sửa bất kỳ file source/test nào (kể cả fix test đỏ — chỉ ghi nhận).
- KHÔNG chạy suite live (`*.live.test.ts`, `real-service`, `bullmq-smoke`,
  migration/tenant-fence/runtime/blob-wire ở orchestrator — ngoài phạm vi lane).
- KHÔNG chạy test `businesses/document-core/**` (D3 lease đang active).
- KHÔNG `npm install`, không đụng lockfile, `server.ts`, `contracts/src`,
  `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy khi đọc code phục vụ debug test
  (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
  fake CANCELLED) — chỉ ghi nhận factual.

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`
(`codex-functest-a-contracts-sdk-2026-10-02.md`):

1. Bảng kết quả từng suite: tên file, số test pass/fail/skip, exit code,
   lệnh literal đã chạy.
2. Danh sách suite SKIPPED-live (nếu có) + lý do.
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

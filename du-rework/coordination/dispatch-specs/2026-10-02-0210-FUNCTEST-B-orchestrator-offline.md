# FUNCTEST-B — offline functional tests: orchestrator (NO live DB, NO source edits)

## Mục tiêu

Chạy toàn bộ functional test **offline** của `services/orchestrator/tests`
để verify tasks COMP/orchestrator. Đây là lane test chức năng mới của agent
(chuyển từ characterization sang verify), KHÔNG phải implementation.

## Được phép chạy (offline only — deny-list live bắt buộc)

Chạy từ `services/orchestrator` (`npx jest --runInBand <file>` từng suite,
ghi literal + exit code). **BẮT BUỘC SKIP** 30 file live sau (đòi PG
`:5433`/Redis `:6380`/S3-live), không được chạy dù bất kỳ lý do gì:

- `admin-action-rbac-live.test.ts`, `admin-audit.test.ts`,
  `admin-audit-mount.test.ts`, `admin-base-routes.test.ts`,
  `admin-crypto-config-shell.test.ts`, `admin-crypto-config-wiring.test.ts`,
  `admin-error-boundary.test.ts`, `admin-keyset-explain.test.ts`,
  `admin-local-users-migration.test.ts`, `admin-mutation-atomicity.test.ts`,
  `admin-shell-live-pane.test.ts`, `admin-shell-platform-mount.test.ts`,
  `artifact-grant-fencing.test.ts`, `artifacts-fencing-pg.test.ts`,
  `blob-wire-binary.test.ts`, `data-02-04-live-s3.test.ts`,
  `encryption-boot-options.test.ts`, `graceful-shutdown.boundary.test.ts`,
  `ingress-bounded.test.ts`, `migrations.test.ts`,
  `oidc02-multi-replica-offline.test.ts`,
  `oidc02-process-replicas-offline.test.ts`, `oidc-boot.test.ts`,
  `operation-tenant-fence.test.ts`, `redis-session-repository.test.ts`,
  `runtime.test.ts`, `usage-summary.test.ts`,
  `webhook-error-boundaries.boundary.test.ts`,
  `webhook-reclaim-fence.live.test.ts`, `workspace-reference.test.ts`.
- Quy tắc skip chung: thêm mọi file `*.live.test.ts`, mọi suite đòi kết nối
  DB/Redis/S3/docker → dừng suite đó, ghi `SKIPPED-live`, KHÔNG tự khởi
  container, KHÔNG claim DB window.
- Ưu tiên chạy trước nhóm compat: `operations-list-*`,
  `legacy-payload-migration`, `credential-legacy-transition-offline`,
  `url-ingestion-*offline*`, `connector-*-offline*`,
  `adm-base-03-safe-error-offline`, `multipart-*`, `admin-shell-render`,
  `usage-*`, `log-collector` — rồi tới phần còn lại.

## Cấm

- KHÔNG sửa bất kỳ file source/test nào (kể cả fix test đỏ — chỉ ghi nhận).
- KHÔNG chạy test `businesses/document-core/**` (D3 lease đang active).
- KHÔNG `npm install`, không đụng lockfile, `server.ts`, `contracts/src`,
  `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy khi đọc code phục vụ debug test
  (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
  fake CANCELLED) — chỉ ghi nhận factual.

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`
(`codex-functest-b-orchestrator-offline-2026-10-02.md`):

1. Bảng kết quả từng suite: tên file, số test pass/fail/skip, exit code,
   lệnh literal đã chạy.
2. Danh sách 30 file deny-list + mọi suite SKIPPED-live khác (xác nhận đã skip).
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

# OPT-PERF-02 — offline benchmark harness cho multipart crypto chunk geometry (new-file-only)

## Mục tiêu

OPT-PERF-01 Proposal D (§4, receipt `codex-opt-perf-01-request-path-2026-10-02.md`)
kết luận: không có source diff nào an toàn trước khi đo — chunk geometry
(4 MiB chunks, 8 MiB high-water) nằm trong persisted manifest và bị validate
(`crypto-storage-facade.ts:86,292-297,368`). Task này xây benchmark harness
offline để đo trước, đúng yêu cầu "establish local throughput/RSS measurements".

## Được phép làm

1. **Tạo file mới prefix `opt-perf-` (CHỈ new-file):** benchmark harness offline
   so sánh wall throughput + peak RSS khi biến chunk geometry, với local AES thật
   và mocked storage. Giữ nguyên integrity hashes, auth tags, manifest fields,
   streaming/backpressure. Ghi before/after numbers vào receipt.
2. Không wire harness vào caller (đó là sửa file cũ → cấm).
3. Mọi phát hiện muốn đổi constant runtime → patch-proposal + lease request,
   KHÔNG tự sửa.

## Cấm

- KHÔNG sửa bất kỳ file hiện có nào (source/test/config/tasks/plan).
- KHÔNG đổi chunk geometry runtime (chỉ benchmark).
- KHÔNG đụng public wire/COMP-02..09 (BLOCKED-COMP-00 nếu proposal chạm wire).
- KHÔNG sửa `server.ts`, `contracts/src`, `businesses/document-core/**`
  (D3 lease), lockfile, `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG chạy suite live/infra; KHÔNG claim DB window, KHÔNG `npm install`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (chỉ ghi nhận factual).

## Acceptance

Receipt → `coordination/reports/`
(`codex-opt-perf-02-crypto-bench-2026-10-02.md`):
file mới liệt kê + before/after numbers + verdict (có gain đáng lease hay không)
+ patch-proposal/lease request nếu có.

## COMMON

Task benchmark offline (không đổi public wire) → không cần COMP-00, không va chạm
lease. New-file-only prefix `opt-perf-`. Không tái hiện lỗi bảo mật legacy
(x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
fake CANCELLED). Không tick gate. Không commit thay đổi lane khác.
Không nhắm nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
DEV TEST ISOLATION (lane này zero infra nên không cần).

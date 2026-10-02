# OPT-PERF-01 — service request-path latency: đo + đề xuất tối ưu (implement new-file-only)

## Mục tiêu

Làm service xử lý request nhanh hơn bằng evidence đo đạc, không đoán.
Đọc các lane khác qua receipts (`FUNCTEST-A/B/C`, `RED-EVIDENCE`, `PAR00-MAP`)
để không đề xuất trùng và không phá behavior đã xanh.

## Được phép làm

1. **Đo (offline, zero infra):** chạy các suite offline liên quan request-path
   (`ingress`, `multipart-*`, `operations-list-*`, `admin-shell-server`,
   `compat-decoders`, `legacy-*`) với timing, ghi per-suite/per-test ms làm baseline.
   Inspect read-only hot path: `readBoundedBody`/`ingress.ts`, JSON parse/stringify
   mỗi request, `resolveApiKey` (bcrypt/scrypt/hash cost), facade mapping,
   pagination/query shape (static analysis, KHÔNG chạy live DB), logger sink
   (`process.stdout.write` mỗi log line — đã thấy trong RED-EVIDENCE).
2. **Implement ngay CHỈ khi new-file-only:** file mới do lane tạo, không sửa bất kỳ
   file hiện có nào (kể cả test/config). Tên file prefix bắt buộc `opt-perf-`
   (vd `tests/opt-perf-json-bench.test.ts`) để không va chạm lane khác.
   Nội dung cho phép: benchmark harness chứng minh gain (before/after numbers),
   helper tối ưu dạng thư viện chờ wiring (chưa wire vào caller vì đó là sửa file cũ).
3. **Mọi thay đổi chạm file hiện có** (kể cả 1 dòng nhanh hơn): KHÔNG tự sửa —
   ghi patch-proposal (unified-diff style trong receipt) + lease request
   (file, lý do, risk, owner dự kiến) để coordinator serialize.

## Cấm

- KHÔNG sửa bất kỳ file hiện có nào (source/test/config/tasks/plan).
- KHÔNG đụng public wire / contract freeze (mọi proposal đổi shape/status/header
  ghi rõ `BLOCKED-COMP-00`; COMP-02..09 implementation vẫn cấm tuyệt đối).
- KHÔNG sửa `server.ts` (single integrator), `contracts/src`, compat surface,
  `businesses/document-core/**` (D3 lease), lockfile, `tasks/*.md`, `AGENTS.md`,
  execution overlay.
- KHÔNG chạy suite live/infra (giữ 30-file deny-list FUNCTEST-B +
  `rv0104-live-encryption` + 4 skip FUNCTEST-C); KHÔNG claim DB window, KHÔNG `npm install`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (chỉ ghi nhận factual).

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`
(`codex-opt-perf-01-request-path-2026-10-02.md`):

1. Baseline timing table (suite, tests, ms) + top 5 hotspots có file:line.
2. Mỗi hotspot: đề xuất cụ thể, gain ước tính/đo được, risk, và trạng thái
   (`implemented new-file` / `patch-proposal + lease request` / `BLOCKED-COMP-00`).
3. File mới tạo (nếu có): liệt kê + kết quả bench before/after.
4. Thứ tự triển khai đề nghị cho coordinator (impact / effort).

## COMMON

Task đo + đề xuất (không đổi public wire) → không cần COMP-00, không va chạm
lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có COMP-00;
D3 lease worker.ts/manifest/recipes không đụng; rework encryption module không
đụng; `server.ts` single-integrator — lane này KHÔNG sửa server.ts).
New-file-only với prefix `opt-perf-` để tránh va chạm. Không tái hiện lỗi bảo mật
legacy (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext
fallback, fake CANCELLED). Không tick gate. Không commit thay đổi lane khác.
Không nhắm nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution
overlay. Evidence là đầu vào quyết định, không phải blocker. DEV TEST ISOLATION
(lane này zero infra nên không cần).

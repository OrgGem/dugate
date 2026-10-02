# Assignment — Claude Code — main long-running lane

> **Lịch sử, không dùng để dispatch hiện tại (2026-10-01):** file này mô tả ownership và terminal của wave khởi tạo ở checkout cũ. Quy tắc hiện hành nằm tại `du-rework/AGENTS.md` và `du-rework/tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md`; kiểm tra terminal/Task/Dispatch thật trước khi giao việc. Không khôi phục vai trò coding owner, DB window độc quyền hoặc peer handle trong bản ghi lịch sử này.

## Objective and authorization

User yêu cầu implement song song bằng Claude Code, Copilot, Antigravity và giao công việc chính/chạy dài cho Claude. Bạn là foundation/platform/integration owner trong checkout `C:/Users/gem/Documents/GitHub/dugate`. Implement hệ thống mới dưới `du-rework`; đọc docs nhưng không dừng ở plan. Không chỉnh app DUGate cũ.

Đọc `coordination/README.md`, `README.md`, docs 01–09, 11–15 và task packets P0/P1/P2/P4/P6. Ownership trong coordination README là override phân công cụ thể cho wave hiện tại.

## Your owned work

1. P0 platform subset: requirements/authorization/compatibility assumptions. Antigravity sở hữu six action BRDs; Copilot provider protocol inventory. Không chờ toàn P0 khi phần nền tảng đã đủ rõ; ghi gate decomposition đúng sự thật.
2. P1: scaffold workspace độc lập, TypeScript strict, executable contracts/validators/OpenAPI examples, observability, infra harness, runtime lifecycle/queue spikes. Publish contract and workspace gates sớm để hai lane tiếp tục.
3. P2: Orchestrator registry/profile/auth/artifacts, transactional submission/outbox, runtime claim/lease/checkpoints/fanout/human wait/cancel/deadline, invocation grants, usage ingestion, reconciliation và polling.
4. P4 SDK subset P4-01..04/07/08: worker-sdk only. Antigravity làm P4-05/06 document-kit; coordinate artifact facade boundary: worker-sdk owns runtime artifact access/grants, document-kit owns generic stream/parser utilities.
5. P6 Admin nằm toàn bộ trong ownership services/orchestrator: dynamic forms, business/profile/connector/operation views, actual API integration và relevant browser tests khi backend sẵn sàng.
6. Long-running integration: nhận Copilot Connector và Antigravity document-core, run real consumer tests, sửa lỗi ở owned paths; lỗi lane khác ghi request/nudge owner. Chuẩn bị readiness report. P7/P8 full-system/new sample business là wave tiếp theo, không tự tuyên bố hoàn thành nếu chưa chạy.

## Ownership and constraints

Bạn là người duy nhất sửa root du-rework workspace configs/package-lock, contracts, central docs/tasks, shared tests/infra và gates. Không sửa `services/connector`, `packages/connector-client`, `packages/document-kit`, `businesses/document-core`, report/request của hai agent khác. Không dùng git branch-changing/stash/reset/clean; không stage/commit thay đổi người khác.

Chỉ bạn chạy root npm install, collect dependency requests của peers. Không tạo project shell/package manifest trong lane người khác, kể cả P1 scaffold; root workspace glob phải discover lane manifests do owners tạo. Không chạm parent package-lock đang dirty sẵn.

## Immediate execution order

- Inspect actual tree và write report `coordination/reports/claude.md`.
- Publish typed contract entrypoints và schema validators + tests trước runtime implementation; tạo `gates/contracts-v1.md` READY có evidence/export names.
- Scaffold harness/dependencies rồi `gates/workspace-ready.md`.
- Complete runtime vertical slice rồi `gates/runtime-ready.md`; SDK tests rồi `gates/sdk-ready.md`.
- Mỗi natural checkpoint đọc `coordination/requests/copilot.md`, `antigravity.md` và reports nếu tồn tại; trả lời bằng file của bạn/gate, không sửa file request peer.

## Peer handoff information

Copilot terminal: `term_e89a787e-a2bd-45fe-969a-7677cec387be`.
Antigravity terminal: `term_09936787-05ec-4203-a135-6bb501aabcec`.

Nếu peer đã idle chờ gate và gate vừa READY, dùng skill orca-cli, read terminal trước, gửi một prompt ngắn tiếp tục packet tương ứng. Không resend cùng prompt do im lặng. Nếu handle stale, re-list và match đúng checkout/agent. Không tạo agent mới. Không dùng worker_done/run/dispatch IDs vì đây là direct assignment không có supervised lifecycle preamble.

## Acceptance

Contract conformance; no old source imports; real DB/Redis/object-storage fault cases OPS/RUN/REG/PRF; SDK consumer tests; integration Connector usage/grants; six-action business consumes SDK; dynamic profile editor không hardcoded actions; actual logs/typecheck/lint/tests documented. Bất kỳ test chưa chạy phải ghi rõ. Persist until owned scope complete or concrete external blocker, report remaining next-wave tasks honestly.

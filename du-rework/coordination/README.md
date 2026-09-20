# Parallel implementation — assignment 2026-09-20

> Current handoff: [CHECKPOINT-2026-09-21](CHECKPOINT-2026-09-21.md). Đọc checkpoint này trước khi mở workload mới; các bảng bên dưới là lịch sử assignment ban đầu.

User đã yêu cầu bắt đầu implementation và gửi việc tới ba agent đang mở. Giới hạn planning-only của lượt trước đã được thay bằng quyền implement trong `du-rework/`. Repository DUGate bên ngoài vẫn read-only reference.

## Active assignments

| Agent | Packet | Ownership chính | Start immediately |
|---|---|---|---|
| Claude Code | [CLAUDE](CLAUDE.md) | Foundation/contracts + Orchestrator + worker-sdk + integration | Platform BRD/gate decomposition, workspace, interfaces/contract tests |
| GitHub Copilot | [COPILOT](COPILOT.md) | Connector + connector-client + provider mock | Connector design, ports, adapter fixtures/tests và local logic |
| Antigravity | [ANTIGRAVITY](ANTIGRAVITY.md) | document-core BRDs + document-kit + six action worker | Six BRDs, fixtures, parser interfaces/local utilities |

Các agent dùng chung checkout hiện tại. Không git checkout/reset/clean/stash/rebase, không commit/stage toàn repo, không sửa file của agent khác. Không tạo thêm agent. Không migrate/deploy production hoặc dùng DB/.env của app cũ.

## Exact ownership

- Claude: `du-rework/package.json`, root lock/config/scripts; `packages/contracts/**`, `packages/observability/**`, `packages/worker-sdk/**`; `services/orchestrator/**`; `infra/**`; shared `tests/**`; central docs/tasks và `coordination/gates/**`; `coordination/reports/claude.md`.
- Copilot: `services/connector/**`, `packages/connector-client/**`, `coordination/reports/copilot.md`, `coordination/requests/copilot.md`. Provider mock nằm `services/connector/tests/mock-provider/**`.
- Antigravity: `businesses/document-core/**`, `packages/document-kit/**`, `coordination/reports/antigravity.md`, `coordination/requests/antigravity.md`.
- `businesses/example-review/**` chưa giao implementation trong wave này. P7/P8 complete-system gate làm sau khi ba lane có evidence.
- Packet assignment và `coordination/dispatch-receipts.md` do người gửi quản lý; agent chỉ đọc.

Root install/lockfile do Claude làm duy nhất. Package manifests trong lane do lane owner viết; dependency requests gửi vào requests riêng, Claude resolve root install. Không chạy npm install ở parent DUGate; không tạo nested lockfiles. Test/build dùng dependencies đã có trong du-rework sau workspace-ready marker.

## Gate protocol — tránh chờ cả phase hoặc đổi interface ngầm

1. Platform requirements từ docs 01–09 đủ để Claude triển khai P0 platform subset/P1. Antigravity làm P0 business subset song song; Copilot làm provider capability subset. Action implementation chỉ bắt đầu khi action BRD tương ứng xong.
2. Trước wire freeze, Copilot/Antigravity làm business docs, pure local interfaces/functions, synthetic fixtures và tests. Không tự publish DTO thay thế `@du/contracts`, không viết imports đoán mò.
3. Claude ưu tiên `coordination/gates/contracts-v1.md`: exported types/module paths, schema/API versions, queue conventions, contract test commands/results, remaining supported limits. Chỉ tạo READY khi executable contracts validate; đây là G1 interface milestone, không được ghi toàn P1 complete nếu harness/spikes chưa xong.
4. Claude publish `workspace-ready.md` sau cài dependencies/test harness, `runtime-ready.md` sau actual runtime API tests, `sdk-ready.md` sau SDK consumer tests. READY marker ghi actual paths/commands, không chỉ một dòng tuyên bố.
5. Hai lane đọc gates ở mỗi checkpoint. Tiếp tục actual consumer integration khi provider ready; làm local independent work trong khi chờ. Nếu không còn việc độc lập, báo WAITING_GATE trong report thay vì tự sửa contracts/platform.
6. Claude đọc lane reports/requests trước sửa contract, sau test và trước kết thúc; gửi nudge cùng task tới terminal đúng nếu agent đang idle khi gate mở. Đây là tiếp tục assignment đã được user cho phép, không tạo run orchestration mới hay agent thay thế.
7. Thay đổi contract sau READY phải ghi impact vào gate, cập nhật consumer fixtures, trao đổi với lane owner trước breaking edit. Không claim tests pass bằng stub-only integration.

## Reports

Mỗi agent tự tạo report của mình: status IN_PROGRESS/WAITING_GATE/READY_FOR_INTEGRATION/DONE/BLOCKED; tasks; files; exported interfaces; dependency requests; test commands+actual results; blockers/next step. Claude tổng hợp vào report của Claude, không rewrite report người khác.

Terminal handles của lượt gửi này chỉ dùng trong runtime hiện tại; nếu stale phải `orca terminal list --json` và xác minh business/project trước gửi. Không gửi sang các terminal cùng loại agent ở repository khác.

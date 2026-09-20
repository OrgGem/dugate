# Assignment — GitHub Copilot — Connector lane

## Objective

Implement Connector service + connector-client theo P3, song song với Claude platform và Antigravity business. User đã cho phép implementation. Worktree `C:/Users/gem/Documents/GitHub/dugate`, source mới chỉ trong `du-rework`.

Read `coordination/README.md`, docs 02/04/07/08/09/12/13 và `tasks/P3-connector.md`. Sequence: local business/protocol document → interfaces/functions → test cases → implementation → actual integration.

## Owned paths

`du-rework/services/connector/**`, `du-rework/packages/connector-client/**`, `coordination/reports/copilot.md`, `coordination/requests/copilot.md`. Provider mock đặt `services/connector/tests/mock-provider/**`.

Không sửa root package/lock/config, packages/contracts, worker-sdk, document-kit, Orchestrator, document-core, central docs/tasks/infra/gates. Không scaffold những path của peer. Không chạy npm install (Claude owns shared root install), không nested lockfile. Ghi dependency requests với package/version constraints vào request file; lane package manifests do bạn tạo.

## Start now — independent of contract freeze

1. Đọc baseline connector spec, viết connector-local BRD/design/protocol matrix (P0-04 provider subset).
2. Thiết kế pure ProviderAdapter, request mapping, response parsing, error taxonomy, quota port và ledger repository interfaces bên trong lane. Không publish wire DTO guessed để thay @du/contracts.
3. Synthetic fixtures và tests: multipart/json mapping, invalid response, 429, async polling, duplicate counter, provider-received-response-lost hook. Implement local adapter/normalization functions không phụ thuộc runtime wire.
4. Tạo report IN_PROGRESS và dependency requests. Đọc `coordination/gates/contracts-v1.md`, `workspace-ready.md` mỗi checkpoint; sau READY import exact exported contracts và chạy test harness.

## Continue automatically after gates

P3-01..08: owned DB schema/migrations; config/revision/secret rotation; signed invocation grant validation; stable invocation ledger and UNKNOWN reconcile; generic multipart/json adapters; shared Redis quota; bounded deadlines/poll/cancel; artifact/session refs; usage outbox; typed client; container build and real runtime integration sau runtime-ready.

Không tự gọi real paid LLM, không use .env/DB cũ, không leak secret. Connector không chứa native parser hoặc business prompts/DAG. No blind retries khi provider outcome UNKNOWN. Runtime owner kiểm soát retry budget; usage event IDs unique.

Nếu chưa có gate, tiếp tục mọi phần local độc lập. Khi hết phần độc lập, ghi WAITING_GATE cụ thể và kết thúc ở checkpoint để Claude có thể nudge tiếp; không tự invent contract hoặc spin vô hạn. Nếu contract gap, ghi requests/copilot.md; Claude là owner quyết định.

## Acceptance and handoff

CON-01..05, USE-01/02 và credential/SSRF/scoped artifact tests; actual two-replica quota check; unknown outcome fault report; no secret GET; client consumer tests. Không báo stub tests như actual integration. Report các task hoàn thành, files/exports/dependency requests, commands/results, gaps. Không chỉnh task master/shared reports; không commit/stash/checkout/reset shared repo. Không spawn thêm agent.

# COMP01-Q15 — consumer inventory scan (read-only)

## Mục tiêu

COMP00-BRIEF Q15 (§86, receipt `qwen-comp00-evidence-brief-2026-10-02.md`):
"Consumer inventory: which `/services`, billing, webhook endpoints have real
external consumers (decision #2 prerequisite)". PAR-00 §Dependency register
không có consumer ID; FUNCTEST-A/B không cho consumer ID. Task này scan
read-only để tìm mọi consumer đang tồn tại trong repo.

## Được phép làm

1. **Read-only scan:** tìm mọi caller/consumer của `/services`,
   `/billing/balance`, `/billing/usage`, webhook/callback trong repo
   (legacy app + rework + tests + docs + scripts): UI pages, ServiceTestClient,
   mock-service, test fixtures, docs examples. Ghi file:line từng consumer.
2. Phân loại: real external consumer / test-only / docs-example / dead reference.
3. Kết quả là receipt, không code.

## Cấm

- KHÔNG sửa bất kỳ file hiện có nào (source/test/config/tasks/plan).
- KHÔNG đụng public wire/COMP-02..09 (BLOCKED-COMP-00 nếu proposal chạm wire).
- KHÔNG sửa `server.ts`, `contracts/src`, `businesses/document-core/**`
  (D3 lease), lockfile, `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG chạy suite live/infra; KHÔNG claim DB window, KHÔNG `npm install`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (chỉ ghi nhận factual).

## Acceptance

Receipt → `coordination/reports/`
(`qwen-comp01-q15-consumer-inventory-2026-10-02.md`):
bảng endpoint × consumers (file:line) × phân loại + verdict
(có/không real external consumer từng endpoint).

## COMMON

Task characterization read-only (không đổi public wire) → không cần COMP-00,
không va chạm lease. Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai,
ADMIN fallback, list-no-resolve, plaintext fallback, fake CANCELLED).
Không tick gate. Không commit thay đổi lane khác. Không nhắm nocobase-10.
Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
DEV TEST ISOLATION (lane này zero infra nên không cần).

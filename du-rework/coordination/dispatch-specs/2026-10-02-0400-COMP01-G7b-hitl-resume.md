# COMP01-G7b — HITL resume path trace (read-only characterization)

## Mục tiêu

G7 receipt §4.2 để lại: đường resume sau HITL chưa trace
(`pauseWorkflow` ghi `{stepsResult, _nodeResults}`, `createWorkflowContext:376-388`
đọc lại — đi tiếp là một trace riêng). Task này trace riêng đó, characterization-only.

## Được phép làm

1. **Read-only:** từ `pauseWorkflow` → resume route/handler → context rebuild
   (`createWorkflowContext:376-388`) → tiếp tục execution → persist → download.
   Ghi file:line mỗi hop; ghi rõ chỗ đứt (gap, không đoán).
2. Ghi rõ resume có đọc lại `_nodeResults` đầy đủ không, và `stepsResultJson`
   sau resume còn `"[]"` không (nối với GAP-2 của G7).
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
(`qwen-comp01-g7b-hitl-resume-2026-10-02.md`):
mạch pause→resume→persist có file:line + verdict về `_nodeResults`/`stepsResultJson`.

## COMMON

Task characterization read-only (không đổi public wire) → không cần COMP-00,
không va chạm lease. Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai,
ADMIN fallback, list-no-resolve, plaintext fallback, fake CANCELLED).
Không tick gate. Không commit thay đổi lane khác. Không nhắm nocobase-10.
Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
DEV TEST ISOLATION (lane này zero infra nên không cần).

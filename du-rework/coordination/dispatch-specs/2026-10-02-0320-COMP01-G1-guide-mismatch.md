# COMP01-G1 — guide `/api/v1/extract` mismatch (read-only supplement)

## Mục tiêu

CONSOL receipt (§4 G-1) đo được: mismatch guide mà COMP-01 nêu tên
(guide `/api/v1/extract` vs route thật `/api/v1/docs/extract`) VẮNG MẶT
trong cả 8 slice receipts (0 occurrences `06b`/`api-spec-overview`).
Slice bổ sung duy nhất để đóng G-1.

## Được phép làm

1. **Read-only:** tìm guide nào mang path sai (`06b`? `api-spec-overview`?
   docs/06? README?), ghi file:line cả hai phía (claim sai + route thật
   trong registry/route files). Đọc receipts A/C/E để khỏi trùng.
2. Kết luận: cùng defect với CM-A1 (route comments) hay defect riêng.
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

Receipt → `coordination/reports/` (`qwen-comp01-g1-guide-mismatch-2026-10-02.md`):
guide file:line + route thật file:line + verdict (same-as-CM-A1 / separate).

## COMMON

Task characterization read-only (không đổi public wire) → không cần COMP-00,
không va chạm lease. Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai,
ADMIN fallback, list-no-resolve, plaintext fallback, fake CANCELLED).
Không tick gate. Không commit thay đổi lane khác. Không nhắm nocobase-10.
Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
DEV TEST ISOLATION (lane này zero infra nên không cần).

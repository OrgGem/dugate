# COMP01-G7 — schema lifecycle trace end-to-end (read-only characterization)

## Mục tiêu

Đóng CONSOL G-7: "Schema CRUD is field-level, but the run path is not traced."
Trace MỘT schema từ import → trigger → result artifact, characterization-only.
P9-04 owns schema-workflow product decision — receipt này không quyết gì.

## Được phép làm

1. **Read-only:** xuất phát từ citations có sẵn (G §1.4 UI caller, A §3 + C §4
   run routes, slice-G receipt), đọc source chỉ để nối mạch lifecycle:
   import/validate (`validateSchema`, `WorkflowSchema`), trigger route,
   runner execution, result artifact. Ghi file:line mỗi hop.
2. Ghi rõ chỗ nào đứt mạch (không trace được → gap, không đoán).
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
(`qwen-comp01-g7-schema-lifecycle-2026-10-02.md`):
mạch import→trigger→artifact có file:line + danh sách điểm đứt (gap).

## COMMON

Task characterization read-only (không đổi public wire) → không cần COMP-00,
không va chạm lease. Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai,
ADMIN fallback, list-no-resolve, plaintext fallback, fake CANCELLED).
Không tick gate. Không commit thay đổi lane khác. Không nhắm nocobase-10.
Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
DEV TEST ISOLATION (lane này zero infra nên không cần).

# COMP01-G34 — binary side-by-side + per-route error matrix (receipts-only synthesis)

## Mục tiêu

Đóng CONSOL G-3 + G-4 mà không cần đọc source: mọi citation đã có trong tay
(C §2 delivery-encryption branch, D §2 legacy download, H §3.1 S3-vs-local,
CM-D4 two envelopes + per-receipt route lists).

## Được phép làm

1. **Synthesis từ receipts trong tay (ưu tiên, không bắt buộc đọc source):**
   - G-3: một hàng mỗi binary surface — legacy `download` vs rework
     `/artifacts/{id}/download` (content-type, filename, encryption envelope).
   - G-4: ma trận per-route error shape (route × envelope nào × fields nào).
2. Nếu citation thiếu mới được đọc source read-only để bù đúng chỗ thiếu
   (ghi rõ chỗ nào phải bù).
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
(`qwen-comp01-g34-binary-error-matrix-2026-10-02.md`):
binary side-by-side table + per-route error matrix + danh sách citation thiếu
(nếu có).

## COMMON

Task characterization/synthesis (không đổi public wire) → không cần COMP-00,
không va chạm lease. Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai,
ADMIN fallback, list-no-resolve, plaintext fallback, fake CANCELLED).
Không tick gate. Không commit thay đổi lane khác. Không nhắm nocobase-10.
Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
DEV TEST ISOLATION (lane này zero infra nên không cần).

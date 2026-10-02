# COMP00-BRIEF — đối chiếu evidence receipts với 5 quyết định COMP-00 (read-only, KHÔNG quyết thay)

## Mục tiêu

Đọc decision block COMP-00 + toàn bộ receipts hiện có, cho ra bảng
"quyết định nào đã đủ evidence, quyết định nào còn thiếu gì" để Product/architect/security
chốt. KHÔNG tự ra quyết định, KHÔNG đề xuất design, KHÔNG code.

## Được phép đọc (read-only tuyệt đối)

- `tasks/API-COMPAT-DUGATE-2026-09-28.md` §"Quyết định bắt buộc trước khi giao code (COMP-00)"
  — 5 quyết định: #1 path owner (đã chốt nguyên tắc), #2 scope 31 variants + 3 workflows
  (đã chốt phạm vi tối thiểu), #3 result materialization, #4 lifecycle, #5 encryption.
- 8 receipts COMP-01: slice-B (profile/connector matrix), slice-C (output/business-action),
  slice-D (lifecycle/pagination), slice-E (webhook/callback), slice-F (encryption touchpoints),
  slice-G (schema/services/billing), slice-H (file/url ingestion — đang second-pass,
  dùng bản hiện có), slice-A nếu tìm thấy.
- 2 receipts FUNCTEST (A: 59/59 xanh; B: 102/104 + 2 đỏ có file:line).
- `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` §MISMATCH nếu cần cross-ref.

## Cấm

- KHÔNG chốt/tick/đổi bất kỳ quyết định COMP-00 nào (quyền của Product/architect/security).
- KHÔNG đề xuất thiết kế wire/schema mới (đó là COMP-02, đang BLOCKED-COMP-00).
- KHÔNG đọc sâu source để tự verify code (theo self-review-plan §0 — chỉ dùng receipts + plan/tasks).
- KHÔNG sửa bất kỳ file nào ngoài receipt của chính mình; không đụng `tasks/*.md`,
  `AGENTS.md`, execution overlay, lockfile, `server.ts`, `contracts/src`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (chỉ trích factual đã có trong receipts).

## Acceptance

Receipt → `coordination/reports/` (`qwen-comp00-evidence-brief-2026-10-02.md`):

1. Bảng 5 quyết định × (evidence đã có từ receipt nào / còn thiếu gì / ai cần cung cấp).
   Riêng #1/#2 "đã chốt": liệt kê evidence củng cố, không mở lại.
2. Danh sách open questions cho COMP-00 (kế thừa từ receipts: next_page_token dialect,
   balance âm, set-vs-exact filter, POST-upsert, v.v.) — gom, không trả lời thay.
3. Khuyến nghị thứ tự cung cấp evidence còn thiếu (test/fixture/inventory nào trước).

## COMMON

Task tổng hợp read-only (không sửa file, không chạy infra) → không cần COMP-00,
không va chạm lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có
COMP-00). Exclusive lease không áp dụng. Không tái hiện lỗi bảo mật legacy
(x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
fake CANCELLED). Không tick gate. Không commit thay đổi lane khác. Không nhắm
nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.

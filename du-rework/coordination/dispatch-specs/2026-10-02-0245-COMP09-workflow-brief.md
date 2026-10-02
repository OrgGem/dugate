# COMP09-WORKFLOW-BRIEF — gom evidence workflow cho COMP-09/PAR00-J05 (read-only, KHÔNG map thay)

## Mục tiêu

Gom toàn bộ evidence liên quan workflow (3 workflows `disbursement`/`lc-checker`/`doc-compare`,
schema workflow, schemaSlug mapping) từ receipts + plan thành brief readiness cho
COMP-09 (mapping) và PAR00-J05 (schema catalog), khi COMP-00 mở. KHÔNG tự map,
KHÔNG code.

## Được phép đọc (read-only tuyệt đối)

- Receipts: slice-E (webhook divergence pipeline vs workflow + per-node callback),
  slice-G (schema CRUD V1–V8, workflow schema, G-ledger), slice-C nếu có phần workflow.
- `tasks/API-COMPAT-DUGATE-2026-09-28.md` dòng 112–115 (4 phát hiện workflow:
  selector `input.schemaSlug` ghi đè, identity qua FORM + ADMIN fallback,
  3 workflow mapping ABSENT, doc-compare 1-file vs ≥2 yêu cầu) + dòng `COMP-09`
  (READY-BUSINESS; public mount blocked).
- `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` J05 + PAR00-M04.

## Cấm

- KHÔNG tự map `process→business/action` hay `schemaSlug→schema business`
  (đó là COMP-09, chờ COMP-00 mở + business owners P9-01..04).
- KHÔNG đề xuất route/endpoint/schema mới.
- KHÔNG đọc sâu source để tự verify code (chỉ dùng receipts + tasks/plan).
- KHÔNG sửa bất kỳ file nào ngoài receipt của chính mình; không đụng `tasks/*.md`,
  `AGENTS.md`, execution overlay, lockfile, `server.ts`, `contracts/src`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- MUST-NOT-REPLICATE khi trích dẫn: selector-override, ADMIN fallback, identity qua
  form — chỉ ghi nhận factual, không mô tả cách tái hiện chi tiết.

## Acceptance

Receipt → `coordination/reports/` (`cmdcomp09-workflow-brief-2026-10-02.md`):

1. Bảng 3 workflows × (evidence behavior từ receipts / mapping status ABSENT /
   constraint đã biết: selector-integrity, identity, file-count).
2. Bảng schema workflow (CRUD/import/versioning từ slice-G) × gap cho PAR00-J05.
3. MUST-NOT-REPLICATE list cho COMP-09 (kế thừa dòng 112–115 + slice-E/G).
4. Điều kiện mở COMP-09 (COMP-00 + P9-01..04 + contract freeze) — liệt kê, không tự mở.

## COMMON

Task tổng hợp read-only (không sửa file, không chạy infra) → không cần COMP-00,
không va chạm lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có
COMP-00; public mount của COMP-09 vẫn BLOCKED). Exclusive lease không áp dụng.
Không tái hiện lỗi bảo mật legacy (x-api-key-id tự khai, ADMIN fallback,
list-no-resolve, plaintext fallback, fake CANCELLED). Không tick gate. Không
commit thay đổi lane khác. Không nhắm nocobase-10. Không sửa AGENTS.md,
tasks/README.md, execution overlay. Evidence là đầu vào quyết định, không phải blocker.

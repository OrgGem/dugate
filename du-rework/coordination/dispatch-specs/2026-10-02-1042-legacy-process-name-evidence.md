# Legacy workflow `process` names — evidence memo (READ-ONLY) cho câu hỏi Product Q1

## Bối cảnh

Spec integration `codex-p9-workflow-integration-spec-2026-10-02.md` §5-Q1 cần Product chốt:
`process` identifiers nào thuộc route workflow — 3 tên resolver hiện có (`simple-extraction`,
`multi-step-analysis`, `transform-compare`), 3 business mới (`lc-checker`, `disbursement`,
`doc-compare`), hay một tập pin khác. Task này gom **bằng chứng legacy** để trả lời có căn cứ.

## Mục tiêu (read-only)

1. **Legacy thực tế chấp nhận `process` nào**: trace `app/api/v1/docs/workflows/route.ts` +
   `lib/endpoints/registry.ts` (workflow sub-cases) + `lib/pipelines/workflow-engine.ts` +
   `lib/workflow-builder/**` — liệt kê MỌI giá trị `process`/workflow identifier mà code legacy
   có thể route tới, file:line, và mỗi cái chạy recipe/builder nào.
2. Xác định: legacy workflow nào **khách hàng thật đang dùng được** (không chỉ có code):
   test legacy nào gọi process nào (grep tests/ + app/), docs nào mô tả.
3. Bảng đối chiếu: legacy process name → cơ chế (registered workflow? schema-driven?) → khớp với
   business mới nào (`lc-checker`/`disbursement`/`doc-compare`) nếu có → ghi chú mismatch/alias.
4. **Options memo**: 2-3 phương án mapping tên process (giữ tên cũ làm alias / dùng tên mới / cả hai),
   kèm ưu-nhược + rủi ro compat — KHÔNG tự chọn, đây là decision support cho Product.

## Ranh giới

- READ-ONLY: chỉ ghi `coordination/reports/codex-legacy-process-name-evidence-2026-10-02.md`;
  không sửa source/docs/tasks; không tick gate; không commit; không đề xuất wire change (COMP-00).
- KHÔNG đụng `document-core/**` (qwen_4 giữ D5) — chỉ đọc. Không nhắm `nocobase-10`.

## Acceptance

- Bảng process values đầy đủ file:line + evidence khách-hàng-dùng-được + options memo.
- Ghi rõ phần nào là suy luận vs đọc trực tiếp.

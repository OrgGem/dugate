# Dispatch spec — ACQ-PREP RECEIPT AUDIT (cc_2, read-only) — 2026-10-04 20:10 +07

- **Owner:** cc_2 — `term_ee7e9f33` · READ-ONLY (pattern W1 receipt audit của cc_1).
- **Nguồn:** `p730-acquisition-prep-2026-10-04.md` (qwen_4, landed 19:47; 5 Δ; Δ2 đã được coordinator adjudicate: **CẤM raw secret trong URL query** — deny/redact có chủ đích).

## Việc cần làm

1. **Claims ↔ artifacts**: các mục trong receipt (đường resolve ref/decrypt, ingestion-consumer lines, extension map, release list) đối chiếu code hiện tại — `file:line` thật, khớp mô tả.
2. **Release list an toàn**: files đề xuất tồn tại; không xung đột 2-writer; `profiles.ts` giữ read-only; file-url-auth chỉ khi cần + rerun coupling tests (ghi rõ điều kiện).
3. **Δs**: 5 Δ có well-formed + severity hợp lý; Δ2 khớp decision của coordinator; Δ khác cần adjudicate thì liệt kê.
4. Limitations + phần không kiểm được.
5. Receipt **MỚI**: `coordination/reports/acq-prep-receipt-audit-2026-10-04.md` (bảng claim/verdict + đề xuất).

## Constraints

- READ-ONLY; không sửa source/test/plan; không tick/commit.

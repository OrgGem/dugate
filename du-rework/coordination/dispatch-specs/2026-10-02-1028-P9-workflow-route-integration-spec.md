# P9 workflow-route integration spec (READ-ONLY) — mở đường cho wave implementation

## Bối cảnh

`POST /api/v1/docs/workflows` + `/schema` hiện **503** ("chưa chạy thật" — RV01 route-wiring; P9-02 verify:
route mounted → 503, **0 hit lc-checker trong server.ts**). D5 đã được giao song song cho phần registration
doc-core (xem spec `2026-10-02-1028-D5-doc-compare-registration.md`); task này chuẩn bị **change list chính xác**
cho phần còn lại — để wave sau implement với **1 writer duy nhất trên server.ts**.

## Nội dung bắt buộc (read-only)

1. **Trace đường workflow trong `server.ts`**: mount route (file:line), handler, và **chính xác điều kiện nào
   trả 503** (thiếu registry? thiếu workflow dispatcher? thiếu schema interpreter? thiếu business map?). Cite file:line từng bước.
2. **Đối chiếu 3 business đã land**: `businesses/lc-checker/` (mới — receipts `qwen-p9-02-lc-checker-*`, `tester-p9-02-verify-*`),
   `disbursement` + `doc-compare` trong `businesses/document-core/`. Cái nào đã đăng ký/mount được vào đường workflow, cái nào chưa —
   dùng D5 probe (`codex-d5-scope-probe-doc-compare-registration-2026-10-01.md`) làm nguồn phần doc-core, không lặp lại mapping của nó.
3. **Change list tối thiểu**, từng mục: file:line → thay đổi → owner đề xuất → phân loại
   `server.ts (serialize — 1 writer)` / `document-core` / `connector (task names OPEN)` / `contracts (KHÔNG đổi wire)`.
4. **Rủi ro + thứ tự thực hiện + acceptance/fixture đề xuất** cho wave implementation (kể cả thứ tự với D5 đang chạy).
5. Nêu rõ **open questions** cần Product/architect (nếu có) — không tự quyết.

## Ranh giới

- READ-ONLY: chỉ ghi **1 report mới** `coordination/reports/codex-p9-workflow-integration-spec-2026-10-02.md`;
  không sửa source/test/config/tasks/gates; không chạy infra; không tick gate; không commit.
- KHÔNG đề xuất thay đổi public wire (thuộc COMP-00). KHÔNG nhắm `nocobase-10`.

## Acceptance

- Report với change list file:line đầy đủ + open questions; kết luận "đủ để implement" hoặc chỉ rõ thiếu gì.
- Không code, không tick gate.

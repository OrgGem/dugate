# WORKER-SPLIT-PREP — chuẩn bị quyết định tách `worker.ts` (READ-ONLY)

## Bối cảnh

Guard CONV-00 phát hiện `businesses/document-core/src/worker.ts` đã vượt 2.000 dòng (**2.023** sau D5 +605).
User chưa quyết: **exemption tạm** hay **tách file**. Task này là prep read-only để quyết định có bằng chứng — không tách, không sửa.

## Mục tiêu

1. **Inventory `worker.ts` hiện tại**: các khối chức năng (imports, handler map, per-action handler blocks của 7 action + disbursement/doc-compare, helpers),
   số dòng từng khối (đo thật), mức phụ thuộc chéo giữa các khối.
2. **Đề xuất phương án tách** (2–3 option): ví dụ trích per-action handler blocks vào `src/handlers/{action}.ts` giữ `worker.ts` làm assembly;
   chỉ rõ ranh giới giữ nguyên (handler map, continuation semantics, durable path, không đổi export bề mặt nếu consumer đang import).
3. **Rủi ro + effort** mỗi option (theo số bề mặt file, không ước lượng thời gian); điều kiện tiên quyết (D5/D5B/D5C files đang modified — ghi chú trạng thái).
4. **Khuyến nghị** + 2 lựa chọn cho user: (A) exemption tạm (điền vào exemption map của guard — kèm hệ quả) vs (B) tách theo option đề xuất.
5. Nêu rõ phần không xác định được (nếu có).

## Ranh giới

- READ-ONLY: chỉ ghi `du-rework/coordination/reports/qwen-worker-split-prep-2026-10-02.md`; KHÔNG sửa source/test/guard;
  không tick gate; không commit; không nhắm `nocobase-10`.

## Acceptance

- Bảng khối + dòng; options + rủi ro + khuyến nghị; không code.

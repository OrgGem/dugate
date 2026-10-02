# Connector capability / task-name enforcement — options memo (READ-ONLY)

## Bối cảnh

Receipt `qwen-connector-bindings-inventory-2026-10-02.md` (chính lane này) đã chứng minh:
**F1** `acceptedCapabilities` trong manifest **không được enforce ở bất kỳ đâu**; **F2** vocab connector (`json`/`multipart`)
≠ vocab manifest (`chat-completion`, `structured-output`, `ocr`, `vision`…); **task name** không có registry — chuỗi thô ra
provider body (`adapters/http.ts:49,93`); **F5** không seed nào cho 9 slot P9.

## Mục tiêu

Options memo (kèm khuyến nghị + blast radius + effort) cho 3 gap, **không implement**:

1. **acceptedCapabilities:** (a) enforce tại `grants.ts` khi resolve slot (cần map/bổ sung vocab — nêu cách map hợp lý);
   (b) bỏ field khỏi manifest nếu không bao giờ enforce (honesty — nêu chi phí/ảnh hưởng);
   (c) giữ nguyên + document "advisory only". Mỗi phương án: hệ quả + compat notes + effort.
2. **Task name:** (a) registry/allowlist tại connector; (b) validate tại worker-sdk/grants theo danh sách per-connector;
   (c) giữ thô + document. Nêu rủi ro hiện tại (typo → provider 4xx runtime, lỗi mơ hồ — ví dụ cụ thể nếu có).
3. **Slot seeds cho 9 slot P9:** quy trình vận hành đề xuất (checklist nhập liệu connector + revision pins) — không phải code.

## Ranh giới

- READ-ONLY: chỉ ghi `coordination/reports/codex-connector-enforcement-options-2026-10-02.md`; không sửa code/config;
  không tick gate; không commit; không in giá trị secret nào.

## Acceptance

- Memo: mỗi gap có 2–3 phương án + khuyến nghị + open questions cho Product/architect; mọi khẳng định có file:line.

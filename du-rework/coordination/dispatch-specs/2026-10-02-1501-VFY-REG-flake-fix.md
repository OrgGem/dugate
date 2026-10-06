# VFY-REG-FLAKE-FIX — khử phụ thuộc tải cho `parser-budgets` timeout (TEST-ONLY)

## Bối cảnh

`tester-vfy-reg-flake-check-2026-10-02.md` chứng minh: 2 test timeout 5s trong `tests/parser-budgets.test.ts`
(ở `tester-vfy-reg-refresh`) **không tái hiện** khi chạy riêng — chi 456–908 ms cho 2 test từng timeout (margin ~11x);
file là **init-dominated** (buffer 100–101 byte), variance 2x giữa 2 lần liền kề; full suite solo đạt **924+1skip/925, exit 0**.
Receipt khuyến nghị: de-flake bằng thời gian/khởi động — **KHÔNG đổi assertion**.

## Mục tiêu

1. Chọn can thiệp **tối thiểu**: ưu tiên **warm-up parser trước đoạn đo** (giữ timeout 5s nghiêm ngặt);
   nếu warm-up không khả thi mới cân nhắc nâng timeout cho riêng file — kèm lý do định lượng.
2. **Không đổi/không nới assertion; không bỏ test**; diff chỉ trong `tests/parser-budgets.test.ts`.
3. Chứng minh: chạy riêng file **≥2 lần** + **full document-core suite 1 lần** — tất cả exit 0 (ghi literal, before/after).
4. Ghi rõ giới hạn: không tái tạo được điều kiện tải gốc; fix nhằm giảm false-red dưới tải.

## Ranh giới

- Chỉ `tests/parser-budgets.test.ts`; không đụng `src/`; không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/qwen-vfy-reg-flake-fix-2026-10-02.md`.

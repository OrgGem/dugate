# VFY-REG-FLAKE-CHECK — rerun riêng `parser-budgets.test.ts` (READ-ONLY)

## Bối cảnh

`tester-vfy-reg-refresh-2026-10-02.md` ghi doc-core exit 1 với **2 timeout 5s** trong `tests/parser-budgets.test.ts`
(cả 2 test "exceeded Jest's 5,000 ms timeout") chạy **song song** với suite khác đang chạy trên máy.
Lịch sử: timeout tương tự từng xuất hiện khi chạy chồng tải và không tái hiện khi chạy riêng (ghi trong `codex-conv06-impl` receipt).

## Mục tiêu

1. Chạy **riêng** `tests/parser-budgets.test.ts` từ `D:\Git\dugate\du-rework` (không chạy song song suite khác):
   `pnpm --filter @du/document-core test -- tests/parser-budgets.test.ts --runInBand` — ghi literal.
2. Nếu pass → chạy lần 2 để xác nhận ổn định; ghi literal.
3. Nếu vẫn fail → đọc test + code liên quan (bounded), nêu nguyên nhân khả dĩ (timing/CPU vs logic), ghi rõ KHÔNG klaim regression nếu chưa đủ bằng chứng.
4. Cập nhật so sánh với VFY-REG-refresh (922+2F+1skip).

## Ranh giới

- READ-ONLY; không sửa test/code; không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-vfy-reg-flake-check-2026-10-02.md`.

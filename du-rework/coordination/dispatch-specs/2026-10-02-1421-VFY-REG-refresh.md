# VFY-REG refresh — offline regression trên build hiện tại (từ packet `DETAILED-BUSINESS-VERIFICATION-2026-10-01.md`)

## Bối cảnh

VFY-REG (row `[ ]`, owner RV01-08 + doc-core/Worker SDK) từng FAIL/BLOCKED trên **build cũ** (`tester-vfy-reg-offline-2026-09-…`/`tester-vfy-reg-offline-2026-10-02.md`:
doc-core 2 red do thiếu PG/Redis). Kể từ đó: guard `DU_LIVE_INFRA` đã vào doc-core **và** connector p8-03; CONV-06 vừa đổi worker-sdk + 2 business (verify riêng đã xanh).
Task này **refresh VFY-REG offline** trên build hiện tại.

## Mục tiêu

1. Chạy trên working tree hiện tại (ghi HEAD + cwd): `pnpm --filter @du/document-core test` + `pnpm --filter @du/worker-sdk test`
   (offline: `DU_LIVE_INFRA` unset; DATABASE_URL trỏ port đóng nếu cần) — ghi literal counts/exit; đối chiếu mốc mới nhất (doc-core 924+1skip/925; worker-sdk 650/650).
2. Chạy các targeted producer/consumer tests liên quan **cancellation/AbortSignal metadata adapter** (tìm theo từ khóa; nếu không tồn tại rõ ràng → ghi rõ thay vì bịa).
3. Cập nhật verdict VFY-REG offline: PASS/BLOCKED + so sánh với receipt cũ; nêu rõ phần live/infra nào vẫn là gap.
4. KHÔNG sửa gì; nếu có red mới → nói thẳng, không mask.

## Ranh giới

- READ-ONLY; không tick gate (VFY-REG là row `[ ]` — không tự tick); không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-vfy-reg-refresh-2026-10-02.md`.

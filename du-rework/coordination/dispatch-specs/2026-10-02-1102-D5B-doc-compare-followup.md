# D5b — doc-compare follow-up: Δ4 alignment fix + P9-01 stale comment + Δ2 disposition

## Bối cảnh

D5 đã settled (`qwen-d5-doc-compare-registration-2026-10-02.md`). Lease `doc-compare/**` mở lại cho lane này
(single writer document-core). **Coordinator decisions trên các OPEN của D5:** Δ5 (barrel export `index.ts`) —
**giữ** (khớp pattern disbursement; revert 1 dòng nếu sau này cần); Δ1 connector task names — **vẫn OPEN**, không đổi;
Δ3 (`p8-03` red) — lane khác xử lý; Δ6 no live — chấp nhận offline-only đợt này.

## Mục tiêu

1. **Δ4 — fix bug lệch toạ độ chunk (đã đo, không phải arithmetic):** `planChunks` cộng offset theo
   body-space (không tính heading) nhưng `sliceChunkText` cắt `side.text` (có heading) → chunk gửi provider
   lệch và **mất đuôi text** (ví dụ đo được: `endOffset 42` cắt nhầm span 54 ký tự). Chọn hướng fix
   **không làm mất nội dung** — (a) slice theo body-space, hoặc (b) cho `planChunks` phát offset text-space —
   sao cho các chunk **phủ trọn** văn bản so sánh; cập nhật test trung thực (kể cả assertion
   `endOffset toBe(5000)` ở `p9-03-doc-compare.test.ts:248` nếu nó mã hoá hành vi sai — ghi rõ lý do);
   thêm regression test: ghép chunk **tái tạo đầy đủ** text (không mất ký tự ranh giới).
   Ghi quyết định (a)/(b) + lý do trong receipt.
2. **P9-01 close-out:** comment stale quanh `document-core.manifest.ts:241-242` (nói host dispatch wiring
   còn pending trong khi worker đã đăng ký + D5 xong) — đọc **dòng hiện tại** (D5 đã đổi file), sửa comment
   cho đúng hiện trạng; **không đổi code/hành vi**; chạy manifest test.
3. **Δ2 — `runChunkChildren` trả `joinToken: ''`** không thoả `takeJoin`; helper không caller. Quyết định tối thiểu:
   sửa helper cho nhất quán (nếu trivial + test) **hoặc** để nguyên + comment cảnh báo rõ. Ghi lựa chọn + lý do.

## Ranh giới (tuyệt đối)

- Chỉ: `pipelines/workflows/doc-compare/**`, `manifest/document-core.manifest.ts` (comment), `worker.ts` (comment nếu cần),
  tests liên quan. **KHÔNG** chạm `disbursement/**`, `actions/compare/**`, `server.ts`, contracts, gates; không đổi wire.
- KHÔNG tick gate; KHÔNG commit; 31 variant giữ nguyên; không nhắn `nocobase-10`.

## Acceptance

- Focused 8-suite (đúng lệnh D5 §4) → 0 red, exit 0.
- Full document-core → ghi literal counts; kỳ vọng chỉ còn `p8-03` red pre-existing (nếu fix Δ4 làm count đổi, ghi rõ).
- `tsc --noEmit` doc-core + orchestrator → exit 0.
- Receipt: `coordination/reports/qwen-d5b-doc-compare-followup-2026-10-02.md` (diff tóm tắt + số liệu + quyết định).

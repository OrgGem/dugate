# WTV-03 — Verify RFX crypto (RFX-01/02/08/16) — READ-ONLY + được chạy test

**Packet:** wtv03-crypto-verify | **Lane:** cc_1 | Dispatch 2026-10-03T13:52+07:00 (coordinator command-code).

**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` row WTV-03; `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` rows RFX-01/02/08/16; receipts tham khảo (không dùng làm bằng chứng): `qwen-rfx-crypto-2026-10-02.md`, `tester-rfx-crypto-verify-2026-10-03.md`.

**Việc:**
1. **RFX-01** (AES-GCM AAD): tamper từng phần (header/AAD/ciphertext/tag) → decrypt **fail tag**, không nhận nhầm; round-trip đúng. Đọc code + chạy focused suite liên quan.
2. **RFX-02** (`policy.suite`): matrix RSA/X25519 × pin/compat → suite không khớp phải **fail-closed** (`DELIVERY_SUITE_INCOMPATIBLE`); không bỏ qua lặng lẽ.
3. **RFX-08** (bound collect): vượt ngưỡng → fail-closed đúng loại lỗi (`SIZE_LIMIT` → caller mapping 413, xem `artifact-read-decrypt.ts:113-123`); trần RSS có bằng chứng (tái lập cách đo nếu chạy được).
4. **RFX-16**: rationale đã ghi comment (design note) — xác nhận vị trí.
5. Chạy các focused crypto suite offline liên quan; ghi literal command/cwd/exit + pass/fail/skip.
6. Verdict: `CONFIRMED / DRIFT / KHÔNG KẾT LUẬN ĐƯỢC` + `file:line`; nêu rõ phần cần live.

**Ranh giới:** READ-ONLY (được chạy test). Chỉ ghi `du-rework/coordination/reports/wtv03-crypto-verify-2026-10-03.md`. Không sửa source/test; không tick; không commit; không chạm `nocobase-10`.

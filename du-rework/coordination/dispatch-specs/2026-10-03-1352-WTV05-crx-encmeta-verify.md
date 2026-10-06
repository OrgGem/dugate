# WTV-05 — Verify CRX / ENC-META seam (CRX-01, CRX-02, ENC-META-FIX-G1) — READ-ONLY + được chạy test

**Packet:** wtv05-crx-encmeta-verify | **Lane:** b103836b (Claude — review) | Dispatch 2026-10-03T13:52+07:00 (coordinator command-code).

**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` row WTV-05; `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md` (CRX-01/02); ENC-META-FIX-G1 (dispatch-spec `2026-10-03-0102-ENC-META-FIX-G1.md`).

**Việc:**
1. **CRX-01**: seal VALUE trước INSERT + re-seal ở ingestion READY + read qua cùng seam; absent-marker = plaintext lịch sử (không fail sai); kiểm bằng đọc code + chạy suite `crx01-*`.
2. **CRX-02**: S3 read guard bật đúng chỗ; chạy suite `crx02-*`.
3. **ENC-META-FIX-G1**: outbox `sourceUrl` được seal — đọc code + chạy suite `enc-meta-sentinel*`.
4. Chạy các suite liên quan offline; literal command/cwd/exit; xác nhận không vỡ replay/submission test hiện có (chạy nhóm liên quan).
5. Verdict `CONFIRMED / DRIFT / KHÔNG KẾT LUẬN` + `file:line`; nêu phần cần live S3.

**Ranh giới:** READ-ONLY (được chạy test) — KHÔNG sửa source/test/plan; chỉ ghi receipt `du-rework/coordination/reports/wtv05-crx-encmeta-verify-2026-10-03.md`. Không tick; không commit; không chạm `nocobase-10`.

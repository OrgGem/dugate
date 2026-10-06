# WTV-04 (offline phần) — Verify RFX upload/storage: RFX-03/05/14/15 — READ-ONLY + được chạy test

**Packet:** wtv04-upload-storage-verify | **Lane:** cc_2 | Dispatch 2026-10-03T14:01+07:00 (coordinator command-code).

**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` row WTV-04; `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` rows RFX-03/05/14/15. **Live-S3 rows (03/05/09/13 phần live) chỉ được báo cáo là gap — không đóng, không giả live.**

**Việc (offline được):**
1. **RFX-03 (P0, ưu tiên cao nhất)** — "public multipart ghi PLAINTEXT thẳng S3, bypass encryption gateway". Xác định **hiện trạng trên worktree**: write path còn tồn tại không? Decision nào đã thi hành (chặn vs seal)? Đọc `multipart-service.ts` + `upload-encryption-gateway.ts` + call site; nếu path plaintext còn sống → ghi rõ là **BLOCKER chưa đóng** kèm `file:line`; nếu đã bị chặn/seal → bằng chứng.
2. **RFX-05** — manifest sidecar pin `VersionId` khi ghi/verify + delete đúng version (phần offline; live versioned-bucket evidence ghi là gap).
3. **RFX-14** — integrity-scanner single-flight + cancel (withDeadline không cancel tác vụ nền — verify đã sửa chưa).
4. **RFX-15** — grant token: transport mới hoặc TTL/single-use + log-redaction (receipt `cc-conv13-rfx15` là của lane khác — tự re-derive; note nếu single-use/TTL có test).
5. Chạy focused suite offline liên quan (gateway/multipart/migration/scanner); literal command/cwd/exit.
6. Verdict từng row: `CONFIRMED / DRIFT / CÒN MỞ (blocker) / KHÔNG KẾT LUẬN` + `file:line` + phần cần live S3.

**Ranh giới:** READ-ONLY (được chạy test). Chỉ ghi `du-rework/coordination/reports/wtv04-upload-storage-verify-2026-10-03.md`. Không sửa source/test; không tick; không commit; không chạm `nocobase-10`.

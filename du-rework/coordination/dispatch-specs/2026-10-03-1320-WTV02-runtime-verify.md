# WTV-02 — Independent verify CONV-07 (`runtime.test.ts` split) — READ-ONLY + được chạy test

**Packet:** wtv02-runtime-split-verify | **Lane:** cc_2 | Dispatch 2026-10-03T13:20+07:00 (coordinator command-code).

**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` row WTV-02; `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` CONV-07. Receipt gốc `coordination/reports/cc-conv07-2026-10-03.md` là của lane khác — **không dùng làm bằng chứng**, tự re-derive.

**Việc:**
1. Đếm **TEST IDs + assertion count** TRƯỚC (`git show HEAD:du-rework/services/orchestrator/tests/runtime.test.ts`) / SAU (worktree: `runtime.test.ts` + `runtime-*.test.ts` + `helpers/runtime-harness.ts`) — chứng minh không giảm.
2. Skip guard `DU_LIVE_INFRA` giữ nguyên semantics; cleanup chỉ xóa namespace của suite; 2 file chạy song song không port/DB collision.
3. Chạy từng file test **độc lập** phần offline được + `tsc --noEmit`; ghi literal command/cwd/exit.
4. Verdict `IDENTICAL / DRIFT` + danh sách drift + phần chưa chứng minh được offline (nói rõ).

**Ranh giới:** READ-ONLY (không sửa source/test). Chỉ ghi `du-rework/coordination/reports/wtv02-runtime-split-verify-2026-10-03.md`. Không đụng `server.ts`; không tick; không commit; không chạm `nocobase-10`.

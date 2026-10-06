# Dispatch spec — W1 DESIGN REVIEW (Part 1, read-only, KHÔNG verdict) — 2026-10-04 19:01 +07

- **Owner:** Claude Code (`term_19edcad8`) — **REVIEW-ONLY** theo `du-rework/AGENTS.md` + user directive 17:18 + topology. Packet này chỉ review: **KHÔNG sửa code/test/docs**, không commit, không tick.
- **Run:** `run_069ecd6957cd` · Bối cảnh: qwen_1 báo `W1 CHECKPOINT (b) HOÀN TẤT` (18:55) — producer W1 done; verify độc lập W2-B + receipt audit đang chạy.

## Scope (đọc)

1. `coordination/reports/qwen1.md` mục **W1-1 (audit)** + **W1-2 (implement/verify)**.
2. Các file đã đổi: `modules/operations/submission.ts` (snapshot build thay `JSON.stringify`), `packages/contracts/src/runtime.ts` (strict DTO), `modules/profiles/file-url-auth.ts` (guard nối dây), tests mới `tests/w1-sub02-snapshot-secret.test.ts` + `tests/w1-sub03-sourceurl-extension.test.ts`.
3. Đối chiếu acceptance **PLAN04-01** (`tasks/PLAN-COMPLETION-2026-10-04.md` §2): snapshot non-secret + ref bất biến; fail-closed; extension paths; giữ F-PP1.

## Deliverable

- Receipt **MỚI**: `coordination/reports/w1-review-part1-2026-10-04.md` — findings/risks theo severity (HIGH/MED/LOW) + câu hỏi + phần không kiểm được trong Part 1.

## Verdict & limits

- **KHÔNG đưa verdict acceptance** trong Part 1 — đó là **Part 2** (sau khi W2-B + audit độc lập xong; coordinator sẽ gửi full review packet).
- READ-ONLY: được đọc/đối chiếu; không sửa gì; không chạy lệnh ghi.

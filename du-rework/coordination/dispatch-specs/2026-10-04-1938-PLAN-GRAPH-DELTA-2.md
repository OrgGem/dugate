# Dispatch spec — PLAN-GRAPH-DELTA-2 re-scan (cc_1) — 2026-10-04 19:35 +07

- **Owner:** cc_1 — `term_c03791d1` · **READ-ONLY**
- **Nguồn:** `plan-refresh-736-740-2026-10-04.md` (land 19:29 — fold N1–N4 + PLAN-COMPLETION §8 + README/PLAN-COMPLETION/AWEB/CFGADM/LPG edits).

## Việc cần làm

1. Re-scan plan suite **sau refresh delta** (phương pháp của bạn): link/anchor/ID/status/overclaim — snapshot pin mới.
2. **L2-remainder** (33 dòng bare `PAR-##` ở README/WTV/CFGADM/LPG từ receipt `plan-merge-verify-1`): refresh có chạm không? Verdict FIXED/STILL/PARTIAL.
3. Findings mới phát sinh từ chính delta (nếu có).
4. Receipt **MỚI:** `coordination/reports/plan-graph-delta-2-2026-10-04.md` — bảng item/verdict + phần checked-clean + limitations.

## Constraints

- READ-ONLY; chỉ ghi receipt mới; không tick/commit; re-anchor theo heading nếu dòng dịch.

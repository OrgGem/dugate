# Dispatch spec — L2-CLOSURE-RECHECK (cc_1, read-only) — 2026-10-04 19:52 +07

- **Owner:** cc_1 — `term_c03791d1` · READ-ONLY, micro.
- **Nguồn:** `plan-merge-fix-2-2026-10-04.md` (claim: 34 refs/33 dòng → ORCH-PAR; giữ PAR-XA; validator 210 links).

## Việc cần làm

1. Re-grep `(?<!ORCH-)PAR-\d+`: kỳ vọng **0 dòng** ở README/WTV/CFGADM/LPG (và 0 toàn suite) sau merge-fix-2; kiểm `PAR-XA-*` còn nguyên (ORCH-CONFIG 5, LPG 1).
2. Spot-check 2 pointer CURL Q (AWEB/CFGADM) tồn tại đúng nội dung đã chốt.
3. Link count: xác nhận 210 (hoặc số thực của bạn) — ghi literal.
4. Receipt **MỚI** (ngắn): `coordination/reports/l2-closure-recheck-2026-10-04.md`.

## Constraints

- READ-ONLY; không sửa; không tick/commit.

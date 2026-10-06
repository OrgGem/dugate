# Dispatch spec — PLAN-GRAPH-DELTA re-scan (cc_1, read-only) — 2026-10-04 18:40 +07

- **Owner:** cc_1 — `term_c03791d1-2f0a-4c30-afc1-533d28f193ea`
- **Run:** `run_069ecd6957cd` · Nguồn: `coordination/reports/plan-review-730-2026-10-04.md` §3 (P730-PLAN-MERGE: "cc_1 receipt scan sau delta") + receipt của bạn `plan-graph-validation-2026-10-04.md` (pin snapshot 18:25:51).

## Bối cảnh delta

Plan editor đã sửa **15 docs** lúc 18:16–18:28 (receipt plan-review-730 §6): `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` (mới — 12 CFGADM sub-packet), `PLAN-COMPLETION` (+P730 rows), `ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL`, README, topology pointers, LPG addendum pointers, v.v. Receipt cũ của bạn tự ghi "cây đang dịch chuyển — cần re-anchor sau delta".

## Việc cần làm

1. **Re-run validation SAU delta**: link resolve (relative + heading/line anchors), task ID trùng lặp, tham chiếu chết, row trạng thái mâu thuẫn receipt, tuyên bố vượt bằng chứng — trên cây hiện tại.
2. **Đối chiếu L1–L7 + M4 cũ**: cái nào plan editor đã sửa trong delta, cái nào còn open (bảng fixed/still-open).
3. Pin **snapshot đo** (thời điểm + mtime per-file) và nêu rõ phần nào là re-verify sau delta (không dùng scan trước delta để claim final).
4. Ghi receipt **MỚI**: `coordination/reports/plan-graph-delta-2026-10-04.md` (không sửa receipt cũ).

## Constraints

- **READ-ONLY**: chỉ ghi receipt mới; không tick, không commit/push; không sửa plan/docs/source.
- Lane rules: bảng findings severity + "checked-clean" section + limitations list.

## Acceptance

- Bảng findings sau delta (file:line + đề xuất, không thực thi) + đối chiếu L1–L7/M4 + pin snapshot + limitations.

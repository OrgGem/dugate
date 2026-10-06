# REGISTER-DELTA-VERIFY — re-anchor sau P730-PLAN-MERGE-FIX (READ-ONLY)

**Packet:** `coordination/dispatch-specs/2026-10-04-1920-REGISTER-DELTA-VERIFY.md` · **Lane:** cc_2 (`term_ee7e9f33-e20d-483d-8423-830f2924d90c`) · **Run:** `run_069ecd6957cd` (task `task_3af18a96b465`, dispatch `ctx_41e4151d9de4`).
**Date:** 2026-10-04 (+07). **Mode:** READ-ONLY — file duy nhất được ghi là receipt này; không sửa plan/docs; không tick; không commit/push; offline.
**Đối tượng:** N1–N4 trong `cfgadm-lpg-register-delta-2026-10-04.md` (cc_2, 19:0x) + `plan-merge-fix-2026-10-04.md` (codex_arch, land **19:06:49**).
**Snapshot đo:** ~19:10–19:20 +07. Pin: `README.md` **163 dòng / 19:02:16**; `PLAN-COMPLETION` **112 dòng / 19:02:17**; `ADMIN-LEGACY-CONFIG-PARITY` **18:27:24** (không đổi); `LEGACY-PARITY-GAP-ADDENDUM` **18:25:51** (không đổi); `ORCH-CONFIG` 19:02:17. Hash third-party (merge-fix receipt §2): README `cb398d73…`, PLAN-COMPLETION `4cb7caca…`, ORCH-CONFIG `e35edb80…` (POST_RECEIPT_SNAPSHOT_GUARD PASS).

---

## 0. TL;DR — verdict

| # | Finding | Cây hiện tại | Merge-fix scope | Đề xuất |
|---|---|---|---|---|
| N1 | LPG thiếu notice block trong README | **STILL** | **NOT-IN-SCOPE** (10 mục M/L không gồm) | Plan-touch kế tiếp |
| N2 | Wording "chưa dispatch" stale vs ledger | **STILL** | **NOT-IN-SCOPE** | Plan-touch kế tiếp |
| N3 | Mermaid thiếu CFGADM **và** LPG | **CFGADM: FIXED** (L3) · **LPG: STILL** | LPG phần = **NOT-IN-SCOPE** | LPG vào lượt plan-touch kế tiếp (cùng N1) |
| N4 | Release boundary chưa nêu CFGADM | **STILL** | **NOT-IN-SCOPE** | Plan-touch kế tiếp |

- Re-anchor inventory: **các kết luận row/definition/dedupe còn đúng**; citation README shift **+4 dòng** (mermaid thêm 4 node dòng); PLAN-COMPLETION giữ nguyên số dòng (101/108/110) với L2 đổi tên `ORCH-PAR-*`.
- Không phát hiện regression/overclaim mới từ merge-fix; không tick, không sửa.

---

## 1. Re-anchor spot-check (row / definition / citation / dedupe)

| Kết luận gốc (receipt 19:0x) | Kiểm lại sau merge-fix | Refs mới |
|---|---|---|
| Định nghĩa CFGADM-00..11 duy nhất tại `ADMIN-LEGACY-CONFIG-PARITY:85-96`, 12 row `[ ]` | **Đúng** — file mtime 18:27:24 (không bị chạm); merge-fix validator: `CFGADM_open_rows=12` | giữ `:85-96` |
| Định nghĩa ORCH-LPG-01/02 duy nhất tại `ADDENDUM:21,:54`, status `:5` | **Đúng** — mtime 18:25:51 (không bị chạm) | giữ `:21,:54` |
| README: CFGADM notice `:3` + phase row `:131` | **Đúng, shift +4**: phase row nay `:135`; notice `:3` không đổi; **mới**: mermaid nodes `:93-96` | `:135` (thay `:131`) |
| README: LPG chỉ có phase row `:132` | **Đúng, shift +4** → `:136`; vẫn **không** có notice/mermaid (N1/N3-LPG) | `:136` (thay `:132`) |
| PLAN-COMPLETION refs `:101` (§7 wording), `:108` (P730-CURL-IMPORT), `:110` (P730-LPG-DECISION) | **Số dòng không đổi**; nội dung `:108` nay `CFGADM-07, ORCH-PAR-14, ACUI-06/AWEB-05` (L2) | giữ `:101/:108/:110` |
| ORCH-CONFIG `:112` (PAR-15 ↔ CFGADM mapping cite) | **Vị trí không đổi**; các ref nội bộ nay chuẩn hóa `ORCH-PAR-*`; CFGADM cite còn nguyên (thêm `:149,:151` cùng nội dung ORCH-PAR + CFGADM) | giữ `:112` + mới `:149,:151` |
| LPG-ID citations chỉ 2 file tasks (`PLAN-COMPLETION`, `ADDENDUM`) | **Đúng** (grep `LPG-0[12]\|ORCH-LPG` = 2 file); README chỉ cite tên/link "LPG" | — |
| Dedupe: 0 duplicate declaration; out-of-range ID = 0 | **Đúng** — re-run `CFGADM-(1[2-9]\|[2-9]\d)\|LPG-(0[3-9]\|[1-9]\d)` = **0 file**; merge-fix validator `duplicate_task_definitions=0` (11 docs); node mermaid `CFGADM[...]` là graph label, không phải định nghĩa row | — |
| Gate mapping: 14 row `[ ]`/SPECIFIED, không overclaim | **Đúng** — checkboxes `checkboxes_unchanged=6`; không receipt nào claim CFGADM/LPG acceptance trong wave merge-fix | — |

**Merge-fix đã chạm gì (để đối chiếu):** README (L1 anchor `:43` bỏ — link qwen-docs giữ; L3 mermaid `:93-96`), PLAN-COMPLETION (L2/L4), AWEB (M3/L2/L5/L7), ORCH-CONFIG (L2), WTV (M2/L6), LIVE-TEST-PLAN (M4). **Không chạm:** `ADDENDUM`, `ADMIN-LEGACY-CONFIG-PARITY` — do đó N1/N2/N3-LPG/N4 nguyên trạng.

---

## 2. Verdict chi tiết N1–N4

### N1 — LPG không có notice block trong README → **STILL / NOT-IN-SCOPE**
- **Evidence nay:** khối notice `README:3-64` không có mục LPG; "LPG" chỉ xuất hiện tại phase row `:136`. Merge-fix 10 mục M2/M3/M4/L1–L7 không mục nào nhắc notice LPG → ngoài scope có chủ đích.
- **Đề xuất (plan-touch kế tiếp, không tự sửa):** thêm 1 notice block ngắn cho addendum LPG (đối xứng CFGADM `:3`/AWEB `:7`/LIV `:9`) **hoặc** ghi nhận chính thức rằng phase row `:136` + addendum tự đăng ký là đủ (quyết định của plan editor/coordinator — hiện chưa có câu nào chốt).

### N2 — Wording dispatch trong PLAN-COMPLETION/README stale vs ledger → **STILL / NOT-IN-SCOPE**
- **Evidence nay:** `PLAN-COMPLETION:101` vẫn "*Các row dưới đây là **PROPOSED**, chưa cấp lease/dispatch*"; `README:136` vẫn "*chưa dispatch/accept từ plan*". Trong khi ledger: 5/6 P730 row đã dispatch 18:34–18:45 (`coordinator-state.json` plan_review_730 + notes 1836/1845) + verify wave 19:00 (note 1900); phần "từ plan" có thể đọc hợp lệ là "sửa plan không tự dispatch" nhưng nửa "chưa cấp lease/dispatch" đã mâu thuẫn ledger.
- **Vì sao không tự sửa:** plan writes thuộc plan editor; spec packet ghi "không tự sửa".
- **Đề xuất (plan-touch kế tiếp):** hoặc (a) reword 2 chỗ thành "*PROPOSED — coordinator adopt theo ledger; dispatch state xem `coordinator-state.json`*", hoặc (b) coordinator xác nhận convention ledger-as-truth đã đủ và đóng N2. Ưu tiên (a) — chi phí 2 dòng, tránh reviewer đọc nhầm trạng thái.

### N3 — Mermaid thiếu CFGADM (và LPG) → **CFGADM: FIXED · LPG: STILL / NOT-IN-SCOPE**
- **CFGADM FIXED (L3):** `README:93-96` — `P6 --> CFGADM[CFGADM legacy Admin/config parity]`, `P3 --> CFGADM`, `DATA --> CFGADM`, `CFGADM --> ADMIN`; validator merge-fix `acyclic_mermaid_graphs=2` (không cycle). Đúng như đề xuất L3 ("inputs P6/P3/DATA, output ADMIN → P8"). **Đóng mục này.**
- **LPG phần STILL:** không có node/ghi chú LPG trong mermaid `:72-113`; L3 gốc chỉ nêu CFGADM → phần LPG **NOT-IN-SCOPE** của merge-fix.
- **Đề xuất (plan-touch kế tiếp, gộp cùng N1):** khi thêm notice LPG (N1) thì thêm luôn node LPG tương tự CFGADM, **hoặc** thêm 1 dòng chú thích dưới graph "graph vẽ các phase gốc; CFGADM/LPG là sub-packet — xem bảng Phase packets" (annotation này giải quyết cả hai cách đọc).

### N4 — Release boundary chưa nêu CFGADM → **STILL / NOT-IN-SCOPE**
- **Evidence nay:** `README:161-163` — "Scope release hiện tại gồm platform P0–P8, P9-01..05…, continuity CONT-00..05…"; không nêu CFGADM (cũng không nêu AWEB — cùng nhóm scope bổ sung 10-04). Phase row `:135` + notice `:3` vẫn nói "required trong G-ADMIN-OPS… trước P8-08/G6" → boundary paragraph chưa đồng bộ danh sách scope.
- **Đề xuất (plan-touch kế tiếp):** thêm cụm "CFGADM/Admin-config parity required trước G-ADMIN-OPS/P8-08/G6" vào `:163` (1 dòng), hoặc chủ ý giữ boundary chỉ liệt kê P-series + nêu rõ "scope bổ sung xem notice/Phase packets". Chọn 1 hướng và ghi rõ — hiện đang lửng lơ giữa hai cách.

---

## 3. Limitations

1. **Không re-chạy product/build/test** — packet read-only; các số validator trong `plan-merge-fix` (§3/§4) và `plan-graph-delta` (§3) là nguồn dẫn, không re-derive toàn bộ. Riêng dedupe tôi **có** re-run: out-of-range ID = 0.
2. Line refs theo snapshot 19:10–19:20; README đã dịch +4 so với receipt trước — mọi ref `README:131/132` trong receipt cũ nay là `:135/:136` (giữ nguyên lịch sử receipt cũ, chỉ re-anchor ở receipt này).
3. Nếu plan editor/coordinator tiếp tục chạm README/PLAN-COMPLETION (RẤT có thể — N1/N2/N4 chờ lượt touch kế), số dòng sẽ lại dịch; khi đó re-anchor theo heading/section thay vì số dòng.
4. Không kiểm các file merge-fix khác ngoài phạm vi CFGADM/LPG (M2/M3/M6/L5–L7 thuộc cc_1 re-scan / lane khác).

## 4. Ledger

- 1 — Đọc spec + `plan-merge-fix` receipt + fresh README/PLAN-COMPLETION; pin mtime/dòng/hash — §"Snapshot".
- 2 — Spot-check 9 kết luận inventory cũ (definition/citation/dedupe/gate) — §1.
- 3 — Verdict N1–N4 với evidence file:line mới + đề xuất 4 mục cho plan-touch kế tiếp (không tự sửa) — §2.
- 4 — Limitations + boundary — §3/§4.

**Boundary:** file duy nhất được ghi = receipt này; không tick; không commit/push; không sửa plan/docs/source; không chạm `nocobase-10`.

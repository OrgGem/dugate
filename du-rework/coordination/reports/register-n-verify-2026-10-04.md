# REGISTER-N-VERIFY — N1–N4 APPLIED (verify độc lập, READ-ONLY)

**Packet:** `coordination/dispatch-specs/2026-10-04-1938-REGISTER-N-VERIFY.md` · **Lane:** cc_2 (`term_ee7e9f33`) · **Run:** `run_069ecd6957cd` (task `task_413fd446f780`, dispatch `ctx_89ed905fa9cc`).
**Date:** 2026-10-04 (~19:40–19:45 +07). **Mode:** READ-ONLY — file duy nhất được ghi là receipt này; không sửa plan/docs; không tick; không commit/push; offline.
**Đối tượng:** claim **N1–N4 APPLIED** trong `plan-refresh-736-740-2026-10-04.md` §5 (codex_arch, 19:26–19:29) vs cây hiện tại.
**Pin độc lập (tôi tự tính lại SHA-256):** khớp **6/6** với refresh §6 — README `54BB4BB2…F66F52`, PLAN-COMPLETION `38D38419…5BC5D996`, AWEB `11016D94…3E40C531`, CFGADM `D2BFC168…1CB97743`, ADDENDUM `875A5C24…D321F4C6`, TOPOLOGY `ABA03230…E40F423BF7` ⇒ cây ổn định từ refresh đến lượt verify này.

---

## 0. TL;DR — verdict độc lập

| # | Claim refresh | Verdict độc lập | Bằng chứng (cây hiện tại) |
|---|---|---|---|
| N1 | "README thêm notice link LPG + holds" | **FIXED** | `README:5` — block "**Legacy parity gaps / LPG holds**" đầy đủ hold (tenant/ENC/ref-lifecycle, SDK claim-loop/W1b, register/WTV checkpoint, WTV-07 mở) — đúng **ngữ nghĩa**, không chỉ chuỗi |
| N2 | "§7 + phase row phân biệt proposal/5-6 dispatch" | **FIXED** | `PLAN-COMPLETION:101` + `README:143` — reword chuẩn (proposal@730 vs dispatched@735 = **5/6**, LPG-DECISION chưa; dẫn §8/ledger) — khớp dispatch thật |
| N3 | "giữ CFGADM edges + thêm LPG side node, không ép release" | **FIXED** | `README:82` node `LPG[ORCH-LPG-01/02 decision + lease holds]` + `:120` giải thích "không … thêm gate LPG-01 vào release"; CFGADM edges giữ `:98-101`; LPG không có cạnh ra |
| N4 | "Release boundary ghi CFGADM required" | **FIXED** | `README:170` — "Admin/config parity CFGADM-00..11 required qua ACUI/AWEB trước G-ADMIN-OPS/P8-08/G6"; giữ Δ-DEV-03 user-gated; scaffold/unmanaged ≠ parity |

- **Không phát hiện overclaim mới** trong delta refresh; checkbox không đổi (re-derive độc lập: CFGADM **12** / LPG **2** / P730 **6** row `[ ]`; out-of-range ID = **0**).
- Không tick, không sửa; 3 observation nhỏ ở §3 (không chặn verdict).

---

## 1. Chi tiết từng mục (claim → cây → phán xét ngữ nghĩa)

### N1 — LPG notice block → **FIXED**
- Cây: `README:5` = `> **Legacy parity gaps / LPG holds:** [ORCH-LPG-01/02](…) giữ tenant/ENC/ref-lifecycle decision hold và SDK claim-loop collision với W1b; implementation cần register/WTV checkpoint và named lease. WTV-07 vẫn mở; refresh doc-only không cấp quyền commit hoặc tự chọn content dedup.`
- Đối chiếu nguồn: addendum `:3`/`:5` giữ đúng các hold này; SDK claim-loop collision = LPG-02 ↔ W1b; WTV-07 mở (refresh §1). → **Đúng ngữ nghĩa**, không phải chỉ có chuỗi "LPG holds".

### N2 — wording dispatch stale → **FIXED**
- `PLAN-COMPLETION:101` (mới): "Các row dưới đây ghi **proposal tại checkpoint 730**; đến checkpoint 735, coordinator đã dispatch **5/6** prep/slice (SDK/API/acquisition/cURL/CONT), **LPG-DECISION chưa dispatch** … Trạng thái mới xem §8 và refresh receipt."
- `README:143` (mới): "Checkpoint 735: **5/6** prep/slice đã dispatch; … LPG decision chưa dispatch | … | dispatch metadata **không tick full parent hoặc acceptance**".
- Cross-check ledger: dispatches 18:34–18:45 = SDK-PREP/API-PREP/ACQ-PREP/CURL-IMPORT + CONT-PREP = **5**; LPG-DECISION không có trong danh sách → "5/6, LPG-DECISION chưa dispatch" **khớp**. Câu "SDK/API/acquisition prep receipts pending" còn đúng tại lượt này (glob `p730-*` chỉ có `curl-import` + `continuity-schema-draft`). §7 giữ làm lịch sử, §8 là current. → **Đúng ngữ nghĩa**.

### N3 — LPG node/annotation mermaid → **FIXED**
- `README:82`: `P4 --> LPG[ORCH-LPG-01/02 decision + lease holds]`; CFGADM edges giữ nguyên `:98-101`.
- `README:120` (explainer mới): "LPG là nhánh inventory/decision/lease của SDK/storage; **edge này không tự chọn content dedup hoặc thêm gate LPG-01 vào release** trước quyết định register. CFGADM vẫn required theo scope Admin hiện hành."
- Kiểm gate-inflation: node LPG **không có cạnh ra** (không → P8/COMP/G6) ⇒ bookkeeping thuần; không biến LPG-01 thành required release trước PAR-00. → **Đúng ngữ nghĩa** (cạnh vào `P4 -->` là quy ước vẽ; xem §3.2).

### N4 — Release boundary CFGADM → **FIXED**
- `README:170`: "Scope release hiện tại gồm platform P0–P8, P9-01..05 …, continuity CONT-00..05 … và Admin/config parity **[CFGADM-00..11]** … **required qua ACUI/AWEB trước G-ADMIN-OPS/P8-08/G6**. Settings/config phải save/test/apply/runtime-use/rollback thật; scaffold/unmanaged không đạt chức năng cũ. **Δ-DEV-03 route `/admin/workflows` giữ user-gated**; required workflow capability không tự quyết URL."
- Kiểm semantics: thêm required scope đúng như notice `:7`/phase row `:142`; **không** đụng quyết định user-gated (route `/admin/workflows`) — đúng tinh thần "không đổi user-gated route/retire choices" (refresh §5). → **Đúng ngữ nghĩa**.

---

## 2. Spot-check register inventory sau delta

**Definitions (re-derived, không chỉ đọc validator):**
- `CFGADM-\d{2} `[ ]`` trong CFGADM plan = **12**; `P730-…` trong PLAN-COMPLETION = **6**; `ORCH-LPG-…` trong addendum = **2** — tổng **20**, đúng như trước delta.
- Out-of-range ID (`CFGADM-1[2-9]|LPG-0[3-9]` v.v.) = **0 file**.
- §8 (`PLAN-COMPLETION:114-136`) tự khai ":… **Không tạo thêm task definitions hoặc đổi checkbox** từ dispatch/slice DONE" — bảng §8 dùng lane/cycle (736–740), không sinh ID mới.
- Dedupe: refresh validator `duplicate_task_definitions=0` (12 docs) + grep độc lập của tôi = 0; label node `LPG[ORCH-LPG-01/02 …]` là **reference** trong graph, không phải định nghĩa row.

**Re-anchor citations (delta lần này dịch tiếp; bảng cũ→mới):**

| Vị trí | Trước (verify 19:2x) | Hiện tại |
|---|---|---|
| README checkpoint block | — | **:3** (mới: "Checkpoint 735 → backlog 736–740") |
| README LPG notice | không có (N1) | **:5** |
| README CFGADM notice | :3 | **:7** |
| README mermaid CFGADM nodes | :93-96 | **:98-101** |
| README mermaid LPG edge | không có (N3) | **:82** (+explainer **:120**) |
| README phase rows CFGADM / P730-LPG | :135 / :136 | **:142 / :143** |
| README Release boundary | :161 (heading) / :163 (scope) | **:168 / :170** |
| README WTV summary | "7 file mới + … 8 file" | giữ **:15** (nhất quán M6) |
| PLAN-COMPLETION §7 | :99-112 (rows :105-110) | giữ; `:101` reword; §8 mới **:114-136** |
| ADDENDUM | :3 | :3 giữ + **:5** mới ("Checkpoint 735 → 736–740") |

**Pin so với refresh:** 6/6 file hash khớp (đã nêu đầu receipt) — kết luận áp đúng cho revision đang đọc.

---

## 3. Observations (không chặn verdict — đề xuất nếu muốn hoàn thiện ở lần touch sau)

1. **"prep receipts pending" (PLAN-COMPLETION:101 / README:143):** còn đúng tại lượt verify (chưa có `p730-sdk-prep`/`api-audit-prep`/`acquisition-prep`). Vì text là *snapshot checkpoint 735* + dẫn "xem §8/refresh", không cần sửa giờ; khi receipt land chỉ cập nhật §8/refresh — đề xuất **không** sửa back §7/notice (giữ nguyên tắc snapshot).
2. **Cạnh mermaid `P4 --> LPG`:** chỉ là bookkeeping (không cạnh ra); nếu muốn diễn đạt chính xác dependency "LPG-02 chờ release SDK claim-loop W1b", lần touch sau có thể đổi nhãn cạnh (tùy chọn, không bắt buộc, không ảnh hưởng gate).
3. **N2 vẫn nên dẫn ledger là nguồn dispatch runtime** — text hiện dẫn `§8 + refresh receipt`; nếu có dispatch mới sau refresh, chỉ refresh/§8 cần cập nhật, không reword §7 (đúng hướng đã chọn).

## 4. Limitations + Ledger + Boundary

**Limitations:**
1. Không re-run link-checker/validator của refresh (không double-scan); độc lập của tôi = tự tính SHA-256 (6/6 khớp), tự đếm checkbox/definition (12/2/6), tự grep out-of-range (0), đọc **ngữ nghĩa** từng mục N1–N4.
2. Không re-verify các nội dung khác của refresh (§1 trạng thái W1/W2-B/CLOSURE/DD03…) — thuộc lane/receipt tương ứng.
3. Snapshot ~19:40–19:45; hash pins khớp nên cây chưa đổi trong cửa sổ verify; nếu plan editor tiếp tục touch, re-anchor theo heading/section.

**Ledger:** 1) recompute 6 hash pins + fresh read README (:1-170); 2) fresh read PLAN-COMPLETION (:95-136) + addendum head; 3) độc lập đếm definitions/checkbox + grep out-of-range; 4) verdict N1–N4 + 3 observation + re-anchor table.

**Boundary:** file duy nhất được ghi = receipt này; không tick; không commit/push; không sửa plan/docs/source; không chạm `nocobase-10`.

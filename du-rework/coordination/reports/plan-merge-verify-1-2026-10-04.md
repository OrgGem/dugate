# PLAN-MERGE-VERIFY-1 — verify 10 doc-fix của plan editor (READ-ONLY) — 2026-10-04

**Packet:** `coordination/dispatch-specs/2026-10-04-1920-PLAN-MERGE-VERIFY-1.md` · **Lane:** cc_1 (`term_c03791d1-2f0a-4c30-afc1-533d28f193ea`) · **Run:** `run_069ecd6957cd` (task `task_be85253ebc47`, dispatch `ctx_7ad755aac42d`).
**Input:** `coordination/reports/plan-merge-fix-2026-10-04.md` (codex_arch, claim 10/10; validator 10 docs/162 links; 11 docs/170 links). **Snapshot đo:** 2026-10-04 **19:11:59–19:13:39 +07** (6 doc sửa lúc 19:00:36–19:02:17; không có edit mới sau đó trong cửa sổ đo).
**Mode:** READ-ONLY — file duy nhất ghi là receipt này; không sửa plan/docs; không tick; không commit/push.

## 0. TL;DR

| | Kết quả |
|---|---|
| Verdict 10 mục | **9/10 FIXED (đúng ngữ nghĩa) — L2 PARTIAL** (còn sót bare `PAR-##` ngoài 3 file được sửa) |
| Khớp độc lập với claim | SHA-256 **6/6 file khớp** hash fix-receipt; link check 10 docs **162/0 broken, 0 anchor** (đúng con số 162 của họ); `git diff --check` **output rỗng, exit 0** |
| Checkbox | Không row hành động nào đổi: PLAN-COMPLETION `[ ]=17` (5 PLAN04 + 6 CONT + 6 P730); WTV rows `[ ]` (WTV-07 vẫn mở); ORCH-PAR-11..17 `[ ]=7` |

## 1. Đối chiếu từng mục

| Item | Claim trong fix-receipt | Verify trên cây hiện tại | Verdict |
|---|---|---|---|
| **M2** | WTV: status mới + bảng evidence 7 receipt refs; WTV-07 vẫn `[ ]` | `WORKTREE-...md:3` status cập nhật ("đã có bảy receipt… **WTV-07 commit/push vẫn mở**"); bảng evidence `:47-55` đủ **7 refs** (01b/02/03/04/05/06/08), mỗi row có scope + phần còn mở; rows `:33-41` giữ `[ ]`; caveat skip 97 test giữ (`:50`). | **FIXED** |
| **M3** | AWEB: append 5 receipt 15:12–16:31 sau row 14:56 | `ADMIN-WEB-...md:131-135` = 5 row mới (wire conformance / phase1 CHANGES_REQUIRED / F-PP1 closure / docs UX pointer / legacy inventory); log cũ giữ nguyên tới `:130`; verdict ghi phạm vi ("Owner-reported", "không thay reviewer/UI_APPROVED"). | **FIXED** |
| **M4** | LIV: 2 điểm Connector → 8091, giữ comment 8081 lịch sử | grep: `:13` = `:8091`, `:328` = `:8091`, `:149` health = `:8091`; `:132-133` giữ DEVIATION NOTE (8081 bị chiếm — lý do lịch sử). Không còn chỗ nào dùng 8081 làm cổng vận hành. | **FIXED** |
| **L1** | README: bỏ anchor chết `#Muc-23`, giữ link | `README.md:43` = `[Owner receipt](../coordination/reports/qwen-docs.md)` — anchor đã bỏ, link còn; link checker 10 docs: **0 anchor issue**. | **FIXED** |
| **L2** | 3 file đổi shorthand `PAR-##` → `ORCH-PAR-##` (6/9/18 refs) | PLAN-COMPLETION bare=0 (ORCH-PAR=6) ✓; AWEB bare=0 (ORCH-PAR=10); ORCH-CONFIG bare=0 (ORCH-PAR=26; PAR-XA=5 giữ nguyên) ✓ — **nhưng còn sót bare `PAR-##` ở 4 file khác**: README 3 dòng (`:13` `[PAR-11..17]` — đúng site tôi đã nêu trong finding gốc, `:27`, `:126`), WTV `:14`, CFGADM **25 dòng** (`:7,:9,:21-32,:85-95…`), LPG 4 dòng (`:44,:52,:83,:95`). Tổng còn 33 dòng bare. | **PARTIAL** |
| **L3** | README Mermaid: thêm CFGADM node (P6/P3/DATA → ADMIN → P8) | `README.md:93-96` có `P6-->CFGADM`, `P3-->CFGADM`, `DATA-->CFGADM`, `CFGADM-->ADMIN`; nối tiếp `ADMIN-->P8 :105`. DAG, không cycle; 2 mermaid graphs vẫn hợp lệ. | **FIXED** |
| **L4** | Fold requirements vào CONT-01/04 | `:67` CONT-01 có "import/map AI/prompt defaults, storage generations, user grants và workflow schema/mapping revisions theo CFGADM"; `:70` CONT-04 có "Rehearsal cả hành trình Admin setup/edit/test/publish/apply/rollback… kiểm defaults/storage-generation/grants/schema mapping continuity". Checkboxes không đổi (`[ ]`). | **FIXED** |
| **L5** | AWEB: câu `apps/*` → snapshot quá khứ | `:11` = "Ở snapshot lập plan, `pnpm-workspace.yaml` chưa có `apps/*`; bootstrap AWEB-01 đã thêm pattern này, hiện workspace có `apps/*`" — khớp `pnpm-workspace.yaml:6`. | **FIXED** |
| **L6** | WTV: 7 file mới + remaining = 8, harness riêng | `:24` = "…1785 (remaining) + **7 file `runtime-*.test.ts` mới = 8 file test thuộc split**, cộng harness riêng"; WTV-02 row `:35` = "8 file test thuộc split (7 mới + remaining), cộng harness riêng; phân biệt skip-mode với LIVE". Khớp wtv02 receipt. | **FIXED** |
| **L7** | AWEB write set → dirs thực | `:23` = `apps/admin-web/src/{app-shell,components,features,lib,routes,styles}/`, `src/router.tsx`, `components.json`, build config; thêm điều kiện lease cho shared `components/ui|styles`. Khớp cây thật (`src/` có đúng 6 dir + `main.tsx`/`router.tsx`). | **FIXED** |

## 2. Bằng chứng độc lập (literal)

**SHA-256 — 6/6 khớp fix-receipt (chứng minh verify trên đúng bản đã fix):**

| File | Recompute (cc_1) | Receipt |
|---|---|---|
| WTV | `301569a528c984557c541399f64bc87ded68f50727fd0d795688d39f274abec4` | khớp |
| AWEB | `2033fc75788e67e27929eb14d6345963c2cd1d4b9ff03e1e88b23025870ecb67` | khớp |
| LIV | `439804d36d44d0fe663a05c38d26371eee2f8aa09fa61cf6ddec0343507691c7` | khớp |
| README | `cb398d73cc8d932d95a09f83022748943e763f184647de5381a4432601c6a1ab` | khớp |
| PLAN-COMPLETION | `4cb7cacaca814e5cace769172a35d56099272e7ea89ecc14589265a9bfdab4ac` | khớp |
| ORCH-CONFIG | `e35edb80e2ee620deb7374ee30b88e3ea71b0ad17f0015bf8f8b1fd33fd3ec48` | khớp |

- **Link/anchor checker (cc_1, 10 docs cùng scope):** `TOTAL LINKS: 162 | BROKEN: 0 | ANCHOR ISSUES: 0` — khớp `local_links_checked: 162` của fix-receipt; 3 absolute `C:/…typed-discovering-wall.md` tồn tại.
- **`git diff --check` (đúng lệnh của receipt):** output **rỗng (0 bytes)**, exit 0 — tái lập được.
- **Bare-PAR scan (script cc_1, lookbehind `(?<!ORCH-)PAR-\d+`):** PLAN-COMPLETION 0 / AWEB 0 / ORCH-CONFIG 0 / TOPOLOGY 0 / plan-review-730 0 / LIV 0; còn lại: README 3 / WTV 1 / CFGADM 25 / LPG 4 dòng.
- **Checkbox counts literal:** PLAN-COMPLETION `[ ]=17, [x]=0, [~]=0` (5+6+6 rows mở đúng); WTV `[ ]=10` (9 rows + 1 mention chữ); ORCH-CONFIG `[ ]=7`; các `[x]` xuất hiện trong câu prose/markdown quote lịch sử (vd WTV `:8` "…trước khi tick `[x]`"), không phải row hành động.

## 3. L2 — chi tiết phần chưa đóng

Fix đúng cho 3 file được giao (bare=0), nhưng chưa phủ hết finding gốc ("chuẩn hóa `ORCH-PAR-##` trong mọi tham chiếu"): README `:13` (site gốc đã nêu), `:27`, `:126`; WTV `:14`; CFGADM (file mới) 25 dòng dạng `PAR-14/15`, `PAR-16`, `PAR-00`…; LPG 4 dòng. Hệ quả: hai cách viết vẫn tồn tại → risk tạo row trùng khi register tiếp. **Đề xuất (không thực thi):** lượt fix nhỏ tiếp theo quét `(?<!ORCH-)PAR-\d+` toàn suite (gồm CFGADM/LPG/README/WTV) hoặc ghi alias-note một chỗ. `PAR-XA-*` phải giữ nguyên (đã đúng: ORCH-CONFIG 5, LPG 1).

## 4. Limitations

- Verify ở mức doc/artifact trên snapshot 19:11:59–19:13:39; 6 doc ổn định từ 19:02:17; không chạy test/build (doc-only).
- Các claim nội bộ của fix-receipt không tái lập được từ bên ngoài: mtime/hash guard **trước patch**, "AWEB_MTIME_HASH_GUARD", số refs chuyển đổi "6/9/18" (metric khác với phép đếm occurrence của tôi: 6/10/26 — target outcome "3 file bare=0" thì đã xác nhận). Ghi rõ là limitation, không phải mâu thuẫn.
- Anchor check dựa heading; không render GitHub/plugin; external URL bỏ qua (offline).

READ-ONLY compliance: chỉ receipt này được ghi; không tick/sửa; không commit/push.

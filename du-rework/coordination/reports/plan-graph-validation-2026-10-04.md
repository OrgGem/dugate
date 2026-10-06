# PLAN04-05a — Plan-graph & link validation (READ-ONLY) — 2026-10-04

**Packet:** `coordination/dispatch-specs/2026-10-04-1805-PLAN05a-plan-graph-validation.md` · **Lane:** cc_1 (`term_c03791d1-2f0a-4c30-afc1-533d28f193ea`) · **Run:** `run_069ecd6957cd` (coordinator `term_58db0267`; dispatch `ctx_d4d1e58a7c49`, task `task_7796580129fe`).
**Date:** 2026-10-04, snapshot 18:26 +07 (receipt soạn 18:26–18:35). **Mode:** READ-ONLY — file duy nhất được ghi là receipt này. Không sửa source/test/plan/docs; không tick task/gate; không commit/push; offline (không mở DB/Redis/S3/Vault). Script phụ trợ chạy từ scratchpad ngoài repo.
**Mục tiêu:** input cho vòng rà soát Master Plan turn 730 (quy tắc vận hành #4; `coordinator-state.json → next_plan_review_turn: 730`).
**Delta compliance:** theo `plan-review-730-2026-10-04.md:12,43` (scan phải chạy **sau** delta 730), toàn bộ số liệu dưới đây được re-derive trên snapshot **18:26 +07**, SAU các edit 18:16:07–18:25:51 (CFGADM onboarding + P730 rows). Các đọc ban đầu trước delta chỉ dùng khoanh vùng, **không** dùng làm kết luận. Cây còn dịch chuyển khi validate — line number theo snapshot ghi rõ.

## 0. TL;DR

| Hạng mục | Kết quả |
|---|---|
| Markdown link (8 file, 140 link) | **139 resolve / 1 broken** (99,3 %) |
| Heading/line anchor | **1 broken** (`qwen-docs.md#Muc-23`); `#L1018`/`#L1061` OK |
| Task ID trùng định nghĩa | **0** — mọi namespace mới độc quyền (chi tiết §3) |
| Claim vượt bằng chứng | **0 phát hiện** — các GO lịch sử đã được caveat đúng |
| Findings | **11 (4 MED / 7 LOW)** — bảng §2; không có HIGH |

Không tick gate/task; các gate giữ **NO-GO** như tài liệu ghi. Không row nào trong 8 file bị sửa.

## 1. Snapshot & phương pháp (literal)

**Scope theo spec:** `tasks/README.md` + 6 plan hiện hành. **Scope bổ sung trong lúc validate:** `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` (tạo 18:16:07, đã thành plan hiện hành tại `README.md:3` + `:131`) — đúng tinh thần "plan hiện hành"; mọi receipt CFGADM liên hệ nằm ở file này.

| File | mtime (snapshot) | Dòng |
|---|---|---|
| `tasks/README.md` | 18:25:51 | 160 |
| `tasks/PLAN-COMPLETION-2026-10-04.md` | 18:25:51 | 113 |
| `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` | 18:21:17 | 114 |
| `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` | 18:19:49 | 129 |
| `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` | 18:21:17 | 158 |
| `tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md` | 17:55:16 | 335 |
| `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md` | 18:25:51 | 103 |
| `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` | 10-03 12:51 | 50 |

**Phương pháp:** script Node chạy từ scratchpad —
1. extract + resolve markdown link tương đối (case-insensitive sibling hint), heading anchor kiểu GitHub (unicode slug), line-anchor `#Lnnnn` đối chiếu số dòng file đích;
2. extract task-ID token, phân biệt **định nghĩa** (row bảng/heading/checkbox) vs **tham chiếu**; đối chiếu chéo toàn `tasks/`;
3. trích path refs trong backtick + kiểm tồn tại (kể cả legacy root `D:/Git/dugate`);
4. đọc chéo receipt/ledger: WTV (`wtv01b/02/03/04/05/06/08`), LIV (`liv03..liv11`), AWEB evidence log, `receipt-status-inventory-2026-10-04.md` (cc_2), `plan-review-730-2026-10-04.md`;
5. spot-check: `api_secret_key` consumer, path `pipeline-mappings`, `packages/worker-sdk/src/*`, `apps/admin-web/src/**`.

Không chạy test/build; không re-verify số liệu trong receipt (thuộc lane PLAN04-05b cc_2 — `receipt-status-inventory-2026-10-04.md`).

## 2. Findings (bảng chính — đề xuất không thực thi)

| # | Loại | Vấn đề + evidence | file:line | Mức | Đề xuất |
|---|---|---|---|---|---|
| M1 | Link chết | Hàng "Workflow … mapping overrides" trỏ `../../app/api/internal/pipeline-mappings/override/route.ts` — path không tồn tại; grep toàn root `app/api` chỉ có `app/api/internal/workflow-schemas/pipeline-mappings/route.ts` (GET `overrideConnector`). | `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:29` | **MED** | Trỏ về `app/api/internal/workflow-schemas/pipeline-mappings/route.ts`; nếu cần write-override path thật, xác nhận thêm trước freeze CFGADM-09. |
| M2 | Trạng thái | WTV ghi "`SPECIFIED`, chưa dispatch" + toàn bộ WTV-00..08 `[ ]`, nhưng **7 receipt đã tồn tại** (dispatch 10-03 13:20–15:02): `wtv01b-rfx-preserved`, `wtv02-runtime-split-verify`, `wtv03-crypto-verify`, `wtv04-upload-storage-verify`, `wtv05-crx-encmeta-verify`, `wtv06-prep`, `wtv08-rfx-gapcheck`. Plan mtime 10-03 12:51 < dispatch 13:20 → file chưa cập nhật sau khi task chạy. WTV-07 chưa thực thi (commit cuối `b088eec` 10-02 14:27; cây dirty); WTV-06 mới prep (`.gitignore`, deletion chờ owner). | `WORKTREE-VERIFY-COMMIT-2026-10-03.md:3`, rows `:33-41` | **MED** | Thêm mục "receipts đã có" + mô tả trạng thái thực (không tick `[x]` — chính file yêu cầu APPROVED); ghi rõ WTV-07 còn mở. |
| M3 | Trạng thái | Evidence log AWEB dừng 14:56 trong khi receipt cho dispatch 15:12–16:31 đã tồn tại: `aweb04-wire-conformance`, `profile-phase1-verify`, `fpp1-closure-verify`, `aweb08-docs-ux-pointer`, `aweb08-legacy-inventory` (specs `2026-10-04-1512/1532/1601/1631-*`). | `ADMIN-WEB-DELIVERY-2026-10-04.md:128` (log kết thúc tại 14:56) — receipts trong `coordination/reports/` | **MED** | Coordinator append rows (không tick) hoặc chú thích mốc log; nếu không, reviewer turn 730 dễ coi các slice 15:12+ là chưa có receipt. |
| M4 | Mâu thuẫn nội bộ | LIV ghi Connector `:8081` nhưng `.env.live` chạy `CONNECTOR_PORT=8091` (deviation note) + health check tại `:8091` — hai nguồn sự thật trong cùng plan. | `LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md:13`, `:328` vs `:132-133`, `:149` | **MED** | Chuẩn hóa 8091 (ghi lý do 1 lần); sửa `:13`/`:328` để không ai chạy nhầm 8081. |
| L1 | Anchor chết | `qwen-docs.md#Muc-23` không resolve — qwen-docs đã tái cấu trúc (heading hiện theo `## N — CYCLE …`; grep `Muc-?23` = 0; intro nói mục cũ giữ làm lịch sử). | `README.md:43` → `coordination/reports/qwen-docs.md:9` | LOW | Bỏ anchor hoặc trỏ mục hiện hành chứa ORCH-OPS-0019 reconciliation. |
| L2 | ID alias | Heading canonical là `ORCH-PAR-11..17` nhưng tham chiếu bằng `PAR-xx` ở nhiều chỗ; AWEB dùng **lẫn hai cách trong cùng file**. | `README.md:13`; `PLAN-COMPLETION-2026-10-04.md:15-16`; `ADMIN-WEB-DELIVERY-2026-10-04.md:39` (ORCH-PAR-02/12/13) vs `:40` (PAR-01/03/14), `:41`; `ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:34-130` vs `:149`,`:151` | LOW | Chuẩn hóa `ORCH-PAR-##` (hoặc ghi alias 1 lần) trước khi CFGADM register để tránh tạo row trùng tên. |
| L3 | Graph | CFGADM có row trong Phase packets nhưng Phase graph mermaid không có node CFGADM (không thể hiện CFGADM→ADMIN/P8). | `README.md:72-109` (graph) vs `:131` (row) | LOW | Thêm node CFGADM hoặc chú thích graph chỉ vẽ phase gốc. |
| L4 | Acceptance drift | Block CFGADM đầu file yêu cầu "CONT-01 phải import/map defaults, storage generation, user grants và schema/mapping revisions; CONT-04 rehearsal cả hành trình Admin" nhưng text row CONT-01/CONT-04 chưa cập nhật. | `PLAN-COMPLETION-2026-10-04.md:3` vs `:67` (CONT-01), `:70` (CONT-04) | LOW | Fold vào text row (hoặc ghi rõ top-block là ràng buộc binding bổ sung). |
| L5 | Stale | AWEB viết hiện tại "`pnpm-workspace.yaml` hiện chưa có `apps/*`; thêm pattern trong task bootstrap" — thực tế **đã có** (AWEB-01 hoàn tất). | `ADMIN-WEB-DELIVERY-2026-10-04.md:11` vs `du-rework/pnpm-workspace.yaml:6` | LOW | Sửa thành quá khứ ("đã thêm trong bootstrap AWEB-01"). |
| L6 | Số liệu | WTV đếm "8 file `runtime-*.test.ts`" và "9 file test + harness" không khớp cách đếm của receipt wtv02 (7 file mới + `runtime.test.ts` remaining = 8 chạy độc lập; 2 file pre-existing bị loại trừ). | `WORKTREE-VERIFY-COMMIT-2026-10-03.md:24`, `:35` vs `coordination/reports/wtv02-runtime-split-verify-2026-10-03.md:13-24,31-43` | LOW | Thống nhất một cách đếm khi cập nhật file; không đổi acceptance. |
| L7 | Path ref | Write-set owner ghi `apps/admin-web/src/app/` — không tồn tại thực tế; cấu trúc hiện tại: `src/{app-shell,components,features,lib,routes,styles}`. | `ADMIN-WEB-DELIVERY-2026-10-04.md:23` vs `du-rework/apps/admin-web/src/` | LOW | Đối chiếu/sửa write set trước dispatch packet implementation chính thức. |

## 3. Kết quả kiểm sạch (checked-clean)

- **Link:** 140 link ở 8 file (gồm link mới của CFGADM block, P730 rows, LPG checkpoint 730 block) chỉ 1 broken (M1). `coordination/reports/plan-review-730-2026-10-04.md` mới tạo vẫn resolve từ `PLAN-COMPLETION:101` và `LPG:3`. 3 ref absolute `C:/Users/Gem/.claude/plans/typed-discovering-wall.md` tồn tại. `#L1018`/`#L1061` (review.md) hợp lệ theo số dòng.
- **Backtick path refs (83):** 15 cảnh báo thô đều là false-positive khi triage — brace expansion (`packages/worker-sdk/src/{worker,task-context,types}.ts`: cả 3 file tồn tại), glob (`apps/*`, `infra/scripts/*`, `services/connector/tests/*`, `coordination/reports/*`), suffix `:line` của legacy refs (tất cả resolve dưới root: `lib/settings.ts`, `lib/upload.ts`, `lib/upload-helper.ts`, `lib/file-url-downloader.ts`, `lib/storage/dedup.ts`), PNG `tests/browser/artifacts/live-*.png` là output dự kiến của LIV-09/10 chưa sản xuất, `tests/multi-container-e2e.integration.test.ts` resolves tại `businesses/document-core/tests/`. Riêng `apps/admin-web/src/app/` → L7.
- **Task ID:** 0 trùng định nghĩa. Namespace mới độc quyền: `PLAN04-01..05`, `CONT-00..05`, `AWEB-00..08`, `WTV-00..08`, `LIV-01..11`, `CFGADM-00..11`, `ORCH-LPG-01..02`, `P730-*` (6 row đề xuất mới). Các lần xuất hiện chéo chỉ là tham chiếu parent/dependency (khớp lưu ý của `plan-review-730:43`: "không đếm citations thành duplicate task declarations"). Sub-ID dùng ở receipt/topology (`AWEB-01b/03a/b/c`, `WTV-01b`, `PLAN04-05a/05b`) không phải row — nhất quán, không va chạm.
- **Overclaim:** không phát hiện tuyên bố vượt bằng chứng trong 8 file; các đề xuất GO lịch sử đã được caveat đúng (`LIV:3`, `PLAN-COMPLETION §4`); receipts tự ghi "không tick"; gate **NO-GO** nhất quán (WTV:12, LPG:11-12, ORCH-CONFIG:5, README:35).
- **Spot-check `api_secret_key`** (CFGADM:10 khẳng định "không runtime consumer ngoài settings"): chỉ có trong settings store — `lib/settings.ts:101,111`, `app/api/settings/route.ts:31-32,65` (mask/allowlist). Khớp.
- **Đối chiếu chéo:** `receipt-status-inventory-2026-10-04.md` (cc_2) phủ row PLAN04/CONT/LPG; receipt này độc lập, không đè, bổ sung phần graph/link/status-drift (WTV/AWEB/LIV/README).

## 4. Giới hạn / chưa chứng minh

- Không chạy test/build; không re-verify số liệu bên trong bất kỳ receipt nào (không thuộc scope 05a).
- Enumeration receipt dựa trên tên file + dispatch-spec + đọc head; chưa đọc toàn văn 100 % receipt (vd. wtv03/04/05 chỉ đọc metadata).
- External URL không kiểm (offline). Anchor dạng `#Lnnnn` kiểm bằng line-count, không kiểm render GitHub. `docs/01-product-scope.md` (có nhắc CFGADM) ngoài scope, chưa link-check.
- Line number theo snapshot 18:26 +07; cây đang được lane plan-editor sửa liên tục (18:16→18:25:51) — nếu còn delta sau receipt này, coordinator re-anchor theo symbol/heading trước khi trích vào Master Plan.

## 5. Liên hệ

- Feed cho: `coordination/reports/plan-review-730-2026-10-04.md` (§1 ghi 05a là input pending) + `coordinator-state.json → plan_review_730`.
- Không tick/sửa bất kỳ file nào khác; tuân thủ single-writer (chỉ ghi receipt này).

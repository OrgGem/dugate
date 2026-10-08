# WFA evidence-pointer audit — F1 follow-up (2026-10-08)

- **Task:** xử lý finding **F1** từ [wfa-docs-review-2026-10-08.md](wfa-docs-review-2026-10-08.md) §4 (lane WFA-DOCS). Reviewer nghi 3 con trỏ tới `tests/workflow-api/logs/schema-worker-full-after-owner-patches-node24-2026-10-07.log` bị treo vì "glob `**/logs/**` = 0 hit".
- **Owner:** OC lane (WFA-DOCS). **Không commit, không push.** Không chạm `docs/21-openapi.json` (agent khác regen), **không sửa `tests/workflow-api/`**.
- **TL;DR:** file log **TỒN TẠI** trên working tree (460,442 bytes, mtime 10/7 19:35:34; tail `Tests: 8 passed, 8 total`). Vấn đề thật không phải "file không tồn tại" mà là **không portable qua Git**: cả cây `tests/workflow-api/` untracked và `*.log` bị `.gitignore`. Đã sửa 3 chỗ trích theo hướng "receipt lịch sử + trỏ receipt mới nhất". Số liệu: **8/8 đúng tại 10/7 19:35** (đã superseded); full-file run mới hơn: 10/10 → **11/11 ×2** → **13/13 ×3** (mới nhất); "named-clean-rerun" thực tế là **2 passed/8 skipped ×3** (không phải 11/11); T26/T27 fail-first đang **RED**.

## 1. Xác minh F1 — file log có tồn tại không?

Kiểm tra ngày 2026-10-08, cwd `D:\Git\dugate`:

| Kiểm tra | Kết quả |
|---|---|
| `Test-Path du-rework/tests/workflow-api/logs/schema-worker-full-after-owner-patches-node24-2026-10-07.log` | **True** — file tồn tại |
| Metadata file | **460,442 bytes**, mtime **2026-10-07 19:35:34** |
| Nội dung (tail) | `Tests:       8 passed, 8 total` — đúng claim 8/8 |
| Thư mục `tests/workflow-api/logs/` | tồn tại, **60 file** `.log` |
| `git check-ignore -v <log>` | khớp **`du-rework/.gitignore:15:*.log`** |
| `git ls-files du-rework/tests/workflow-api` (tracked) | **0** — cả cây untracked (`?? du-rework/tests/workflow-api/`) |
| `git ls-files --others --exclude-standard` / `--others` | **20** / **80** → 60 file log bị ignore |
| Agent `glob **/logs/**` (từ `du-rework` và từ `D:\Git\dugate`) | **trả về đủ file log** (truncated ở 50) |
| `rg --files -g "**/logs/**" du-rework` | liệt kê file log, exit 0 |

**Kết luận:**
- Phát biểu "không tồn tại `logs/`" của review **không tái hiện được** bằng các công cụ của session này; file có mặt trên đĩa và `glob` thấy được. Ghi nhận có khác biệt giữa hai lần kiểm tra cùng ngày; nguyên nhân 0-hit phía reviewer không tái dựng được từ đây (nghi vấn hợp lý: một traversal tôn trọng rule ignore/git — nhưng không kết luận chắc chắn).
- **Điểm đúng của F1 là tính bền vững:** `.log` không nằm trong Git (untracked + ignored), nên con trỏ `.log` không chứng minh được bằng git-based check và sẽ mất hút nếu cây được commit mà không force-add. ⇒ Cách sửa: đánh dấu lịch sử/superseded và trỏ tới receipt `.md` (đã làm, xem §3).

## 2. Run nào chứa 8/8; 8/8 vs 11/11 vs 13/13

Đọc trực tiếp dòng tổng kết của từng log (`Get-Content <log> -Encoding UTF8 | Select-String "^Tests:"`), ngày 2026-10-08:

| Log (dưới `tests/workflow-api/logs/`) | mtime | `Tests:` | Ý nghĩa |
|---|---|---|---|
| `schema-worker-full-after-owner-patches-node24-2026-10-07.log` | 10/7 **19:35:34** | `8 passed, 8 total` | Control suite **8/8** — mốc đang được 3 chỗ trích |
| `named-clean-rerun1/2/3-...log` | 21:48–21:50 | `8 skipped, 2 passed, 10 total` ×3 | Focused named T01/T02 — **KHÔNG phải "11/11"** |
| `full-baseline-after-muc1-...log` | 21:51:57 | `10 passed, 10 total` | Full file sau đợt named |
| `full-run2/3-after-muc2-...log` | 22:00:05 / 22:00:44 | `11 passed, 11 total` ×2 | Full file sau đợt named + doc-compare |
| `full-after-muc3-run1/2/3-...log` | 22:30:36–22:31:09 | `13 passed, 13 total` ×3 | **Full-file green baseline mới nhất** (đã gồm named T01–T03, leaf-node, egress fences) |
| `t26-t27-failfirst1-...log` | 22:58:35 | `2 failed, 13 skipped, 15 total` | T26/T27 fail-first — full file hiện **RED** đúng 2 test |
| `t26-diag-...log` | 10/8 02:59:33 | `1 failed, 14 skipped, 15 total` | Diagnostic mới nhất (10/8); chưa có full run mới hơn |

**Số nào đúng ở thời điểm nào:**
- **8/8** đúng **tại 10/7 19:35** (control suite — một tập con). Không sai, nhưng **đã bị supersede trong cùng ngày** bởi các full-file run.
- **11/11 ×2** là full-file run **sau đợt muc 2** (22:00) — không phải "named-clean-rerun 11/11 ×3".
- **13/13 ×3** (22:30–22:31) là **green baseline mới nhất** của full file (baseline muc 1–3); sau đó T26/T27 fail-first để full file ở trạng thái **RED** — không có full green nào mới hơn tính đến run 10/8 02:59.
- **Không nâng claim:** evidence T01–T03/leaf-node là các run của owner-lane (qwen); các mục tương ứng trong `docs/06` giữ nguyên **OPEN** đối với independent verify; T26/T27 chưa có green. Các con số thuộc các run khác nhau và **không được cộng dồn**.

## 3. Đã sửa gì (không commit)

| Chỗ trích | Trước | Sau |
|---|---|---|
| `docs/06-public-api.md:81` | `... **8/8** (`tests/workflow-api/logs/schema-worker-full-after-owner-patches...log`) là evidence cross-cutting ...` | 8/8 = mốc lịch sử 10/7 19:35; superseded bởi 10/10 → 11/11 ×2 → **13/13 ×3**; raw log nằm trong thư mục untracked + `*.log` gitignore → chỉ receipt `.md` là con trỏ citable; sau T26/T27 fail-first full file hiện RED ở đúng 2 test; provider vẫn là loopback mock |
| `coordination/reports/wfa-integration-2026-10-07.md:68` | trích log không chú thích | thêm marker "(**historical receipt — superseded the same day** …)" + đoạn **"Evidence-pointer update, 2026-10-08 — F1 follow-up"** ngay dưới: kết quả 10/10 → 11/11 ×2 → 13/13 ×3, trạng thái RED hiện tại, ghi chú untracked/gitignore, con trỏ thay thế (handover §2–§3 + audit này) |
| `coordination/reports/wfa-docs-2026-10-07.md:40` | trích log không chú thích | thêm ghi chú đính chính 2026-10-08 ngắn + link audit này |

Không có file nào khác bị sửa. `docs/21-openapi.json` và `tests/workflow-api/` không bị chạm.

## 4. Việc còn lại / ngoài scope

- **Durability của log (owner: coordinator/qwen lane):** 60 file `.log` dưới `tests/workflow-api/logs/` untracked + ignored. Nếu fleet muốn bằng chứng nằm trong Git khi commit, cần chọn: force-add các log được chỉ định, đổi sang phần mở rộng không bị ignore, hoặc copy log chính vào `coordination/reports/raw/`. **Không thực hiện trong task này** vì `tests/workflow-api/` nằm ngoài write-scope.
- **Các trích dẫn `.log` khác** (`wfa-verification-2026-10-07.md`, `wfa-verify-baseline-2026-10-07.md`, `wfa-qwen-handover-2026-10-07.md`, dispatch specs, `tests/workflow-api/README.md`) được giữ nguyên — thuộc lane khác/lịch sử; chúng trỏ tới file tồn tại cục bộ nên không "treo" theo nghĩa missing, chỉ dùng chung caveat untracked.
- **F2** (regen không còn byte-identical do `admin.ts` drift) ngoài scope F1; không xử lý ở đây.
- Audit này **không** thay đổi trạng thái kiểm chứng của bất kỳ acceptance row nào: không ACCEPTED mới, không VERIFIED mới.

## 5. Files touched

- `du-rework/docs/06-public-api.md` (§WFA evidence, dòng 81)
- `du-rework/coordination/reports/wfa-integration-2026-10-07.md` (dòng 68 + đoạn update)
- `du-rework/coordination/reports/wfa-docs-2026-10-07.md` (§2.1, dòng 40)
- `du-rework/coordination/reports/wfa-evidence-pointer-2026-10-08.md` (audit này)

No commit, no push.

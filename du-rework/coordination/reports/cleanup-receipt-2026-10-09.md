# Cleanup & consolidation receipt — 2026-10-09

Ngàời yêu cầu: dọn dẹp toàn bộ plan đã xử lý xong, gọn lại task, ghi mọi việc chưa xử lý vào **một** file plan duy nhất để rà lại.
Scope người dùng chọn: 6 plan + review docs + tasks xong.
Phương pháp người dùng chọn: move vào `_archive/`.

## 1. Kết luận quan trọng

**Không plan nào đã xong.** Kiểm kê toàn diện cho thấy:

| Nhóm | Kết quả |
|---|---|
| 6 plan (LDBA, UBW, MASTER_PLAN, 3 review tháng 9) | PARTIAL hoặc SUPERSEDED-NHUNG-CON-MO |
| `coordination/*.md` (23 file) | **0 DONE** |
| `tasks/*.md` (55 file) | 50 OPEN / 5 DONE |
| 5 file DONE | 3 là template/overlay (không phải work item), 1 bản ghi ủy quyền, 1 là P3-connector (có receipt) |

Vì vậy việc archive hàng loạt là **không thể** làm đúng: sẽ mất finding. Mục §3 của `PLAN-OPEN-2026-10-09.md` ghi danh sách file **không được** archive dù trông giống đã xong.

## 2. File mới

| File | Vai trò |
|---|---|
| `coordination/PLAN-OPEN-2026-10-09.md` | **Sổ tay mở duy nhất** — thay thế `reports/plan-open-task-register-2026-10-03.md` |

Nội dung: §0 phạm vi/phương pháp · §1 bảng verdict · §2 10 nhóm mở (A..J) với `file:line` · §3 8 mâu thuẫn cần đối chiếu · §4 file không được archive · §5 danh sách archive + inbound links · §6 cách đóng mục · §7 ràng buộc.

## 3. Đã archive (3 file — đúng những gì thuần SUPERSEDED)

| Gốc → Đích | Lý do |
|---|---|
| `coordination/HANDOFF-TO-ANTIGRAVITY-2026-09-24.md` → `_archive/HANDOFF-TO-ANTIGRAVITY-2026-09-24-superseded-2026-10-09.md` | handoff theo thời điểm, không carry finding |
| `coordination/PROGRESS-RECONCILIATION-2026-09-23-EVENING.md` → `_archive/PROGRESS-RECONCILIATION-2026-09-23-EVENING-superseded-2026-10-09.md` | reconciliation theo thời điểm |
| `coordination/reports/plan-open-task-register-2026-10-03.md` → `_archive/reports/plan-open-task-register-2026-10-03-superseded-2026-10-09.md` | stale (37/55 file `tasks/`, không phủ coordination review docs + 6 plan) |

Mỗi vị trí cũ giữ một **stub SUPERSEDED** trỏ tới bản archive + tới `PLAN-OPEN-2026-10-09.md`, để 73 file tham chiếu 6 plan filename và 16 file tham chiếu register không gãy link. Đã kiểm tra: mọi link trong stub resolve đúng.

## 4. Đã chỉnh pointer trong 3 plan LIVE

| File | Thêm vào |
|---|---|
| `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` | dòng 8 — trỏ tới `PLAN-OPEN-2026-10-09.md` |
| `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` | dòng 6 — trỏ tới sổ tay, ghi nhận header `:3` stale |
| `MASTER_PLAN.md` | dòng 5 — ghi rõ file này KHÔNG phải bản kiểm kê việc còn mở; trỏ mục C |

## 5. Phương pháp kiểm chứng

- 2 audit agent chạy song song, đọc-only: coordination (23 root + reports + packets + gates) và `tasks/` (55 file).
- Coordinator **spot-check lại** thay vì tin report: đếm lại open-marker trên 5 file DONE của `tasks/`, trọng 5 file coordination root, 3 file template.
- Mọi claim từ review/report đều trở về `file:line` trên working tree hiện tại (theo memory `ldba-coordinator-delegated-authority`).
- Tìm ra 8 mâu thuẫn claim-vs-claim hoặc header-vs-chi-tiet (xem §3 của sổ tay), trong đó nặng nhất là `MASTER_PLAN.md:11` vs `:29` về F-VFY6-01.
- Đếm lại toàn bộ nguồn **sau** khi ghi file: root coordination 24 (23 cũ + sổ tay này), reports 806, dispatch-specs 253, packets 5, gates 6, reviews 538, `tasks/` 55, `_archive/` 3 file + 6 subdir. Con số trong bảng §1 đếm **trước** đợt ghi nên root=23, reports=805; sổ tay đã ghi số sau cho khớp trạng thái hiện tại.

## 6. Hành động ngoài phạm vi (chưa làm, cần quyết riêng)

- **Không** move `tasks/P3-connector.md`, `IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md`, `USER-AUTHORIZED-LIBS-MIGRATION-2026-10-05.md` dù được phân loại DONE — vì chúng được các file khác chiếu tới và/hoặc đang còn hiệu lực như overlay.
- **Không** động vào `coordination/reviews/` (538 file receipt đóng) và `coordination/dispatch-specs/` (253 file) — đều là kho lịch sử, không phải việc mở.
- **Không** tick gate nào, không commit, không `git add`, không push.

## 7. Hygiene

- 4 file coordinator viết mới/sửa: **0** ký tự nháy kép, **0** dòng trailing whitespace (đã đo bằng `grep -c`).
- 3 file pointer trong plan LIVE: **0** nháy kép ở các dòng thêm vào (đã đo `git diff | grep '^+'`).

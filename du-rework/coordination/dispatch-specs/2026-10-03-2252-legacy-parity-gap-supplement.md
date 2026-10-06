# Legacy→rework feature-coverage audit + BỔ SUNG task vào plan (Claude lane)

**Packet:** legacy-parity-gap-supplement | **Lane:** b103836b (Claude) | Dispatch 2026-10-03T22:52+07:00 (coordinator command-code) — **theo yêu cầu user**: "kiểm tra plan, nếu hết task thì chủ động review và bổ sung task cho plan".

**Bối cảnh:** các wave CONV/RFX/CRX/WTV đã đóng (WTV verify đủ receipt; chỉ còn commit/deletions chờ user). Queue dispatch đã cạn ⇒ chuyển sang chế độ chủ động: tìm capability legacy CHƯA được phản ánh trong plan và **bổ sung thành task rows**.

**Phạm vi (đọc trực tiếp — không suy đoán):**
- **Legacy (nguồn chân lý hành vi):** cây DUGate cũ ở repo root: `app/` (api + pages), `lib/`, `components/`, `scripts/` nếu có — ưu tiên admin/ops/config/profile/connector/auth/billing/webhook/storage trước.
- **Đối chiếu plan hiện có:** `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md`, `ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md`, `ADMIN-CONTROL-PLANE-UI-2026-10-02.md`, `ADMIN-LOCAL-AUTH-2026-09-30.md`, `ADMIN-OPS-UX-2026-09-24.md`, `API-COMPAT-DUGATE-2026-09-28.md`, `ORCH-REVIEW-FIXES-2026-10-02.md`, `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md`, `WORKTREE-VERIFY-COMMIT-2026-10-03.md`, `P9-business-backlog.md`, `SEC-OIDC-VAULT-2026-09-24.md`, `APP-ENCRYPTION-2026-09-27.md`, `DEPLOY-STORAGE-LOGGING-2026-09-24.md`, `PLAN-MISMATCH-FIXES-2026-09-23.md`, `REVIEW-FIXES-2026-09-23/24.md`, `P0..P8` backlogs.
- **Dedupe bắt buộc:** `coordination/reports/plan-open-task-register-2026-10-03.md` + toàn bộ `coordination/reports/*` liên quan (RECON A-I, tick-proposal, các ghi chú S1–S7/G2) + chính các plan trên — mỗi kết luận "THIẾU" phải kèm câu chứng minh: đã grep register/plans, không có row nào phủ.

**Mỗi capability legacy phân loại đúng 1 trong 3:**
(a) **có row plan** — cite ID + file:line;
(b) **đã implement ở rework** — cite code file:line (rework);
(c) **THIẾU** — không row nào phủ ⇒ **ứng viên bổ sung**.

**Deliverable:**
1. **Bảng coverage**: capability | legacy anchor (file:line) | (a/b/c) | ghi chú. Với (c): đề xuất row mới (ID, phạm vi, gap, acceptance, parents theo format hiện có).
2. **Bổ sung rows**: THÊM các row (c) vào plan phù hợp nhất theo scope (giữ đúng format row hiện có của file đó: `## ID — tên`, `[ ]`, mô tả, acceptance, parents). Nếu cụm gap không thuộc plan nào → tạo **MỘT** file addendum mới `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md` (mẫu: ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL — header trạng thái `SPECIFIED`, không tạo gate mới, không tick parent).
3. **Receipt** `coordination/reports/legacy-parity-gap-supplement-2026-10-03.md`: danh sách row mới + anchor + lý do; danh sách ứng viên ĐÃ BỎ vì trùng/đã phủ (dedupe evidence); mục "cần user/product quyết trước khi thành row"; mục "chưa phủ hết trong lượt này" (nếu có — nói thẳng, checkpoint theo nhóm).
4. Nếu phát hiện capability còn thiếu cả ở plan lẫn code mà thuộc loại "decision": ghi vào mục 3.3 như **đề xuất decision row**, không tự quyết.

**Ranh giới:** chỉ ghi `du-rework/tasks/*.md` + receipt. KHÔNG sửa code/source/test; không tick gate; không commit; không chạm `nocobase-10`. Không tự dispatch agent khác.

**Hard checks:**
- Mỗi row mới: anchor legacy `file:line` + dedupe statement (đã đối chiếu register + plans).
- Không trùng ID với plan hiện có; không tick bất kỳ row/gate nào.
- Không đổi nội dung các row đã có (chỉ thêm mới; ngoại lệ duy nhất: nếu phát hiện row cũ mô tả SAI làm sao để không trùng — ghi vào receipt, không tự sửa).

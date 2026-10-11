# BÀN GIAO QUYỀN ĐIỀU PHỐI → ANTIGRAVITY (`term_be856c75`) — 2026-10-09

**Bên chuyển giao:** phiên Claude Code `term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8` (điều phối theo
`COORDINATOR-CONTRACT.md` từ 2026-10-08).
**Bên nhận:** agent **Antigravity** — `term_be856c75-900d-474d-8405-ab3f178082b6`
(`agentIdentity: antigravity`, worktree `D:/Git/dugate`, branch `codex/fix-workflow-builder`).

**Lệnh của USER (nguyên văn):** "sau lượt điều phối này tôi muốn chuyển toàn bộ luồng điều phối task và agent
trả về cho agent antigraty đang chạy trong workspace hiện tại, hãy trao lại quyền điều phối và dừng lập lịch của
agent claude code hiện tại".

**Trạng thái từ lúc bàn giao:** 2 cron job của phiên Claude Code (`5dd6379e`, `25f793d5`) đã **xoá** ⇒
**không còn lịch điều phối nào chạy**. Claude Code giờ **idle**, chỉ trả lời khi USER gọi trực tiếp.
Antigravity là **single dispatcher** từ thời điểm này.

---

## 1. Quyền và ranh giới chuyển giao

| Việc | Claude Code (từ giờ) | Antigravity (từ giờ) |
|---|---|---|
| Dispatch task cho agent | **DỪNG** | **SỞ HỮU** |
| Lập lịch cycle (cron) | **DỪNG** (đã xoá cả 2 job) | tự quyết định |
| Đọc `orca terminal list` + `read` | chỉ khi USER yêu cầu | hằng chu kỳ |
| Self-verify receipt của agent | chỉ khi USER yêu cầu | **bắt buộc** ("không tin báo cáo của agent mà verify lại") |
| Sửa product / test / docs sản phẩm | **không** (contract) | **không** — coordinator chỉ ghi plan/report/dispatch metadata |
| Reconcile/tick gate ACCEPTED/VERIFIED/IMPLEMENTED | **không tự tick** | **không tự tick** |
| Commit / push / `git add` / `git checkout` | **không** | **không** (USER giữ quyền này) |
| Đọc/ghi `.env.live` | **không** | **không** |

Ràng buộc vẫn giữ nguyên khi chuyển quyền (không nới):
- **Live-gated không bao giờ tính PASS offline:** `migrations.test.ts`, `usage-summary.test.ts`,
  `artifact-grant-fencing.test.ts`, `artifacts-fencing-pg` + toàn bộ `liveSuites` trong `jest.unit.config.cjs`.
- **Không đọc/sửa `docs/21-openapi.json` bằng tay** — chỉ regenerate qua `tools/openapi/gen_openapi.py`.
- **Không lease overlap**; agent không tự verify fix do chính mình viết.
- **Không bỏ qua test đỏ.**
- UI thiếu dữ liệu ⇒ `unknown`/`unavailable` + timestamp mẫu gần nhất, **không** dùng `0`.
- Dispatch prompt file: **zero ký tự dấu nháy kép**, tiếng Việt ASCII không dấu, truyền qua
  `(Get-Content <file> -Raw)`.
- `orca terminal send` cần **UUID đầy đủ**; `input_accepted` **KHÔNG** phải bằng chứng đã nhận —
  phải `orca terminal read` lại rồi mới kết luận turn started.

---

## 2. Bối cảnh repo tại lúc bàn giao

- HEAD: `72e225ae5465e5a648c34bf31fbabbd182763233` · branch `codex/fix-workflow-builder` · **cây rất dirty, phần lớn uncommitted**.
- Scope: `D:/Git/dugate/du-rework` only. Legacy root `D:/Git/dugate` (Next.js app cũ) chỉ đọc để đối chiếu; `D:/Git/nocobase` không thuộc scope.
- **Đừng dùng `git status` làm thước đo dirty** — cây `du-rework/` dirty từ đầu. Kiểm chứng bằng **số học row/số test** và `git diff -- <path>`.
- `docs/21-openapi.json` chỉ regenerate, không hand-edit.
- `du-rework/.env.live` **không được** đọc hoặc in ra; `du-rework/.gitignore:8` đã ignore nó (đã kiểm chứng, không mất file).

---

## 3. SỐ LIỆU CẦN BIẾT — ĐÍNH CHÍNH MỘT KẾT LUẬN SAI CŨ

Trong `cycle-report-2026-10-09.md` §3 có một kết luận **đã bị đính chính**. Antigravity đọc file report
cũ sẽ thấy mâu thuẫn, phải theo mục này.

**Sai (đã ghi trước đó):** "hai receipt CODEX4/DSH5 bị phủ nhận, 22 failed / 193 passed / exit 1."

**Đúng (đã tái lập độc lập, xem `reports/coordinator-recheck-2026-10-09.md` §1):**

| Receipt | Kết quả | Xác nhận |
|---|---|---|
| `verify-tenant-usage-connector-INDEPENDENT-CODEX4-2026-10-09.md` | `15 passed, 15 total` / `215 passed, 215 total` / `REAL_EXIT=0` | **ĐÚNG** |
| `verify-tenant-usage-connector-INDEPENDENT-DSH5-2026-10-09.md` | `15 passed, 15 total` / `215 passed, 215 total` / `REAL_EXIT=0`, 36+31+148=215 | **ĐÚNG** |

Nguyên nhân đo lệch: `src/app/admin/shell-server.ts` ở trạng thái trung gian hỏng lúc đo (edit 23:36:47 đổi
`DEFAULT_ADMIN_WEB_PATH` thành `'admin'` mà thứ tự dispatch chưa sửa), fix rơi vào 00:10:34 (BFF check lên
trước + guard `isBffPath()`). **Cả hai edit đều chưa commit**, diff còn `14 insertions / 11 deletions`.
Không có receipt cho edit 00:10:34 — khoảng trống hồ sơ.

---

## 4. VIỆC NGAY (thứ tự đề xuất)

### 4.1 Ưu tiên 1 — regression `aweb08-per-route-flag` (đang đỏ, chặn admin-web)

```
cwd: D:/Git/dugate/du-rework/orchestrator/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb08-per-route-flag.test.ts
```

Coordinator đã tái lập: `REAL_EXIT=1`, `Test Suites: 1 failed, 1 total`, `Tests: 3 failed, 4 passed, 7 total`.
3 case đỏ ở `:120`, `:145`, `:157` — tất cả `/admin/web/*` trả **404** thay vì **200**.

Root cause: `src/app/admin/shell-server.ts:332` = `const DEFAULT_ADMIN_WEB_PATH = 'admin';`
`normalizeAdminWebPath` (:387-392) thêm `/` ở đầu ⇒ mount là `/admin` ⇒ `/admin/web/*` không match.
Suite inject `adminWeb: { distDir: DIST }` không kèm `path` (`tests/aweb08-per-route-flag.test.ts:80`) nên phụ thuộc DEFAULT.

**Fix (2 bước, phải fail-first):**
1. Khôi phục `DEFAULT_ADMIN_WEB_PATH = '/admin/web'`.
2. **GIỮ NGUYÊN** phần fix 00:10:34: BFF check đứng trước admin-web trong handler + `isBffPath()` guard trong `isAdminWebPath()` — đó là thứ làm leg 15-suite xanh, và nó **độc lập** với DEFAULT.

Verify bắt buộc: `aweb08-per-route-flag` **và** leg 15-suite (6 tenant + 3 usage + 6 connector) phải **xanh cùng lúc** trong 1 tiến trình. Đừng chấp nhận "một cái xanh, cái kia đỏ".

⚠️ Kỷ luật: agent sửa **không tự verify fix của mình** — tách 2 agent, hoặc đổi terminal.

### 4.2 Ưu tiên 2 — 2 owner wire-contract decisions còn mở (chặn artifact-read-authorization)

RED hiện tại: `5 failed / 85 passed / 90 total / exit 1` (node v24, ambient `NODE_ENV=production`).
Phân tích đầy đủ: `coordination/reports/` — deepseek-v4.1-flash, "GHI RÕ MỌI FAIL" (`term_3bdf6f85`).
Còn **2 quyết định** phải có owner, không tự quyết:
1. Artifact **not-READY** đọc bởi task khác ⇒ **409 + PERMISSION_DENIED** hay **403 forbidden()**?
2. **Lease expired** ⇒ **409 LEASE_LOST** hay **403 PERMISSION_DENIED**?
   (`LEASE_LOST@409` hiện bị ≥9 suite bind ⇒ đổi hướng là breaking.)

⚠️ Ngoài ra có **mâu thuẫn A-vs-A trong `docs/28-test-inventory.md`**: `:1323` nói lease-dead = 409 LEASE_LOST (khớp code),
`:1399` nói 403 (5 test đang bind 403). Phải chốt một hướng và sửa cả hai chỗ.

### 4.3 Ưu tiên 3 — AP-01..AP-05 (user đã duyệt, chưa có ai implement)

Đã self-check + DUYỆT, nằm trong `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` §5.
Phân tích: `reports/admin-portal-feature-analysis-2026-10-09.md`. Tất cả S–M, risk Low/None, không chạm backend.
Cần **chọn owner + khai exact file lease** trước khi giao. AP-01 (tenant scoping cho Profiles & Businesses) nên đi trước vì 2 screen đó đang thiếu tenant scope trong khi 6 screen khác đã có `TenantSelect`.

### 4.4 Ưu tiên 4 — sạch 2 file docs còn sai số/sai nghĩa

`docs/04-data-state.md:93` và `:100` — đã được nhiều review chỉ ra, **chưa ai sửa**:
- `:93` blanket "không chứa inline plaintext" sai trong backfill window.
- `:100` ghi "**7 slot**" nhưng `METADATA_SLOTS` trên đĩa có **8** (thiếu `step_checkpoints.session_ref`).
File này đang dirty dưới lease khác ⇒ **kiểm tra lease trước khi giao**.

---

## 5. Roster terminal tại lúc bàn giao (không tự ý cancel việc đang chạy)

| Terminal | Agent | Ghi chú |
|---|---|---|
| `term_be856c75` | **antigravity** | **bên nhận quyền điều phối** |
| `term_19edcad8` | claude | bên chuyển giao — idle, không còn lịch |
| `term_43f85ccc` | codex | idle (Node-version investigation xong) |
| `term_ca784044` | codex | test leg 1 (15-suite) — xong, receipt đã VALIDATE |
| `term_8bfe6adc` | dsh | test leg 2 (15-suite) — xong, receipt đã VALIDATE |
| `term_4bca69af` | qwen-code | idle |
| `term_16fef1c3` | qwen-code | pending: adjudicate 5 FAIL artifact-read-auth |
| `term_6bd1346d` | codex | idle |
| `term_3bdf6f85` | dsh | idle (đã giao analysis artifact-read-auth) |
| `term_d93ff3b1` | codex | idle |
| `term_f4f7687d` | codex | idle |

Handle cũ `term_ae2d7e42` (antigravity handle ghi trong `coordination/ANTIGRAVITY.md`) đã **`status: exited`** —
đừng gửi packet vào handle đó. Handle live hiện tại là `term_be856c75-900d-474d-8405-ab3f178082b6`.

Terminal `D:/Git/nocobase` và `term_3f5e1a6b` không thuộc scope du-rework.

---

## 6. Hồ sơ liên quan (đọc theo thứ tự)

1. `reports/coordinator-recheck-2026-10-09.md` — **đính chính + regression aweb08** (mới nhất, ưu tiên cao nhất)
2. `cycle-report-2026-10-09.md` — chu kỳ 10'/30' gần nhất (đã cập nhật §3 + §5)
3. `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` — canonical plan UBW-00..08 + AP-01..AP-05
4. `COORDINATOR-CONTRACT.md` — contract single dispatcher (giữ nguyên hiệu lực, chỉ đổi danh tính người giữ)
5. `admin-portal-feature-analysis-2026-10-09.md` — AP-01..AP-05 kèm file:line
6. `verify-tenant-usage-connector-INDEPENDENT-{CODEX4,DSH5}-2026-10-09.md` — 15-suite leg, **đã VALIDATE**
7. `HANDOFF-TO-ANTIGRAVITY-2026-09-24.md` — hồ sơ bàn giao trước, tham khảo về hình thức (nhiều phần đã lỗi thời)

---

## 7. Việc Claude Code còn lại sau bàn giao

- **Không.** Đã xoá cả 2 cron job. Không còn dispatch, không còn lập lịch.
- Chỉ trả lời khi USER gọi trực tiếp trong phiên này.
- Nếu Antigravity cần Claude Code làm gì, USER phải gọi trực tiếp — **không có đường tự động nữa**.

Không commit, không `git add`, không push, không tick gate, không đọc `.env.live`.
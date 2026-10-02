# Self-review plan — du-rework API compat (chu kỳ 30 phút)

> Owner: session `du-rework-api-compat` (Claude). Lịch tự động: cron `7,37 * * * *` (mỗi 30 phút, lệch 7 phút để tránh giờ chẵn).
> **Phạm vi (2026-10-01, user điều chỉnh):** chỉ kiểm tra **task/plan/coordination state**, rồi **điều phối agent xử lý task**. **KHÔNG đọc source code, KHÔNG review code.**

## 0. Scope mới (vượt trội mọi mục còn lại)

Thay vì kiểm tra MISMATCH plan-vs-code bằng cách đọc `server.ts`/`facade.ts`/contracts/OpenAPI, mỗi chu kỳ chỉ:

1. Đọc **plan/task docs + coordination state** để biết gate/blocker/lease/dispatch.
2. **Điều phối**: dispatch agent rảnh vào task chưa bị gate chặn, settle khi receipt về, nudge khi im lặng.
3. Ghi log. Không tự sửa source, không tự review code.

Nếu cần thông tin code (MISMATCH, hard-check), **giao cho agent** (characterization / tester), không tự đọc.

## 1. Mục tiêu mỗi chu kỳ

1. Giữ bảng phân rã sub-task trong plan khớp thực tế: đúng owner lane, đúng dispatch status, không giao trùng `server.ts`/contracts/OpenAPI/lockfile.
2. Mỗi lane rảnh luôn có task hợp lệ (ưu tiên fix lỗi/đỏ đã có evidence; tiếp theo là characterization read-only).
3. TUYỆT ĐỐI KHÔNG giao COMP-02..09 khi chưa có COMP-00; không mount `server.ts` song song 2 agent; không tick gate.
4. Thu thập thông tin từ agent khác qua reports/terminal, không đoán.

## 2. Các bước mỗi chu kỳ (chỉ docs + state)

- **B1 — Trạng thái plan/state:** đọc `API-COMPAT-DUGATE-2026-09-28.md` (COMP-00 tick? sub-task đổi status?), `tasks/README.md`, `CODE-REVIEW-FIXES-2026-10-01.md` (RV01-01..08 status), `ADMIN-LOCAL-AUTH-2026-09-30.md`, `coordinator-state.json`, `agent-watch-state.json`, `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md`. **Không mở file source.**
- **B2 — Trạng thái task packet (không kiểm code):** với mỗi packet đang chạy — owner/driver, dependency, blocker, receipt đã về chưa. MISMATCH đã biết chỉ được **ghi lại như backlog**, không tự xác minh bằng cách đọc code; muốn xác minh thì dispatch verification.
- **B3 — Va chạm ownership (từ state, không mở file):** `agent-watch-state.json` + dispatch spec xem hai dispatch có cùng chạm `server.ts`/contracts/OpenAPI không → serialize. Không mở file để xác nhận.
- **B4 — Thu thập từ agent khác:** đọc `coordination/reports/*.md` có receipt/blocker mới. Chỉ nhắn session lane du-rework; KHÔNG nhắn `nocobase-10`.
- **B5 — Re-plan / điều phối:** dispatch khi lane rảnh và task chưa bị gate chặn; settle khi receipt về. Sửa plan chỉ khi trigger §3.
- **B6 — Ghi log:** `coordination/reviews/YYYY-MM-DD-HHmm-review.md` (+ `-coordinator.md` nếu cycle điều phối): findings, dispatch/settle, blocker, next checks.

## 3. Trigger re-plan (chỉ sửa section phân rã sub-task)

- Roster/dispatch đổi (owner mới, dispatch failed/blocked, task đổi status).
- `COMP-00` / `LOCAL-00` có quyết định được chốt → mở gate `BLOCKED-COMP-00` / `BLOCKED-LOCAL-00` tương ứng.
- RV01-01..08 có packet đổi lease/gate/dependency.
- Test/verification receipt mới làm đổi per-wave status của `COMP-10-off/live`.
- Đề xuất selector/projection/encryption trong plan được Product/architect chốt hoặc bác.

## 4. Ranh giới cứng

- **Không đọc source code trong chu kỳ này.** Không mở `server.ts`, `facade.ts`, contracts, OpenAPI, manifest, lockfile, file của lane khác.
- **Không sửa source code** bất kỳ khi nào.
- **Không tự review code** — hard-check nếu cần thì dispatch cho agent (tester/characterization), rồi đọc receipt của họ.
- **Không tick gate:** không đổi `[ ]`/`[x]` của COMP/P0–P9/ENC/SEC/DATA/LOCAL/G* khi chưa có acceptance evidence.
- **Không copy lỗ hổng legacy:** client-supplied `x-api-key-id`/`apiKeyId`, ADMIN fallback, đọc operation không tenant fence, fake `CANCELLED`, balance bịa, plaintext fallback khi ENC bật.
- Cron job chỉ sống trong session này; nếu session restart phải tạo lại lịch.

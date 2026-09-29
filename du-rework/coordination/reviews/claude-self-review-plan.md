# Self-review plan — du-rework API compat (chu kỳ 30 phút)

> Owner: session `du-rework-api-compat` (Claude). Lịch tự động: cron `7,37 * * * *` (mỗi 30 phút, lệch 7 phút để tránh giờ chẵn).
> Phạm vi review: `du-rework/tasks/API-COMPAT-DUGATE-2026-09-28.md` (COMP-00..11 + bảng phân rã sub-task), `tasks/README.md`,
> `services/orchestrator/src/server.ts`, `src/modules/operations/facade.ts`, `packages/contracts`, `docs/21-openapi.json`,
> `businesses/document-core` manifest/recipes, và `coordination/coordinator-state.json` + `agent-watch-state.json` + `coordination/reports/*.md`.

## 1. Mục tiêu mỗi chu kỳ

1. Phát hiện sớm MISMATCH plan-vs-code và drift giữa các lane (orchestrator / document-core / contracts / docs).
2. Giữ bảng phân rã sub-task trong plan khớp thực tế: đúng owner lane, đúng dispatch status, không giao trùng `server.ts`/contracts/OpenAPI/lockfile.
3. Chỉ re-plan (sửa section phân rã trong plan COMP) khi có bằng chứng mới; không sửa source code trong chu kỳ review.
4. Thu thập thông tin từ agent khác qua kênh chính thức (reports, roster), không đoán.

## 2. Các bước mỗi chu kỳ (đọc trước, kết luận sau)

- **B1 — Trạng thái plan:** đọc `API-COMPAT-DUGATE-2026-09-28.md` (COMP-00 tick? sub-task nào đổi status?), `tasks/README.md`, `coordinator-state.json` (roster/turn/coordinator có đổi?), `agent-watch-state.json` (dispatch nào running/settled/failed/blocked mới?).
- **B2 — MISMATCH đã biết (kiểm tra còn đúng không):**
  - Legacy submit thực tế là `POST /api/v1/workflows` (`app/api/v1/workflows/route.ts:15`), không phải `/api/v1/docs/workflows`.
  - 31 legacy core variants vs 28 trong manifest (`extract:id-card`, `analyze:fact-check`, `analyze:summarize-eval` thiếu).
  - `facade.ts` progress luôn 0 (không đọc reportProgress); `/result` trả `{resultRef}` thay vì legacy `content/extracted_data/usage`.
  - Selector legacy-vs-canonical chưa được đặt tên trong plan (đề xuất `Accept: application/vnd.dugate.legacy+json`, decode một lần trong `route()`).
  - Scope encryption ENC-07 phải bao phủ toàn bộ legacy result đã project, không chỉ `{resultRef}`.
- **B3 — Va chạm ownership:** `server.ts`, `packages/contracts`, `docs/21-openapi.json`, lockfile chỉ một owner tại một thời điểm; các sub-task `COMP-03a/05/06/07/08` serialize cùng một owner orchestrator. Nếu `agent-watch-state.json` cho thấy hai dispatch cùng chạm `server.ts` → ghi HIGH và đề xuất serialize.
- **B4 — Thu thập từ agent khác:**
  - Đọc `coordination/reports/qwen-*.md`, `tester.md`, `review.md` có mục mới không (receipt/claim/blocker).
  - Chỉ nhắn `SendMessage` cho session thuộc lane du-rework; KHÔNG nhắn session dự án khác (ví dụ `nocobase-10` — không liên quan).
  - Khi cần review chéo code: spawn subagent (`general-purpose` hoặc `Plan`) với prompt read-only, scoped path rõ ràng; không giao implementation (dispatch là việc của Antigravity coordinator).
- **B5 — Quyết định re-plan:** chỉ sửa plan khi thuộc trigger ở §3. Sửa đúng section phân rã sub-task, giữ nguyên tick P0–P9/ENC/SEC/DATA và mọi release gate.
- **B6 — Ghi log:** append file `coordination/reviews/YYYY-MM-DD-HHmm-review.md`: cycle, findings (file:line), quyết định re-plan hoặc no-change, next checks.

## 3. Trigger re-plan (có ít nhất một mới sửa plan)

- Phát hiện MISMATCH mới có file:line cụ thể.
- `COMP-00` có quyết định được chốt → mở gate `BLOCKED-COMP-00` tương ứng trong bảng sub-task.
- Roster/dispatch đổi (owner lane mới, dispatch failed/blocked, P9-01..05 acceptance đổi).
- Test receipt mới làm đổi per-wave status của `COMP-10-off/live`.
- Đề xuất selector/projection/encryption trong plan được Product/architect chốt hoặc bác → cập nhật spec.

## 4. Ranh giới cứng (mọi chu kỳ phải tuân thủ)

- **Read-only với source:** chu kỳ review KHÔNG sửa `server.ts`, `facade.ts`, contracts, OpenAPI, manifest, lockfile, file của lane khác.
- **Không dispatch:** không gửi prompt implementation cho Qwen/Codex workers; Antigravity là dispatcher duy nhất (qua Orca).
- **Không copy lỗ hổng legacy:** client-supplied `x-api-key-id`/`apiKeyId`, ADMIN fallback, đọc operation không tenant fence, fake `CANCELLED`, balance bịa, plaintext fallback khi ENC bật.
- **Không tick gate:** không đổi `[ ]`/`[x]` của COMP hay bất kỳ packet/gate nào nếu chưa có acceptance evidence; chỉ điều phối viên tick sau đối chiếu.
- Cron job chỉ sống trong session này; nếu session restart phải tạo lại lịch.

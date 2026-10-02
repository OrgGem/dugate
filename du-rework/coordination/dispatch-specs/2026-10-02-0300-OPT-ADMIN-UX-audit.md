# OPT-ADMIN-UX — admin UI thân thiện, dễ dùng: audit + đề xuất (implement new-file-only)

## Mục tiêu

Admin orchestrator UI thân thiện, dễ sử dụng hơn: audit trải nghiệm các section
hiện có rồi đề xuất cải tiến cụ thể (loading/empty/error states, phân trang,
sort/filter, form validation feedback, accessibility, copy-once/revoke flows).
Đọc receipts lane khác (`PAR00-MAP` J01..J06, FUNCTEST-B admin render/view-model
suites xanh 140/140, 277, 193…) — trao đổi qua reports, không làm trùng.
Tiền lệ tốt: W47-C2 decision B (render cột Queue thật thay vì xóa assertion).

## Được phép làm

1. **UX audit (read-only):** đi qua từng admin section
   (businesses/profiles/connectors/api-keys/operations/overview/audit/crypto):
   renderer + view-model + fetcher, ghi bảng section × (loading? empty? error?
   pagination? sort? a11y label? destructive-confirm?) có file:line.
   Rerun suite offline liên quan để lấy evidence (ghi literal), KHÔNG chạy browser/live.
2. **Đề xuất cải tiến:** mỗi issue ghi mức (papercut / flow-breaker), proposal cụ thể
   (vd thêm cột, empty-state copy, confirm dialog, inline error), effort ước tính,
   và trạng thái `new-file-only được` / `cần sửa file cũ → patch-proposal + lease request`.
3. **Implement ngay CHỈ khi new-file-only:** prefix bắt buộc `opt-admin-ux-`.
   Cho phép: view-model/renderer variant mới (chưa wire), a11y/test draft,
   mock data hoặc story fixture cho section mới. Không wire vào router/shell.

## Cấm

- KHÔNG sửa bất kỳ file hiện có nào (source/test/config/tasks/plan),
  đặc biệt `shell-router.ts`/`shell-server.ts` (mount point serialize) và mọi renderer đang dùng.
- KHÔNG đổi behavior/API (chỉ UI/UX; mọi proposal đổi data-shape ghi `BLOCKED-...`).
- KHÔNG sửa `server.ts`, `contracts/src`, `businesses/document-core/**` (D3 lease),
  lockfile, `tasks/*.md`, `AGENTS.md`, execution overlay.
- KHÔNG chạy browser/live/infra test; KHÔNG claim DB window, KHÔNG `npm install`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (chỉ ghi nhận factual); proposal mới
  mặc định: secret không bao giờ render lại, destructive action có confirm + audit.

## Acceptance

Receipt → `coordination/reports/`
(`qwen-opt-admin-ux-audit-2026-10-02.md`):

1. Bảng audit UX từng section (file:line) + top 10 cải tiến xếp hạng (value/effort).
2. Mỗi cải tiến top: proposal đủ chi tiết để implement (file chạm, sketch, test plan),
   trạng thái (`new-file-only` / `patch-proposal + lease request`).
3. File mới tạo (nếu có): liệt kê + mục đích.

## COMMON

Task audit + đề xuất UX (không đổi public wire/behavior) → không cần COMP-00,
không va chạm lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có
COMP-00). New-file-only với prefix `opt-admin-ux-` để tránh va chạm. Không tái hiện
lỗi bảo mật legacy (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext
fallback, fake CANCELLED). Không tick gate. Không commit thay đổi lane khác.
Không nhắm nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution
overlay. Evidence là đầu vào quyết định, không phải blocker. DEV TEST ISOLATION
(lane này zero infra nên không cần).

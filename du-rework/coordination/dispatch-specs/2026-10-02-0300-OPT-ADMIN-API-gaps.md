# OPT-ADMIN-API — admin orchestrator thiếu gì: inventory + spec handler (implement new-file-only)

## Mục tiêu

Admin orchestrator đầy đủ chức năng hơn: inventory chính xác "UI có nút nhưng
backend thiếu handler" rồi viết spec handler sẵn sàng implement (DTO, validation,
auth/RBAC, audit, idempotency, test plan). Đọc receipts lane khác
(`PAR00-MAP` M01..M05, slice-E/G, FUNCTEST-B admin suites) — trao đổi qua reports,
không làm trùng.

## Được phép làm

1. **Inventory (read-only):** đối chiếu `src/app/admin/*section-renderer.ts`
   (form/action UI) với route/handler thật trong `server.ts` + `dispatcher.ts`:
   api-keys issue/revoke (M01: form có, handler mới chỉ có action chưa có HTTP route),
   profile publish/diff (M02), connector create/activate/retire proxy (M03),
   schema catalog (M04), user/key assignment (PAR-05), settings diagnostics (PAR-06).
   Ghi bảng UI-action × handler-thật × gap, có file:line.
2. **Spec handler (proposal, không code vào file cũ):** mỗi gap viết spec ngắn
   (method/path candidate, DTO, validation, auth+tenant fence, audit atomic,
   idempotency key, error shape, test plan tạo→dùng→revoke→401). Ghi rõ cái nào
   cần COMP-00/PAR-01 freeze (`BLOCKED-...`), cái nào READY-MODULE.
3. **Implement ngay CHỈ khi new-file-only:** prefix bắt buộc `opt-admin-api-`.
   Cho phép: fixture/spec-doc dạng code (vd JSON-schema draft, type draft),
   contract test draft aperta (fail-open, ghi rõ chưa wire). Không wire vào caller.

## Cấm

- KHÔNG sửa bất kỳ file hiện có nào (source/test/config/tasks/plan).
- KHÔNG tự freeze URL/DTO public mới (đó là PAR-01/COMP-02, đang blocked) —
  spec ghi `candidate`, chờ duyệt.
- KHÔNG sửa `server.ts` (single integrator), `contracts/src`,
  `businesses/document-core/**` (D3 lease), lockfile, `tasks/*.md`, `AGENTS.md`,
  execution overlay.
- KHÔNG chạy suite live/infra; KHÔNG claim DB window, KHÔNG `npm install`.
  Được rerun suite offline liên quan để lấy evidence (ghi literal).
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (form `apiKeyId`, ADMIN fallback… —
  spec handler MỚI phải dùng `resolveApiKey` + tenant fence, fail-closed;
  chỉ ghi nhận factual cái cũ).

## Acceptance

Receipt → `coordination/reports/` prefix `codex-`
(`codex-opt-admin-api-gaps-2026-10-02.md`):

1. Bảng UI-action × handler × gap (file:line cả hai phía), xếp hạng theo giá trị operator.
2. Mỗi gap top: spec handler đủ để lane sở hữu implement ngay (DTO + fence + audit + test plan).
3. Phân loại mỗi gap: `READY-MODULE` / `BLOCKED-COMP-00` / `BLOCKED-PAR-01` + lease request nếu cần.
4. File mới tạo (nếu có): liệt kê + mục đích.

## COMMON

Task inventory + spec (không đổi public wire) → không cần COMP-00, không va chạm
lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có COMP-00;
D3 lease worker.ts/manifest/recipes không đụng; rework encryption module không
đụng; `server.ts` single-integrator — lane này KHÔNG sửa server.ts).
New-file-only với prefix `opt-admin-api-` để tránh va chạm. Không tái hiện lỗi bảo mật
legacy (x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext
fallback, fake CANCELLED). Không tick gate. Không commit thay đổi lane khác.
Không nhắm nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution
overlay. Evidence là đầu vào quyết định, không phải blocker. DEV TEST ISOLATION
(lane này zero infra nên không cần).

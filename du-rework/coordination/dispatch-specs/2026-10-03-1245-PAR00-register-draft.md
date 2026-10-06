# PAR-00 (draft) — Cutover register cho PAR-11..17 (READ-ONLY)

**Packet:** par00-cutover-register-draft | **Lane:** cc_1 | Dispatch 2026-10-03T12:45+07:00 (coordinator command-code).

**Mục tiêu:** chuẩn bị bản NHÁP cutover register để Product ký PAR-00 — plan mới ghi rõ: "PAR-00 ký cutover register trước: dòng nào required/post-cutover/retire, gate đích, migration/rollback. PAR-11..17 không vượt register." Hiện PAR-00 vẫn `[ ]` nên PAR-11..17 chưa được dispatch implement.

**Nguồn (đã đọc trực tiếp, không tự bịa):**
- `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` (PAR-11..17 — addendum field-level)
- `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` (PAR-00..10)
- `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md` (PAR-XA-01..05)
- `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` (ACUI-00..10)
- `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md` (LOCAL-00..06)
- `coordination/reports/plan-open-task-register-2026-10-03.md`, `coordination/reports/tick-proposal-2026-10-03.md`, `coordination/reports/qwen-par00-evidence-map-2026-10-02.md`
- Legacy (đọc để phân loại): `app/api/internal/{apikeys,ext-connections,ext-overrides,profile-endpoints,user-profiles,workflow-schemas}/route.ts`, `app/api/settings/route.ts`, `lib/endpoints/profile-resolver.ts`

**Việc:** với TỪNG row PAR-11..17 (và parent row liên quan: PAR-01..09, ACUI-04/05/06/07, LOCAL-00..04, P9-04, ENC/DATA khi dính credential):
1. Phân loại **required (cutover-required) / post-cutover / retire** — kèm 1 dòng lý do (hành vi legacy nào buộc).
2. Gate đích (G-COMP / G-ADMIN-OPS / G-SEC / G-LOCAL-ADMIN / G-DATA / G-ENC / G6) — gate nào vẫn NO-GO (không tick gì).
3. Migration/rollback note (dữ liệu/credential/setting nào phải chuyển, fallback nào giữ).
4. Owner gợi ý + điều kiện chặn hiện tại (decision / infra / writer-lease).
5. Mục "cần Product chốt" (danh sách câu hỏi chốt được) + mục "không đủ dữ liệu để phân loại" (nói thẳng, không đoán).

**Ranh giới:** READ-ONLY. Chỉ ghi `du-rework/coordination/reports/par00-cutover-register-draft-2026-10-03.md`. Không sửa plan/source/test; không chạy test; không tick gate; không commit; không chạm `nocobase-10`.

**Định dạng:** bảng chính `row | class | gate | migration/rollback | owner | blocker`, rồi 2 mục trên. Tiếng Việt, file:line khi trích.

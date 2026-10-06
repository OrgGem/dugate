# Dispatch spec — AWEB-04 Profile vertical slice (2026-10-04 12:31 +07) — QUEUED sau AWEB-05

## Nguồn

- Plan Profiles **FINALIZED** (codex 12:28): `C:/Users/Gem/.claude/plans/typed-discovering-wall.md` — Phần 3 Nhóm F (T-UI-01..06), Phần 5 **Phase 3**: `T-API-01..03 → T-UI-01..04; T-UI-05 fence trước khi hiện dữ liệu tenant thật`; single-writer cho dispatcher + shared BFF routes; R-04 correction: legacy bulk `Promise.all` (không check từng response) → bản port dùng `Promise.allSettled` + per-row.
- AWEB plan slice **AWEB-04** (`tasks/ADMIN-WEB-DELIVERY-2026-10-04.md`); contract §3/§4/§6.
- Nền đã có: AWEB-01/02/03 (mount + BFF session/CSRF/envelope + fence pattern; primitives; browser harness).

## Việc cần làm

1. **Wire freeze trước UI** (contract §6.1): chốt DTO Profile + role matrix + URL + error taxonomy + fixture chung cho các route Profile (dựa T-API-01..03 từ backend lane) — ghi vào receipt trước khi viết màn; chỉ khởi động UI khi API thật tương ứng sẵn sàng (gated, không mock giả).
2. **BFF `/admin/api/profiles*`** trên nền AWEB-02 (session/fence/CSRF/envelope): list/detail/upsert/publish/rollback; **T-UI-05** — fence **chỉ Profile routes** (viewer read-only; scoped-user theo assignment + endpoint enabled; không platform bypass).
3. **UI (features/profiles)**:
   - T-UI-02: form/matrix — Save ghi thật → reload revision persisted; locked slots readonly+disabled+`data-locked`; priority select; extensions CSV; `fileUrlAuthConfig` write-only; connectionsOverride editor (ConnStep); prompt-override per-step (textarea + stepId).
   - T-UI-03: effective-config preview khi backend thật.
   - T-UI-04: bulk save `allSettled` + báo lỗi từng row; không rollback chung.
   - T-UI-06: Test Endpoint modal gated theo `POST /api/v1/admin/profile-test-endpoint`; nếu vượt ngân sách → tách follow-up, ghi rõ (không half-claim).
   - 409 giữ draft; 400 locked-field kể cả same-value; disabled/unknown fail-closed.
4. **Browser evidence** Profile journey (list/detail/save/preview/bulk/denied/states) trên harness; build/typecheck/regression.

## Gate

- Actions chỉ bật khi API thật + scoped BFF đã có; nhánh scoped-user chờ VFY-LOCAL (T-AUTH-03) — không mở trước.
- Single-writer: migrations/contracts/`dispatcher.ts`/`routes/admin.ts`/**shared BFF routes** — một owner tại một thời điểm (backend lane đang giữ trong Phase 1-3; coordinator cấp lease trước khi lane này chạm).

## Lease (dự kiến, chốt lại khi dispatch)

- **Sở hữu:** `apps/admin-web/src/features/profiles/**`, `src/routes/**` (Profile route), `src/lib/api/**` (Profile client), `bff` Profile routes (khi lease mở), `tests/browser/admin-web/**`.
- **KHÔNG sửa:** `components/ui/**`, `styles/**`, `app-shell/**` (Antigravity); migrations/`packages/contracts`/`docs/21-openapi.json` (backend single-writer); `server.ts`; `tasks/**`, `docs/**`. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb04-profiles-slice-2026-10-04.md` (+ wire-freeze section + browser evidence + gaps).

## Trạng thái

- **QUEUED** — dispatch cho **cc_1** ngay khi AWEB-05 hoàn tất (tránh chồng file `router.tsx`/`lib/api`/BFF). Deps: `task_2580a1b39c3e` (AWEB-05).

# ORV12-UI implementation receipt

Owner `/root/admin_ui`; packet coordination/ORV12-EXECUTION-2026-10-11.md; canonical plan tasks/ORCHESTRATOR-COMPATIBILITY-REVIEW-2026-10-11.md. Base HEAD7e36a1e plus existing uncommitted ORV11 changes. UI-only source lease respected; no backend product writes, commit, push or production mutation. Status IMPLEMENTED, independent browser/reviewer verdict pending.

## Paths and behavior

1. Settings scopes the editor to tenant/API key/endpoint, reads real effective configuration and revision history. Existing prompt editing now creates a draft through `settings.revision.create`; captures expected active and profile revisions; no immediate runtime change. It displays before/after diff, validates via `settings.revision.validate` (clearly no provider call), applies only validated revisions, and restores previous APPLIED snapshots through rollback creating a new revision. Baseline revision0 supported. History latest20 limit explicit. Scope changes clear configuration/editor and invalidate delayed reads/actions.
2. Connector revision edits select real ACTIVE connector revisions and send the complete slot map preserving unchanged slots. Shared-profile key count and backend refusal are visible. Current pin deep link opens actual connector revision. Profile page accepts business/version/name query coordinates; workflow detail links to relevant business profile and connector health. Schema slot allocation is no longer labeled as confirmed runtime binding.
3. Human review renders a bounded JSON Schema subset: nested objects, required properties, booleans, enums, strings and number/integer constraints. Forms preserve typed false/numeric values, validate required/min/max/string code-point lengths, and expose the original schema. Complex/unsupported assertions explicitly use advanced JSON with authoritative server validation. Toggling from invalid advanced JSON to guided mode cannot discard input. Encoded JSON-path DOM IDs avoid name collisions. Pending wait, operation revision, selected-detail and tenant/filter fences protect resume; a successful resume refreshes list before reopening detail.
4. Settings Migration readiness reads actual `/admin/api/legacy-migration/readiness?tenantId` (OPS/DATA owners) and shows source/imported/latest inventory counts, omitted/unreported counts as unknown, issue codes/counts, blob checks, external release gates and evidence hashes. Empty/missing/error are distinct. Cutover always on hold per DTO; no synthetic report is represented as customer approval.
5. Usage summary explicitly labels known accrued spend and measured/estimated/unpriced/pending/unknown cost state. Missing cost never becomes invented zero; unpriced zero does not imply free/final usage. Token measurement remains separate from cost classification. Raw backend projection remains available.

## Changed source scope

`orchestrator/apps/admin-web/src/features/settings/{settings-screen,configuration-revisions,migration-readiness}.tsx`; operations `review-schema.ts`, `review-input.tsx`, `operations-screen.tsx`; usage `cost-state.ts`, `usage-screen.tsx`; workflow/connector/profile screens for honest readiness/deep links; `lib/api/client.ts` and `types.ts`. UI owner unit tests `orchestrator/services/orchestrator/tests/orv12-ui-review-schema.test.ts` import pure frontend helpers. Backend revision service, migration0046, readiness route/BFF and migration0047 owned by other lanes.

## Owner checks (not independent acceptance)

Environment Node24.21.0/pnpm10.18.3; cwd `/workspace/dugate/du-rework/orchestrator`.

- `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv12-ui-review-schema.test.ts` — 8 passed,0 failed,0 skipped; exit0. Required/type/enum/range validation, nested optional behavior, advanced unsupported schemas, Unicode lengths, prototype pollution rejection and unknown/unpriced cost covered. Raw `coordination/reports/raw/orv12/ui-owner-tests.log`.
- `pnpm --filter @du/admin-web build` — TypeScript+Vite PASS exit0; raw `coordination/reports/raw/orv12/ui-owner-build.log`; final exact bundle below.
- Vite main chunk size warning remains; no production load-performance claim.

## Contract dependencies and remaining gates

OPS owns encrypted draft snapshots/revision CAS/audit/apply/rollback consumer behavior, real connector validation and authenticated readiness BFF. DATA owns provenance counts and release holds; USAGE owns cost classification semantics. UI owner smoke cannot establish these services' end-to-end behavior. Independent browser must exercise typed guided HITL→worker completion, advanced fallback, draft/diff/validate/apply/restore actual persistence, scope races and migration report read on exact final bundle. UI review required on desktop/mobile.

Legacy global AI/storage/format defaults are not blindly applied; this UI changes supported prompt and connector-pin consumers only. Provider health needs real connector probes and test operations; schema mapping or metadata configuration is not reported as healthy deployment. Customer snapshot/provider credentials/production cutover remain external gates.

Final owner handoff 2026-10-11T16:15:36Z: JS `index-CB-XGwBq.js`, SHA256 `ce016b33a352e4f357ff840ed6823de654590d75eacf070dc8e4e830e4ebbd41`; CSS `index-CxS70eJX.css`. Source frozen for independent browser/reviewer unless a finding requires correction.

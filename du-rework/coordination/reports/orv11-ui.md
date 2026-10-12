# ORV11-UI owner implementation receipt

Owner: `/root/admin_ui`. Canonical packet: coordination/ORV11-EXECUTION-2026-10-11.md; canonical plan: tasks/ORCHESTRATOR-COMPATIBILITY-REVIEW-2026-10-11.md. Base HEAD 7e36a1e. All product changes under du-rework; no commit/push. Status **IMPLEMENTED / independent verification and UI review pending**. This is owner smoke, not acceptance.

## Delivered producer/consumer paths

- Settings GET `/admin/api/settings` → authenticated backend `/api/v1/admin/settings` → real boot storage config and configured capability booleans. BFF narrows through `EffectiveSettingsSchema`, strips unknown fields; endpoint URL strips credentials/query. Unknown region/endpoint reported unconfigured rather than invented. Configured encryption does not claim healthy Vault.
- Settings write `settings.prompt.update` → dispatcher admin/CSRF gate → active tenant API key check → winning active document-core profile binding for exact endpoint (same specificity ordering; disabled exact profile blocks) → bounded `_default` prompt override → CAS `expectedUpdatedAt`, transaction audit/idempotency. Existing `connector_prompt_overrides` remains consumer; admission now uses legacy endpoint slug (API owner), snapshots sealed `operations.prompt_overrides_ref`; document-core uses exact connector prefix and step fallback. Read returns actual eligible slot/connection/revision choices. Arbitrary unbound UUID rejected. Existing exact-step rows read-only; named connectors visibly require legacy UUID mapping.
- Real `workflow.test` → tenant-scoped dispatcher → active selected key → exact displayed schema revision → normal submission/profile/connector/artifact admission → durable operation/outbox. UI polls real operation detail and provides operation/HITL link. Local simulation remains explicitly labeled and sends no request. Active key picker follows all server pages with scope cancellation.
- Workflow test primary file picker → client raw `File` upload to OPS-owned `/admin/api/operations/uploads` → encrypted artifact (OPS route+ownership) → returned references passed to actual test. 20 files / 16 MiB each client bounds; server authoritative. Advanced existing artifact JSON available but not primary. Typed JSON variables allow numbers/arrays/booleans.
- Operations keep stable Admin BFF URLs (OPS repoints internal backend). WAITING_INPUT detail shows OPEN human waits/input schema and JSON response → audited `operations.resume` with current state version. Refresh and download result use authenticated BFF. No API key is exposed for downloads.
- UI resets edited prompt/rows/revision and invalidates delayed loads/saves on tenant/key/endpoint scope changes; workflow requests similarly fenced. Mobile workflow header wraps.

## Files

`orchestrator/apps/admin-web/src/features/{settings,workflows,operations}/*-screen.tsx`, `lib/api/client.ts`, `lib/api/active-keys.ts`; orchestrator `modules/settings/settings.ts`, `modules/workflow-test/workflow-test.ts`, `modules/admin-actions/dispatcher.ts`, `http/routes/admin.ts`; `app/admin/bff/settings.ts` explicitly reassigned by OPS. Tests `orv11-ui-owner.test.ts`, `admin-action-dispatcher.test.ts`. SQL0045 reservation released unused.

## Owner evidence

CWD `/workspace/dugate/du-rework/orchestrator`; Node24.21.0/pnpm10.18.3 toolchain under `/workspace/scratch/orv11-toolchain`.

Commands:

- `pnpm --filter @du/orchestrator exec jest --runInBand tests/admin-action-dispatcher.test.ts tests/orv11-ui-owner.test.ts` — latest completed 75 passed / 0 failed / 0 skipped, exit0; raw `coordination/reports/raw/orv11/ui-owner-tests.log`.
- `pnpm --filter @du/admin-web build` — PASS exit0, source typecheck + Vite bundle; raw `coordination/reports/raw/orv11/ui-owner-build.log`. Final UI bundle `index-D6Ow5y8y.js` SHA256 `720734c2f44234474d0cef5fbcfcf94c6677ee3fa80aea1bd6700f3a134492dd`; CSS `index-Cq1C6dC4.css`.
- `pnpm --filter @du/orchestrator typecheck` — PASS exit0; raw `coordination/reports/raw/orv11/ui-owner-typecheck.log`.

Initial broad RBAC owner test found four stale matrix assumptions restricting operator to cancel/resume, despite preexisting workflow.provision/retire. Explicit tenant operator set reconciled to cancel/resume/provision/retire/test; viewers and missing tenant/CSRF still denied. No policy loosened to satisfy tests.

## Residual and acceptance gates

- Legacy global AI provider/model/five format prompts require explicit profile/connector revision mapping. Arbitrary global JSON storage would not be consumed. DATA archives unsupported globals and blocks reconciliation; this UI does not claim global settings parity or silently apply deployment config.
- This editor intentionally supports six core document endpoint `_default` fallbacks only, not arbitrary step/workflow global authoring; exact-step values remain readable and preserved. Code prompts and existing exact-step overrides retain precedence. Non-UUID connector identities cannot use legacy UUID override storage until explicit mapping.
- Storage credentials/retention/cache are deployment-owned; unknown credential state is not faked. No hot deployment writer was introduced.
- Independent browser actual save→new submission sealed prompt→worker application, workflow test/file→result, HITL resume and mobile review remain required on final bundle. Owner mocks alone do not establish live consumption. Verifier owns synthetic isolated PostgreSQL/Redis/browser harness; no real production infrastructure used.
- Vite warns main JS chunk exceeds500kB (existing bundle architecture), not a functional pass/fail gate.

Latest owner completion: 2026-10-11, Node24.21.0, final backend typecheck PASS after OPS upload type correction. Independent browser initially caught action grammar rejecting `settings.prompt-update`; corrected to `settings.prompt.update` across producer/consumer, rebuilt final bundle above. Earlier bundle receipts superseded.

Reopened final fix: independent real file upload→test found worker `LEGACY_WORKFLOW_INPUT_INVALID`: admin submission omitted filenames. Workflow-test now reads trusted READY/unexpired artifact filenames with the same tenant/key/operation ownership predicates as admission, orders names by requested artifact IDs, rejects missing/foreign metadata, and validates `LegacyWorkflowTaskInputSchema` before submit. Two new regression tests cover DB-order mismatch and missing metadata. Template copy no longer claims ready-to-test before profile/connector setup. Build above supersedes earlier bundles; new live rerun requested.

Final UX follow-up: independent live HITL resume200→workerSUCCEEDED passed but list refresh cleared the newly reopened detail. Resume now awaits list refresh before reopening its captured operation, and ignores stale responses when the selected tenant/filter population changes. Final admin build/typecheck PASS; final independent browser run requested on D6Ow5y8y.

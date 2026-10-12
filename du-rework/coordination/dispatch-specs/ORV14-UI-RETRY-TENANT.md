# ORV14 UI retry, tenant isolation and guided override corrections

Owner: existing `/root/orv14_restore_probe`, implementation role Luna6/max. Independent verifier: `/root/orv14_verification`; reviewer: `/root/orv14_ui_review` (parent model). Scope `du-rework`; canonical compatibility review section 6, CFGADM/AOPS requirements. Intake: `coordination/reports/orv14-ui-prefinal-review.md` P01–P05, CHANGES_REQUIRED. Original Journeys/Parity owners FINAL released. Backend explicitly released Docs only on 2026-10-12 after current c3d934 source freeze. Root's first followup delivery failed on active-thread limit; packet is not runtime dispatch proof until successful followup.

Exclusive product leases (relative to `du-rework/orchestrator`):

- `apps/admin-web/src/features/docs/docs-screen.tsx` — Backend release ACK, c3d934163290cc998ecb5bb998a060a0f86c86cf9503a4f84a89c6ba0afd570f.
- `apps/admin-web/src/features/workflows/workflows-screen.tsx` and `revision-editor.ts`.
- `apps/admin-web/src/features/connectors/parity-connector-editor.tsx` and `connectors-screen.tsx`.
- NEW unique owner tests; announce any genuinely necessary NEW bounded helper path before creation.

All shared client/contracts/central files, Profile, tokens and CostPolicyPanel remain read-only. Do not write restore helper/ports/docs53 again; those are frozen. No shared builds/dependency install/lockfiles/DB/Docker resources. Existing installed Node24.21 local tools for focused owner checks only. Writable owner report `coordination/reports/orv14-ui-admission-retry-owner.md` and unique `raw/orv14-ui-admission-retry-owner/**`. Announce unique feature guide path; never docs19/28/35.

Requirement IDs: ORV14-UI-ADMISSION-RETRY-01 (Docs Test Endpoint/Wizard), -02 (Connector provider test), -03 (workflow local files); ORV14-UI-TENANT-EDITOR-01; ORV14-UI-WORKFLOW-OVERRIDE-FORMS-01. Exact source diagnosis, original hashes and producer/consumer paths are in the independent review; read it before editing.

Required behavior:

1. Store exact immutable request/key/artifact references before admission dispatch. Keep them through lost response/status0/uncertain 5xx/UNKNOWN. Ordinary retry reconciles/replays the same body/key, never uploads again or allocates another charged operation. Completed terminal response can permit an explicit new run. Changed user input/File identity must not silently mutate a frozen uncertain attempt; expose appropriate pending/recovery state. Existing server checks of current tenant/role/key/Profile/revision remain authoritative. Preserve completed uploads across partial upload failures safely.
2. Tenant change clears recipe/CAS/replacement credential/files/result/reconcile state and fences late prior-tenant Profile/revision/test responses. Same Connector ID in two tenants cannot transfer A state into B. A failed B load stays unavailable without A state. Use component remount keyed by actual tenant plus appropriate async generation/abort safeguards; no server authorization weakening or raw-secret output.
3. Guided workflow node overrides must support bounded labeled static form fields and extra headers, alongside existing prompt/timeout/response path. Preserve imported values, sibling overrides and immutable running revision. Show review diff/CAS publish. Unsafe/secret headers remain server-rejected; no graph designer/wholesale DSL rewrite.

Owner meaningful focused regression/typecheck: lost accepted response and unchanged file-bearing exact retries, uncertain vs terminal states, partial upload, different File identity, delayed A-after-B and matching-ID isolation, guided override roundtrip/sibling preservation. Owner checks are IMPLEMENTED only. Primary performs independent served-browser lost-response/delayed-tenant/form journeys and real API/provider exact-once effects. Reviewer rechecks exact final bundle/source. Preserve historical red receipts and no final acceptance claims.

Send proposed state model/exports and exact source handoff hashes, owner command/cwd/time/pass/fail/skip/exit/raw receipts. Do not spawn agents or touch foreign/production resources. No commit/stage/push/reset/cutover.

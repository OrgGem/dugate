# ORV14 UI admission retry and tenant isolation owner receipt

Date: 2026-10-12 UTC. Owner: `/root/orv14_restore_probe`. Status: **IMPLEMENTED, owner checks pass; independent browser verification and UI review remain pending.** This report makes no `VERIFIED`, `APPROVED`, `UI_APPROVED`, or acceptance claim.

The Docs Test Endpoint and Prompt Wizard now snapshot a bounded deep-frozen JSON request and its idempotency key before admission. They retain uncertain requests through transport loss, timeout/rate-limit/server failures, and after later authorization/conflict responses; exact retry reuses the saved body/key. Positively accepted operation IDs stay locked until terminal operation status. Upload, test and wizard in-flight state is tenant-scoped, and delayed results cannot overwrite the currently selected tenant's view.

Connector provider tests likewise save the original request before dispatch, retain UNKNOWN/lost-response attempts, reuse file uploads only for the same `File` object and tenant/API-key context, and expose exact source-evidence reconciliation. The editor remounts by selected tenant; its unresolved attempt registry is keyed by that tenant, so late A responses remain attached to A and never populate B's editor. Current server session, tenant, Profile, key and revision checks remain in force. Workflow attempts are keyed by tenant to prevent a different workflow/revision from bypassing an unresolved attempt; terminal polling uses that same tenant key to release a confirmed operation.

The guided workflow revision editor now has bounded static-form-field and extra-header controls, preserves imported static value types, and validates duplicate/unsafe names and protected headers. Updating a guided override copies the selected node while preserving sibling fields, sibling overrides, unknown imports and other nodes; existing diff/CAS publication remains the review and write path.

Owner checks at 2026-10-12 04:42:56 UTC used pinned Node v24.21.0:

- `PATH=/opt/codex/cua_node/bin:$PATH ./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` from `orchestrator/apps/admin-web`: exit 0, no diagnostics.
- `PATH=/opt/codex/cua_node/bin:$PATH ./node_modules/.bin/jest --runInBand --config jest.unit.config.cjs tests/orv14-ui-admission-retry-owner.test.ts` from `orchestrator/services/orchestrator`: exit 0, 1 suite / 7 tests passed, 0 failed, 0 skipped.
- Scoped `git diff --check` from `orchestrator`: exit 0.

The exact command receipts and source SHA-256 values are in [raw owner receipt](raw/orv14-ui-admission-retry-owner/run-20261012T044256Z.json). These checks cover immutable attempt transitions and static/header parse/update behavior. They do not substitute for the independent served-browser lost-ACK/exact-once, partial-upload/File identity, delayed tenant A/B, real API/provider, or final full-bundle checks assigned to Primary and the separate reviewer.

Changed owner leaves (all paths relative to `orchestrator/`):

| File | SHA-256 |
| --- | --- |
| `apps/admin-web/src/features/docs/docs-screen.tsx` | `4ab1071f707336cc42817a869b93f89f08b876881cf253197592cbf031fb9ab0` |
| `apps/admin-web/src/features/workflows/workflows-screen.tsx` | `2a8fba343a15c34908f765434e44628a9af65c17a96842160197dfe06f923410` |
| `apps/admin-web/src/features/workflows/revision-editor.ts` | `6e097d0f8b73ed64372989caf7afed4e33f4f83d4635bc96dd6c62bed9482176` |
| `apps/admin-web/src/features/connectors/parity-connector-editor.tsx` | `0ca3442b91a8a4a319b414c403c5f79bd5445afd9bcd3145a08f7185e48e6e03` |
| `apps/admin-web/src/features/connectors/connectors-screen.tsx` | `8cfd67a9f660d5e1a581070c64d3822f1cfb132107de2639a19efb208b6036ef` |
| `apps/admin-web/src/features/submissions/immutable-attempt.ts` | `2acb9cca9bbd7fc6a8b191d82a77948b236290f8b54c62f138d5082d4150c58f` |
| `services/orchestrator/tests/orv14-ui-admission-retry-owner.test.ts` | `1d9e0965b3069f6d23db8d076ce21d053f101ee9ccc0ea827b2707a3b9ca3291` |

# UI13-SETTINGS owner receipt

Status: **IMPLEMENTED; focused owner smoke passed; independent review and exact-build browser verification pending.** Source freeze: 2026-10-11 17:22 UTC. No deployment, provider call, production mutation, commit or push.

## Delivered behavior

- Replaced the nine freeform/datalist endpoint values with a grouped selector for all 31 core endpoints. The settings allowlist matches `services/orchestrator/src/modules/settings/endpoints.ts`; workflow schema endpoints are excluded because this adapter rejects them.
- Bound loaded settings to the exact selected tenant, API key and endpoint. The screen checks the server echoed scope before exposing configuration, invalidates it during refresh/scope changes, ignores stale responses, and locks mutation requests against double-clicks. The immutable revision API still owns CAS, dependency revalidation, audit, encryption and apply/restore.
- Kept unsubmitted prompt and pin editor changes in memory under their tenant/key/endpoint scope. Switching away hides the old settings immediately; returning to that scope restores its editor draft. These local edits are not represented as server drafts until the operator creates one.
- Rendered the selected key/endpoint, resolved profile ID/revision/key count, connector slot/adapter/revision and prompt fallback target. Connector choices come from the existing revision catalog and are limited to active global or selected-tenant entries. Pin edits are disabled for a profile with more than one active key; backend validation still enforces the exact endpoint profile requirement because the existing read DTO does not expose that profile field. The screen does not render connector configuration or credential material.
- Made permission state explicit. Session permission must load before mutation controls enable; only an admin role with the backend configuration capability can create, validate, apply or restore. Apply/restore require a second, scoped confirmation. Draft, validation (no provider request), apply (new submissions only) and restore (new applied revision after dependency checks) remain separate steps.
- Kept exact-step prompt rows read-only and `_default` as the only prompt write target. Legacy connector IDs without a UUID mapping are labeled and cannot be submitted to the existing prompt write contract.
- Limited effective storage diagnostics to backend, bucket, region and endpoint. Endpoint userinfo, query and fragment are stripped defensively; unparseable endpoints render as unavailable. Secret values are not rendered.
- Added responsive labels, scope/loading/empty/error/role status, keyboard-focusable revision details, and retry for an unavailable effective deployment read.

## Native adapter path and limits

The screen consumes the existing Admin Web BFF (`GET /admin/api/settings`, `POST /admin/api/actions` for `settings.revision.create|validate|apply|rollback`). The orchestrator owns revision snapshots and encrypted payloads, profile/prompt effective writes and dependency checks. The actual consumer uses those values for new submissions. No API, BFF, database or shared component changes were made in this packet.

The 17 mapped legacy keys remain only partially represented by this real adapter. Keys are `ai_provider`, `ai_api_key`, `ai_model`, `openai_api_key`, `openai_base_url`; `ai_image_prompt`, `ai_pdf_prompt`, `ai_docx_prompt`, `ai_compare_prompt`, `ai_generate_prompt`; `s3_endpoint`, `s3_bucket`, `s3_access_key`, `s3_secret_key`, `s3_region`, `s3_cache_ttl_hours`; and `api_secret_key` (retire decision pending its consumer inventory).

Global AI provider/model defaults and the five global format prompt defaults have no global application action here. The shipped native editor can create scoped prompt fallback revisions and pin an existing Connector revision on an exact single-key endpoint profile; it does not apply global defaults to every business. Provider credentials remain owned by Connector/Secrets. Storage reads are sanitized deployment values with `managedBy=deployment` and `restartRequired=true`; there is no UI write/apply adapter for S3 or retention. The assigned host is Docker Compose, so the remaining storage/global runtime controls require the separate host runtime adapter. Config validation is not a provider test. Exact-step editing, a global settings write surface, storage apply/restart, and provider health are not claimed.

## Owner checks

Environment: cwd `/workspace/dugate/du-rework/orchestrator`; Node `v24.19.0`, pnpm `11.25.0` (repository package engine expects Node `>=24.21.0 <25` and the prior ORV12 toolchain used pnpm `10.18.3`). The direct binaries below avoided running an install or package build script.

- `cd /workspace/dugate/du-rework/orchestrator/services/orchestrator && ./node_modules/.bin/jest --runInBand tests/orv13-settings-ui.test.ts` — **5 passed, 0 failed, 0 skipped; exit 0** at 2026-10-11 17:22 UTC. It verifies all 31 backend/UI endpoint slugs, endpoint exclusion, scope-key uniqueness, wrong-tenant/key/endpoint response denial, legacy UUID validation and storage diagnostic sanitization. Raw: `raw/orv13-settings/ui-contract-tests.log`.
- `cd /workspace/dugate/du-rework/orchestrator && node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p apps/admin-web/tsconfig.json` — **PASS, exit 0** at 2026-10-11 17:22 UTC. Raw: `raw/orv13-settings/admin-web-typecheck.log`.
- `git diff --check -- orchestrator/apps/admin-web/src/features/settings orchestrator/services/orchestrator/tests/orv13-settings-ui.test.ts` — exit 0.

No Admin Web build was started because the root coordinator reserved build sequencing with the independent browser tester. No browser run or screenshots are claimed. Exact-build review and browser tenant/race/mobile/keyboard evidence remain required before acceptance; this receipt is owner evidence only. Source hashes: `raw/orv13-settings/source-sha256.txt`.

# Independent verification: COMP-03b compatibility decoders

**Mode:** read-only verification. Read the prior receipt `codex-rework-compat-decoders-2026-10-01.md` first, then checked the current source and tests directly. No reviewed source or test file was edited. No gate was changed.

## 1. Credential and identity fields — FAIL (partial rejection)

**Body fields:** `apiKeyId`, `api_key_id`, `xApiKeyId`, `tenantId`, `userId`, `authorization`, and `role` appear in the body deny-list at `services/orchestrator/src/compat/legacy-input-decoders.ts:139-155`; `assertNoIdentityFields` rejects exact/camelized matches at `:354-361`. The decoder calls that guard before decoding at `:248-249`.

**Headers:** `x-api-key-id` and `x_api_key_id` plus `x-tenant-id` and `x-user-id` are listed at `:157-163` and rejected case-insensitively at `:340-350`. However, `authorization` is not in the header deny-list. Nor are header spellings such as `apiKeyId`, `api_key_id`, `xApiKeyId`, `tenantId`, `userId`, or `role`. Those header values are ignored by this decoder, but they are not rejected. This does not satisfy the requested reject-not-honor check for identity-looking fields supplied as headers.

`x-api-key` is documented as the only legitimate credential header and is not copied into the decoded output (`:136-138`; positive-control test at `services/orchestrator/tests/compat-decoders.test.ts:325-336`). The decoder itself does not resolve credentials: it reads only `idempotency-key` and `x-correlation-id` from headers (`legacy-input-decoders.ts:318-320`). A search of both reviewed files found no `ADMIN_TOKEN`, `ADMIN_KEY`, `adminToken`, or bearer/admin-key fallback branch. The header-gap finding above is about missing rejection, not evidence that this module selects identity from those headers.

## 2. Terminal state and error fabrication — PASS at the serializer boundary

`LEGACY_TERMINAL_STATES` lists exactly `SUCCEEDED`, `FAILED`, `CANCELLED`, and `TIMED_OUT` (`services/orchestrator/src/compat/legacy-operation-serializers.ts:58-64`). The legacy state map translates supplied `CANCELLED` and `TIMED_OUT` to legacy `FAILED` (`:66-79`). `done` is computed only by membership of the supplied `operation.state` (`:160-168`); there is no request flag, timestamp, or inference branch that makes an operation terminal.

The serializer adds a result only for supplied `SUCCEEDED` (`:185-203`), and adds an error only for supplied `FAILED` when `operation.error` exists (`:205-214`). Supplied `CANCELLED`/`TIMED_OUT` states produce neither block (`:216-219`). Tests cover `CANCEL_REQUESTED`, absent errors, and supplied `CANCELLED` (`compat-decoders.test.ts:409-437`). This boundary trusts its caller to pass the real persisted canonical state; the module cannot independently verify that provenance.

## 3. Unknown-field strictness and unattached registry parameters — FAIL (strict for body/form, not the full request)

For body/form fields, the decoder builds a per-action/per-variant allow-list and invokes `assertNoUnknownFields` (`legacy-input-decoders.ts:262-277`); the guard throws `UNKNOWN_FIELD` for a field outside that set (`:374-382`). The registry declares these seven `PARAMS` names at `D:\Git\dugate\lib\endpoints\registry.ts:39-62`, but no `PARAMS.<name>` attachment for them exists in that registry:

| Registry-declared, unattached name | Current decoder behavior |
|---|---|
| `type` | Not a variant parameter. It is also the required `extract` discriminator (`legacy-input-decoders.ts:50-53`), so it is consumed for `extract`; as an extra field on other actions it is rejected by the allow-list. |
| `focus_areas` | Rejected as `UNKNOWN_FIELD`. |
| `target_language` | Rejected as `UNKNOWN_FIELD`. |
| `glossary` | Rejected as `UNKNOWN_FIELD`. |
| `redact_patterns` | Rejected as `UNKNOWN_FIELD`. |
| `max_words` | Rejected as `UNKNOWN_FIELD`. |
| `audience` | Rejected as `UNKNOWN_FIELD`. |

The six non-discriminator names are explicitly tested as rejected extras (`compat-decoders.test.ts:226-236`). The test's orphan array omits `type`; its discriminator collision means `type` is not tested as an extra on a non-`extract` action.

Strictness does not cover arbitrary query keys. `collectFields` explicitly skips `query` (`legacy-input-decoders.ts:498-508`), while the entry point reads only `query.sync` (`:318-320`). Other query parameters are silently ignored, so the whole request envelope is not strict. This is the second reason this hard check is not a full PASS.

## 4. Purity and route mounting — PASS

Import list from the current files:

- `legacy-input-decoders.ts:34`: `SubmissionSchema` and the `Submission` type from `@du/contracts`; the schema is used to validate the produced DTO (`:314-315`).
- `legacy-operation-serializers.ts:31-35`: `decodeAdminResourceListSortCursor`, `encodeAdminResourceListSortCursor`, and the cursor type from `@du/contracts`.

There are no imports of contract mutation functions, `server.ts`, or `main.ts` in either module. A symbol search across `services/orchestrator/src` found only the decoder/serializer definitions and their internal calls, no route import or mount. This is consistent with the module comments at `legacy-input-decoders.ts:4-6` and `legacy-operation-serializers.ts:4-5`. The contract imports are schema/cursor helpers, not mutation paths.

## 5. `next_page_token` dialect — PASS; the values are different

The serializer delegates encode/decode to the shared four-slot cursor functions (`legacy-operation-serializers.ts:274-287`). The contract codec encodes `micros | encodedId | sortCode | direction` as base64url (`packages/contracts/src/public-api.ts:409-427`); tests cover encode/decode round-trip and pagination token decoding (`compat-decoders.test.ts:457-495`). The round trip preserves the cursor values, while timestamp text is normalized to six fractional digits (`:467-473`).

The sibling `legacy-operations.ts` dialect is the bare operation ID (`services/orchestrator/src/compat/legacy-operations.ts:7-10, 222-234`). For operation ID `bbbbbbbb-2222-4222-8222-222222222222`, timestamp `2026-10-01T00:00:00.000Z`, sort `createdAt:desc`, direction `next`:

- `legacy-operations.ts`: `bbbbbbbb-2222-4222-8222-222222222222`
- four-slot serializer: `aG1zZzFqcGMwMHxiYmJiYmJiYi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjJ8Y0R8bg`
- decoded cursor payload: `hmsg1jpc00|bbbbbbbb-2222-4222-8222-222222222222|cD|n`

The cursor token was produced with the built `@du/contracts` encoder and decoded successfully; it is not the bare ID. This records the existing dialect mismatch as a fact for COMP-00.

## Test and mutation evidence

- Command from `D:\Git\dugate\du-rework\services\orchestrator`: `npx jest --runInBand tests/compat-decoders.test.ts`
- Literal result: **Tests: 43 passed, 43 total**; exit code 0.
- Scratch mutation: copied the reviewed modules and suite under `tests/__scratch_legacy_decoders_mutation`, replaced only the scratch copy's `assertNoUnknownFields` with a no-op, and ran the copied suite. Result: 3 failed, 40 passed, exit code 1. This confirms the unknown-body-field tests fail when that guard is removed.
- Restored the scratch decoder from the reviewed source and byte-verified with SHA-256: both hashes were `AD157EF36A220B9CBA22CC01D991BDC70C2DE4C51C034739E2330CE646D7E01B`. The source hash was unchanged. Scratch files and directories were removed.
- Not run: TypeScript typecheck, other test suites, or a live route check. No route mounts these modules in the searched source tree.

## Defects, ordered by severity

1. **Medium — incomplete header rejection:** identity deny-list is incomplete for headers. In particular, an `authorization` header and the listed body-style identity spellings used as header names are ignored instead of rejected (`legacy-input-decoders.ts:157-163, 340-350`). The decoder does not honor those values, but the hard check requires rejection.
2. **Low — request strictness is limited:** unknown body/form fields are rejected, but unknown query keys are dropped because `collectFields` skips query and only `sync` is read (`legacy-input-decoders.ts:318-320, 498-508`).
3. **Low — orphan `type` coverage/description:** the registry declares `PARAMS.type` without attaching it (`D:\Git\dugate\lib\endpoints\registry.ts:43`), while the decoder reserves `type` as the `extract` discriminator (`legacy-input-decoders.ts:50-53`). The current orphan test covers six names, not this discriminator collision (`compat-decoders.test.ts:226-236`).

No source edits, gate ticks, or commits were made.

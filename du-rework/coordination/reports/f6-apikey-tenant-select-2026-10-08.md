# F-6 API-key tenant selector — 2026-10-08

Scope: `du-rework`. No commit or push. No checklist row was marked VERIFIED or ACCEPTED.

## Change

- `orchestrator/services/orchestrator/src/app/admin/api-key-section-data.ts:188-201,258-270` now loads the tenant roster alongside API-key data using the existing fail-closed `fetchTenantOptions` reader. The rendered fetch result carries roster options; missing credentials, transport errors, or non-2xx roster responses produce no invented options.
- `orchestrator/services/orchestrator/src/app/admin/api-key-section-renderer.ts:252-281,287-296,348-356` renders a required `<select name="tenantId" aria-label="Tenant">`. The blank `Select a tenant` placeholder remains selected when no current tenant is in the roster. Option labels are tenant names, with ` (STATE)` for non-ACTIVE rows; IDs appear as option values. The create form keeps its POST action and hidden CSRF field. With no roster, the required select contains only the blank placeholder, so the browser cannot submit an empty tenant.
- Added `orchestrator/services/orchestrator/tests/f6-api-key-tenant-select-offline.test.ts` with 2 cases: roster-backed labels/form semantics, and a failed roster read with a stale selected tenant failing closed.

## Fail-first log

The new tests were run before product edits. Both failed against the original free-text field. Literal Jest failure excerpt:

```text
FAIL tests/f6-api-key-tenant-select-offline.test.ts
  F-6 API-key tenant select (offline)
    renders roster names as labels and preserves form/CSRF semantics

expect(received).toContain(expected) // indexOf

Expected substring: "<select name=\"tenantId\" aria-label=\"Tenant\" required>"
The received HTML contained this exact old field:
<label for="apiKeyTenantId">Tenant ID</label><input id="apiKeyTenantId" name="tenantId" type="text" maxlength="64" required>
Failure locations: tests/f6-api-key-tenant-select-offline.test.ts:64:18 and :86:18

Tests: 2 failed, 2 total
EXIT_CODE=1
```

Command (cwd `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`):

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent --runTestsByPath tests/f6-api-key-tenant-select-offline.test.ts
Exit code: 1
```

After the renderer/data change, the same command passed: 1 suite, 2 tests, exit code 0.

## Mutation control

Temporarily restored the old free-text `renderCreateForm` output, ran the new suite, then restored the fixed renderer bytes. The mutation made both tests fail on the same expected `<select>` assertion (2 failed, 2 total; Jest exit code 1).

```text
Expected substring: "<select name=\"tenantId\" aria-label=\"Tenant\" required>"
The received HTML contained this exact old field:
<label for="apiKeyTenantId">Tenant ID</label><input id="apiKeyTenantId" name="tenantId" type="text" maxlength="64" required>
JEST_EXIT_CODE=1
```

SHA-256 before mutation → after restore:

- `api-key-section-renderer.ts`: `111799b5b05f33f5974be4310e3d1e813720c8f441a53ce2bdc9884d4f0be3cc` → same hash.
- `api-key-section-data.ts`: `6bfb2d7c54e8fdd117b70982768a577c779e295f850c29222e6236886e2a8033` → same hash.

Both hashes were checked again after the final verification. The F-6 suite passed again after restoring the source: 1 suite, 2 tests, exit code 0.

## Requested verification

Working directory for all commands below: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

The wildcard paths were expanded to the following Jest command. `jest.unit.config.cjs` ignores `admin-shell-live-pane.test.ts` as a live suite, so Jest selected 12 suites:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent --runTestsByPath tests/f6-api-key-tenant-select-offline.test.ts tests/admin-api-key-render.test.ts tests/admin-api-key-view-model.test.ts tests/admin-api-keys.test.ts tests/admin-shell-auth.test.ts tests/admin-shell-live-pane.test.ts tests/admin-shell-oidc-flow-integration.test.ts tests/admin-shell-oidc-mount.test.ts tests/admin-shell-platform-mount.test.ts tests/admin-shell-render.test.ts tests/admin-shell-router.test.ts tests/admin-shell-server.test.ts tests/admin-shell-session-lifecycle.test.ts
Exit code: 1
Test Suites: 1 failed, 11 passed, 12 total
Tests: 1 failed, 367 passed, 368 total
```

The unrelated failure was in `tests/admin-shell-session-lifecycle.test.ts:821`: expected `record.event` to equal the `auth.login_failed` event, but received `undefined`. It was left unchanged. The F-6 suite was among the passing suites.

Typecheck:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Exit code: 0
```

## Limits

The new coverage uses injected offline `fetch`; it does not submit the form in a real browser or exercise actual API-key issuance. The unit Jest config excludes the live-pane suite, so no live shell, PostgreSQL, or Redis integration was tested. No unrelated failing tests were changed.

# Receipt BIZ-01 — Business Services offline integration checks

- **Recorded:** 2026-10-11
- **Result:** Offline integration checks pass; full Business Detail Cockpit remains unimplemented.
- **Scope:** Admin Web business registry and version detail harness, plus profile workflow binding ownership checks.

## Checks added

- Added `orchestrator/apps/admin-web/tests/business-services-integration.test.mjs`. The offline fetch harness exercises the real Admin API client, business and version parsers, workflow binding read/write requests, tenant query fencing, CSRF and idempotency headers, and rejection of workflow pages for a different business or version.
- Added screen wiring checks for the existing Businesses registry/version detail and the profile workflow selector.
- Extended `orchestrator/services/orchestrator/tests/aweb-14-workflow-business-offline.test.ts` with a negative case where a matching workflow slug and revision exist under another business. The binding request returns NOT_FOUND and performs no insert.

## Verification

- **Admin Web offline integration harness — PASS, 3/3 tests, exit 0.**
  - Command: `node --test tests/business-services-integration.test.mjs`
  - Working directory: `du-rework/orchestrator/apps/admin-web`
- **Orchestrator workflow ownership suite — PASS, 8/8 tests, exit 0.**
  - Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/aweb-14-workflow-business-offline.test.ts`
  - Working directory: `du-rework/orchestrator/services/orchestrator`
- Both checks ran offline with mocked BFF responses and fake database queries; no database or external service was used.

## Limits and boundary

- The current Admin Web Business screen exposes registry rows and a version detail panel. It does not yet compose worker inventory, profile bindings, and workflow schema bindings into the full cockpit described in the architecture review. These checks cover shipped paths and ownership fences; they do not claim full cockpit acceptance.
- No product source was changed. No gate was ticked. No git add, commit, or push was run.

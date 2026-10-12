# ORV12-CALLBACK — owner handoff

Status: IMPLEMENTED; independent verification and UI/backend review pending. No commit, production change or cutover claimed.

## Contract and scope

GET internal operations/:id/deliveries (BFF same suffix) returns sanitized delivery items: ID, status, attempts/maxAttempts, safe failure code, next attempt, retry capability and disabled reason. Dispatcher action operations.callback.retry accepts operationId, deliveryId and expectedAttempts; caller supplies scoped transaction, RBAC, CSRF, audit and idempotency. Helper fences tenant/deleted operation, locks delivery, requires FAILED/current attempts, checks pinned destination policy and actual dispatcher/auth capabilities. It preserves operation, tasks, payload, ID, pinned policy, consumed attempts and existing cap; exhausted rows gain one attempt, cumulative ceiling10. Callback UI explicitly warns about duplicate recipient processing and reuses delivery ID; dispatch remains at least once. This does not invoke a business provider.

Fresh operation retry coalesces existing active child first, then checks operation/all-task unknown invocation error codes and current API-key spending limit before new execution. UNKNOWN UI disables detail retry with reconciliation guidance. Root error-free list can still defer child-only uncertainty to authoritative backend rejection.

Native Profiles now supports all31 core endpoint selectors and configured ACTIVE connector revision mapping for initial slots, sent only when creating revision0. Endpoint selection seeds matching action row. Existing policy edits omit connectorBindings and preserve pins through SET backend. Slot names must match the real business/workflow requirements; UI does not claim connector health. Logout includes session CSRF token.

## Owner evidence

2026-10-11, cwd /workspace/dugate/du-rework/orchestrator, Node24.21.0/pnpm10.18.3:

- pnpm --filter @du/admin-web build: exit0. Bundle index-DYRIRIfm.js, SHA256 0ab292f776d094a6efddb15cb243744c8ab3926aa4d7c4cc50447d43646b0eac; CSS index-DmD_oz0m.css. Bundler reports existing large chunk warning.
- pnpm --filter @du/orchestrator typecheck: exit0.
- pnpm --filter @du/orchestrator exec jest --runInBand tests/orv12-callback-owner.test.ts tests/orv12-ui-review-schema.test.ts: exit0,15passed/0failed/0skipped. These are owner checks, not independent acceptance.
- Raw: coordination/reports/raw/orv12/callback-{ui-build,typecheck,owner-tests}.log.

Independent DATA callback tests and VFY exact-bundle real browser native-profile→settings, guided HITL and callback journeys pending. This bundle supersedes earlier ORV12 UI hashes.

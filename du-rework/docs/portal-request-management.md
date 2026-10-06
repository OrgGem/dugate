# Portal request management ? PORTAL-REQUEST-CONTROL-20261006

Route: `/admin/web/operations`. The Portal calls its same-origin BFF; credentials stay on the server.

## List and detail

`GET /admin/api/operations?limit=20&state=ALL&sort=created_at:desc` forwards the canonical operations list. Page sizes are 20/50/100. Previous/Next use server keyset cursors; changing state or page size resets the cursor. The default is newest creation time first, with the backend UUID tie-breaker. Total is the backend filtered count. Cursors retain PostgreSQL microsecond precision independently of display timestamps; backward pages retain the adjacent Next link.

`GET /admin/api/operations/:id` returns `{operation, requestInput?, result, artifacts, tasks, serverNow}`. Request input is redacted by the server. Task summaries expose ID/key/kind/state/attempt/maxAttempts/errorCode, never task payloads, credentials or raw stack traces.

## Stop and retry

- `POST /admin/api/operations/:id/cancel`, body `{}`: Stop delegates `operations.cancel` through `/api/v1/admin/actions`. Admin and tenant-scoped operator may stop; viewer is denied. Tenant scope comes from the authenticated session credential. Operation/tasks/human waits are cancelled through the existing lifecycle service. Already-issued external side effects cannot be undone.
- `POST /admin/api/operations/:id/retry`, body `{}`: platform admin only. Delegates `operations.retry` through the audited dispatcher. Only FAILED/CANCELLED/TIMED_OUT are eligible. A new operation/task/outbox is created, linked by `retryOf`, with fresh attempts/timing and no copied checkpoints. Original terminal state/timestamps remain unchanged. Business version, profile policy/bindings, prompt pins and callback are retained from the original request. Current worker/grant authorization still applies.
- Mutations require session authentication, `X-CSRF-Token`, and use `Idempotency-Key`. No tenant/input overrides are accepted on these BFF control paths. The UI confirms the action, locks controls while pending and retains a mutation key after failure for safe resubmission. Concurrent retries coalesce while a retry child is active.
- Original input and prompt metadata are read using the configured encryption read policy, then resealed for the new tenant/slot/row identities. Ciphertexts cannot be copied between operation/task IDs. Any failure rolls back operation, task, outbox, audit and idempotency marker together.
- Expired/deleted input artifact references or cached source versions return 409 `RETRY_INPUT_UNAVAILABLE`. Retry never replaces missing cached input with empty input. Pending source acquisition is retried through the existing ingestion gate (including IAM S3 authorization); acquired inputs retain their immutable source version.

## Timing and retention

Migration `0034_operation_execution_times.sql` adds `started_at`, `completed_at`, `retry_of`, and an internal provenance flag. A database trigger records first RUNNING and first terminal transition, and preserves these facts on subsequent updates. It also freezes creation time and rejects reopening a terminal operation.

- `createdAt`: request creation time.
- `startedAt`: first RUNNING, not a later attempt or maintenance event.
- `completedAt`: first SUCCEEDED/FAILED/CANCELLED/TIMED_OUT, independent of artifact expiry/deletion or file cache cleanup.
- `updatedAt`: metadata update time; **never a completion timestamp**.
- Total elapsed: `completedAt - createdAt`, including queue and waits.
- Execution elapsed: `completedAt - startedAt`, including waits/retries within the operation; this is not CPU time.
- Active elapsed uses the detail `serverNow` or the list observation time. Terminal elapsed never uses the current time.

Historical times are not backfilled from updatedAt because maintenance may have changed it. Historical terminal requests with unknown completion display Unknown. Historical active requests do not gain a fabricated start from a cron/maintenance update; a future terminal transition can still record its actual completion. Every new retry gets its own timestamps.

Apply migration 0034 and deploy the matching backend/Portal build together. This implementation has owner unit/isolated PostgreSQL/browser evidence; independent tester/backend/UI acceptance remains open. See `coordination/reports/portal-request-controls-2026-10-06.md`.

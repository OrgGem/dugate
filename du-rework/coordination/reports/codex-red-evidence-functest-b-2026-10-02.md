# FUNCTEST-B RED-EVIDENCE — isolated reruns and production trace

Date: 2026-10-02. Scope was read-only: reran only the two specified Jest files, then inspected their production and neighboring test paths. No source, test, config, task, or gate files were changed; no infra was used.

## 1. ADM-BASE-03 deferred-section logging

### Isolated rerun

Command, run from `du-rework/services/orchestrator`:

```text
npx jest --runInBand tests/adm-base-03-safe-error-offline.functional.test.ts
```

Exit code: **1**. Jest reported `Test Suites: 1 failed, 1 total` and `Tests: 1 failed, 18 passed, 19 total`.

Failing test: `ADM-BASE-03 admin shell boundary (real HTTP, no DB) › throwing section fetcher → 500 without sentinel on the wire or in the log`.

Failure excerpt:

```text
expect(received).toContain(expected)
Expected substring: "deferred section render error"
Received string:    ""
  208 |     expect(logText).not.toContain(SENTINEL_DSN);
  209 |     // The operator keeps a joinable, class-only signal.
> 210 |     expect(logText).toContain('deferred section render error');
      |                     ^
  211 |     expect(logText).toMatch(/errorClass/);
      at Object.<anonymous> (tests/adm-base-03-safe-error-offline.functional.test.ts:210:21)
```

The same run emitted this structured production log line to the Jest output (correlation ID shortened here):

```json
{"subsystem":"admin-shell","errorClass":"Error","timestamp":"2026-10-01T19:51:08.710Z","level":"error","service":"orchestrator","version":"unknown","environment":"test","correlationId":"b87a9cd2-…","operationId":null,"taskId":null,"invocationId":null,"message":"[admin-shell] deferred section render error"}
```

### Production path and fixture

- The fixture installs `sectionFetchers.businesses`, increments `calls`, then throws an `Error` containing test sentinels: `tests/adm-base-03-safe-error-offline.functional.test.ts:149-162`. It signs an admin cookie and requests `/admin/businesses?businessId=biz-sentinel`: `:171-194`.
- The router returns the businesses page as HTTP 200 with deferred extras when the businesses fetcher is configured: `src/app/admin/shell-router.ts:603-609`. `resolveBusinessExtras` calls the injected fetcher at `:694-713`; its rejection is therefore the fixture-driven failure.
- The live shell listener builds the request, dispatches it, and passes the response to `writeResponse`: `src/app/admin/shell-server.ts:395-398`. `writeResponseAsync` catches a deferred section error, logs only `errorClass` plus correlation ID, and retains the base response: `:169-201`. The test's own `res.status` expectation is 200 at `tests/adm-base-03-safe-error-offline.functional.test.ts:197-199` and passes. The test title's “→ 500” is stale relative to both that assertion and the observed production path.
- The logger is created at `src/app/admin/shell-server.ts:43`. `@du/observability`'s default `consoleSink` writes a single JSON record to `process.stdout`: `packages/observability/src/logger.ts:27-30`; the logger defaults to that sink at `:98` and writes the serialized record at `:163`.
- The test replaces `console.error` and collects those calls at `tests/adm-base-03-safe-error-offline.functional.test.ts:173-204`. That spy does not observe the logger's `process.stdout.write`, so `logged` is empty despite the emitted JSON record. The request/body sentinel assertions pass; the actual log carries `errorClass: "Error"` and the fixed message, not the thrown sentinel message.

### Neighboring green comparison

`tests/admin-shell-server.test.ts` passed **56/56** in the FUNCTEST-B run. Its real HTTP deferred-business test at `:339-405`, especially the GET /admin/businesses case at `:367`, covers the successful renderer/fetcher path and response composition, but does not assert error-log capture. Within the failing suite, the non-network helpers and structural redaction pins pass; the only failure is the logger capture assertion.

### Verdict and lane-owner note

**Verdict: assertion/capture-target drift — high confidence.** The production path emits the expected class-only JSON log record; the test spies on a different output API. No evidence here indicates a change in the safe response or redaction behavior.

Suggested test-owner follow-up (no change made): capture the `process.stdout` structured record or provide an injected logger sink, then assert its parsed `message` and `errorClass` fields. Keep the sentinel-exclusion assertions and align the test title with the asserted 200 degraded response.

## 2. Default admin-shell security-event sink

### Isolated rerun

Command, run from `du-rework/services/orchestrator`:

```text
npx jest --runInBand tests/admin-shell-session-lifecycle.test.ts
```

Exit code: **1**. Jest reported `Test Suites: 1 failed, 1 total` and `Tests: 1 failed, 50 passed, 51 total`.

Failing test: `W-SEC-AUDIT-TAXONOMY-1 default console sink through the REAL shell listener › mount default: a bad token over the socket logs exactly one parseable, sentinel-free security line`.

Failure excerpt:

```text
expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0
Received array:  []
  788 |     );
  789 |     warn.mockRestore();
> 790 |     expect(lines).toHaveLength(1);
      |                   ^
  791 |     const first = lines[0];
      at Object.<anonymous> (tests/admin-shell-session-lifecycle.test.ts:790:19)
```

The same run emitted this structured production log line to Jest output (correlation ID shortened):

```json
{"subsystem":"admin-shell","event":{"kind":"auth.login_failed","reason":"invalid_token","method":"POST","pathname":"/admin/login"},"timestamp":"2026-10-01T19:51:28.689Z","level":"warn","service":"orchestrator","version":"unknown","environment":"test","correlationId":"4f82c943-…","operationId":null,"taskId":null,"invocationId":null,"message":"[admin-shell] security event"}
```

### Production path and fixture

- The test installs `jest.spyOn(console, 'warn')`, mounts `createAdminShellServer` without a `securityAudit` override, and posts an invalid-token form containing a sentinel via the real loopback listener: `tests/admin-shell-session-lifecycle.test.ts:777-795`.
- `createAdminShellServer` supplies the default audit sink when no override is passed; that sink calls `logger.warn('[admin-shell] security event', { event })`: `src/app/admin/shell-server.ts:348-352`.
- The listener parses the request and dispatches it through the shell router: `src/app/admin/shell-server.ts:395-398`. `handleLoginPost` rejects an invalid token and emits the closed `auth.login_failed` event with reason, method, and pathname only: `src/app/admin/shell-router.ts:1112-1128`.
- The default logger sink is not `console.warn`: `packages/observability/src/logger.ts:27-30` writes one serialized record to `process.stdout`; `:98` selects that default and `:163` writes one JSON string. The test instead filters `console.warn.mock.calls`, expecting a prefixed first argument and a second JSON argument at `tests/admin-shell-session-lifecycle.test.ts:778, 786-795`. That call shape cannot match the actual sink. The stdout line contains the expected event and does not contain the submitted sentinel.

### Neighboring green comparison

In the same file, the injected-sink router tests pass: `captureSink()` is defined at `tests/admin-shell-session-lifecycle.test.ts:592-595`, and `auth.login_failed: exactly one closed event...` injects it and verifies the event and sentinel exclusion at `:598-607`. Those tests exercise event construction without the mounted default logger. In addition, `tests/admin-shell-server.test.ts` passed **56/56** in FUNCTEST-B, including the real HTTP business-section path (`:339-405`); it does not assert the default audit logger's console method/argument shape.

### Verdict and lane-owner note

**Verdict: assertion/capture-format drift — high confidence.** The failed test observes zero `console.warn` calls, but the production default sink emits a JSON line through stdout; the emitted line contains the intended `auth.login_failed` event. No evidence indicates the authentication rejection or audit event was skipped.

Suggested test-owner follow-up (no change made): capture and parse the actual stdout JSON record (or inject an audit/logger sink), then assert `message === '[admin-shell] security event'` and the nested event object, retaining the sentinel-absence check.

## Summary

Both failures reproduce in isolated runs with exit code 1. In each case production emits the safe structured record, while the test captures a different sink/API and expects a different argument shape. Evidence supports **assertion drift, high confidence**, rather than a fixture mismatch or missing production log behavior. No fix was applied, no suite outside the two requested files was run, and no DB/Redis/S3/Docker infrastructure was used.

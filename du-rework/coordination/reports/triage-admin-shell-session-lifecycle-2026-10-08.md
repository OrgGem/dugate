# Triage receipt: admin shell session lifecycle

Status: BLOCKER — product output defect requires a source change outside this lease.
Date: 2026-10-08
Scope: `du-rework` only. Test lease: `orchestrator/services/orchestrator/tests/admin-shell-session-lifecycle.test.ts`.
Execution: offline loopback HTTP only; no database was used and no DB window is claimed.
Gate: not ticked. No ACCEPTED or VERIFIED status claimed.

## Literal RED

Ran the requested command from `orchestrator/services/orchestrator` before any test changes:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts
```

Exit code: 1. Result: 1 suite failed; 1 test failed, 50 passed. Literal failing assertion at `tests/admin-shell-session-lifecycle.test.ts:821:26`:

```text
expect(received).toEqual(expected) // deep equality
Expected: {"kind":"auth.login_failed","method":"POST","pathname":"/admin/login","reason":"invalid_token"}
Received: undefined
```

The failure is at `expect(record.event)`, after `expect(lines).toHaveLength(1)` passed. Thus `undefined` is `record.event`; it does not mean the stdout spy saw zero matching lines.

## Root cause and classification

(a) The test captures the real default sink. It spies on `process.stdout.write`, starts `createAdminShellServer`, listens on an OS-assigned port, and sends a real `fetch` POST to `/admin/login` through `postLoginWithConnectRetry`. The default `consoleSink` in `@du/observability` writes to `process.stdout.write`. The matching security-message line count assertion passed, proving the capture observed one such line from this request.

(b) The product reaches the sink but loses the security payload during serialization. The bad-token branch in `src/app/admin/auth-dispatch.ts` calls `securityAudit` with the expected `auth.login_failed` event. The default sink in `src/app/admin/shell-server.ts` passes it to `logger.warn('[admin-shell] security event', { event })`. `@du/observability/src/logger.ts` serializes through `metadataLogRecord`; in `@du/observability/src/log-metadata.ts`, `event` is an allowed identifier only when its value is a scalar. The supplied object value is omitted. The emitted line therefore has the security message but no `event` field. This is a product serialization/wiring defect; the assertion correctly detects the missing audit details.

(c) Ambient environment is not the cause. With launcher `DU_ADMIN_COOKIE_SECURE` unset, the requested run failed as above (exit 1). Re-ran the same Jest command with `DU_ADMIN_COOKIE_SECURE=enforce`; it failed at the same `record.event` assertion with the same 1 failed / 50 passed result (exit 1). The cookie policy branch does not restore the dropped event. Other inspected launcher values `NODE_ENV` and `DU_ADMIN_TRUST_PROXY_PROTOCOL` were unset in the baseline shell; the test's cookie-policy describe pins and restores those knobs.

Classification: test capture is correct; product output is missing the structured event payload; tested ambient cookie-policy setting does not affect the RED.

## Changes and verification

- No test or product source was changed. The assertion was not weakened or removed.
- Requested TypeScript check: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — exit code 0, no output.
- GREEN test literal: none. The required Jest command remains RED (exit code 1); it cannot be made green within the test-only lease without weakening a correct assertion. Product owner must repair the default sink/serialization path under an explicit source lease, then rerun this test.
- No files outside this receipt and the leased test were touched by this triage; the leased test remains unchanged. Pre-existing worktree changes were preserved.

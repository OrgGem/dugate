# WSD-SYNCPOST-VERIFY — independent offline receipt

Date: 2026-10-02. Verification-only; no source or test files were changed, no gate was ticked, and no commit was made.

## Identity and scope

- CWD for commands: `D:\Git\dugate\du-rework`
- `git rev-parse HEAD`: `b088eececcb5f3df0b4edbe073a29401dafda624` (`b088eec`)
- Inspected the commit diff scoped to `packages/worker-sdk`. It adds `parseReportedErrorCode` and routes non-401/403/409 non-2xx responses through it in `packages/worker-sdk/src/connector-invoker.ts:99-116,194-210`. The 401/403 and 409 branches remain separate at `:168-193`. The commit does not change `packages/worker-sdk/src/worker.ts` (confirmed by an empty `git diff b088eec^ b088eec -- packages/worker-sdk/src/worker.ts`).

## Behavior checks

| Spec assertion | Evidence in current commit | Result |
|---|---|---|
| (a) 400 `PROVIDER_REQUEST_REJECTED` is preserved | The generic non-2xx branch reads the response body and uses a recognized reported code, falling back only when absent/invalid (`connector-invoker.ts:194-210`; parser validation `:99-116`). The new direct-400 case asserts `PROVIDER_REQUEST_REJECTED` rather than the status fallback `INVALID_INPUT` (`tests/connector-sync-post-code.test.ts:71-76`). A 502 envelope representing a provider HTTP-400 refusal also retains its code and detail (`:51-60`). | **PASS** |
| (b) 502 `PROVIDER_UNAVAILABLE` remains `PROVIDER_UNAVAILABLE` | The 502 outage case asserts status 502 and that code (`tests/connector-sync-post-code.test.ts:63-69`). | **PASS** |
| (c) Existing 401/403/409 handling is unchanged | The status-specific branches remain at `connector-invoker.ts:168-193`; tests assert 401/`GRANT_INVALID`, 403/`BINDING_DENIED`, and 409/`CONNECTOR_DISABLED` (`tests/connector-sync-post-code.test.ts:121-141`). | **PASS** |
| Retry semantics do not change | `classifyFailure` still sets retryable from status 429 or 503, after excluding the four non-retryable connector codes (`worker.ts:509-520`). The commit has no `worker.ts` diff. Tests assert refusal non-retryable, 503 outage retryable, and a 503 envelope carrying each protected code does not flip retryability (`connector-sync-post-code.test.ts:89-118`). Existing status matrix also covers 500/502/503/504 (`connector-invoker.test.ts:297-315`). | **PASS** |

Nuance: the direct 400 fallback in the pre-change status mapping was `INVALID_INPUT`; the reported `PROVIDER_UNAVAILABLE` flattening described by the dispatch spec is demonstrated by the connector's 502 wrapper around a provider 400. Both the direct 400 and wrapped 502 refusal cases are covered by the new test.

## Test and typecheck receipts

### Focused suites

- Command: `pnpm --filter @du/worker-sdk test -- tests/connector-sync-post-code.test.ts tests/connector-invoker.test.ts`
- CWD: `D:\Git\dugate\du-rework`
- Exit code: **0**
- Literal Jest summary:

```text
Test Suites: 2 passed, 2 total
Tests:       55 passed, 55 total
Snapshots:   0 total
Time:        2.119 s
Ran all test suites matching tests/connector-sync-post-code.test.ts|tests/connector-invoker.test.ts.
```

### Full Worker SDK suite

- Command: `pnpm --filter @du/worker-sdk test`
- CWD: `D:\Git\dugate\du-rework`
- Exit code: **0**
- Literal Jest summary:

```text
Test Suites: 25 passed, 25 total
Tests:       669 passed, 669 total
Snapshots:   0 total
Time:        142.935 s, estimated 154 s
Ran all test suites.
```

This matches the VFY-REG refresh count of 669/669 and is 19 tests above the pre-WSD 650/650 reference; no test failed.

### Typecheck

- Command: `pnpm --filter @du/worker-sdk exec tsc --noEmit`
- CWD: `D:\Git\dugate\du-rework`
- Exit code: **0**
- Diagnostics: none.

## Limits of this verification

The focused tests exercise mocked `fetch` responses and verify the SDK's parsing/classification behavior; this run did not contact a deployed Connector service or verify a release artifact. It confirms the checked-in `b088eec` source and tests plus package typecheck, not deployment or real-network behavior.

## Verdict

**WSD-SYNCPOST behavior verified offline: PASS** for code preservation, 401/403/409 regression cases, and unchanged status-based retry classification. No gate was ticked.

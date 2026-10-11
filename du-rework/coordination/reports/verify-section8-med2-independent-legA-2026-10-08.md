# Independent verification: WFA section 8 MED-2, leg A

RESUME POINT: FAIL-FOUND — focused MED-2 verification passed; required regression suite 3 has one failing test.

Scope: du-rework only. Read-only verification; no product source or test file was changed. Offline suites only; no live DB/window was used or claimed.

Node: C:\nvm4w\nodejs\node.exe, v22.16.0.
Test cwd for all commands: D:\Git\dugate\du-rework\orchestrator\services\orchestrator.

## Command results

| Exact command | cwd | Exit code | Literal test summary |
|---|---|---:|---|
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json | D:\Git\dugate\du-rework\orchestrator\services\orchestrator | 0 | Not a test command; no output |
| node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/wfa-section8-med2-existence-oracle.test.ts | D:\Git\dugate\du-rework\orchestrator\services\orchestrator | 0 | Test Suites: 1 passed, 1 total; Tests:       2 passed, 2 total |
| node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-public-artifact.test.ts tests/public-upload-encryption-gateway.test.ts tests/rcr-http-offline.functional.test.ts | D:\Git\dugate\du-rework\orchestrator\services\orchestrator | 1 | Test Suites: 1 failed, 2 passed, 3 total; Tests:       1 failed, 21 passed, 22 total |

Command 3 red, preserved: FAIL tests/public-upload-encryption-gateway.test.ts, test “completes the public grant, binary upload, finalize replay, and submit route journey”; diagnostic: unexpected test DB query: UPDATE artifacts SET operation_id=$2 WHERE id = ANY($1::uuid[]) AND tenant_id=$3 AND state='READY' AND operation_id IS NULL AND task_id IS NULL. Stack: test fixture rejects the query at tests/public-upload-encryption-gateway.test.ts:386; submit call at :550-555; public route dispatch at public.ts:393-405; production query originates at submission.ts:659-665. This POST submission path does not call the MED-2 fenced operation read helper or the workflow result api_key_id fence, so the observed failure is unrelated to MED-2 by call path. No claim is made about when this test fixture failure was introduced; it was not suppressed or retried.

## Hash checkpoints

| File | SHA-256 |
|---|---|
| orchestrator/services/orchestrator/src/http/routes/public.ts before first run | E17EE5BF94E6CFB85C2334B3DCDE26866EF31D9B949631349311BFE51D8C3FB7 |
| orchestrator/services/orchestrator/src/http/routes/public.ts after command 1 | E17EE5BF94E6CFB85C2334B3DCDE26866EF31D9B949631349311BFE51D8C3FB7 |
| orchestrator/services/orchestrator/src/http/routes/public.ts after command 2 | E17EE5BF94E6CFB85C2334B3DCDE26866EF31D9B949631349311BFE51D8C3FB7 |
| orchestrator/services/orchestrator/src/http/routes/public.ts after command 3 / final review | E17EE5BF94E6CFB85C2334B3DCDE26866EF31D9B949631349311BFE51D8C3FB7 |

Hash stayed unchanged; no concurrent edit blocker detected.

## Code review

- a — PASS. public.ts:66-70 rewrites only a recognized HttpError with status 404 and code NOT_FOUND. Other status/code combinations are rethrown unchanged. getFencedOperation invokes the normalizer at :73-83.
- b — PASS. public.ts:489-498 fences the tenant-operator detail read and wraps the second buildAdminOperationDetail read with the same normalizer.
- c — PASS. public.ts:525-535 applies the api_key_id comparison only when endpoint_slug is a string beginning workflows:. The tenant fence remains separate; the profile fence does not apply to other API-key operation result endpoints.
- d — PASS, with a specificity note. tests/wfa-section8-med2-existence-oracle.test.ts:58-69 serializes caught HttpError through toProblem; :91 and :115-116 compare the full serialized problem body for missing vs foreign cases. Thus it tests body equality, not merely that an error was thrown. It does not separately assert each body field against a literal expected value.

## RED findings

- One required regression test is red: public-upload-encryption-gateway.test.ts, as detailed above.
- Focused MED-2 test: 2/2 pass. Typecheck: exit 0.
- No live database test was run.

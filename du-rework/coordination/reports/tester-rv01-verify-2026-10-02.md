# RV01 loopback HTTP findings — independent verification

READ-ONLY verification; no production/test source was edited, no gate was changed, no commit was made, and no live infrastructure was used. All commands below ran from `D:\Git\dugate\du-rework\services\orchestrator` unless stated otherwise.

## 1. Original suite, unchanged

Command on both runs: `npx jest --runInBand --testPathPatterns "rv01-loopback"`

Run 1 raw summary:

```text
Test Suites: 1 passed, 1 total
Tests:       45 passed, 45 total
Snapshots:   0 total
Time:        3.615 s, estimated 4 s
Ran all test suites matching rv01-loopback.
Exit code: 0
```

Run 2 raw summary:

```text
Test Suites: 1 passed, 1 total
Tests:       45 passed, 45 total
Snapshots:   0 total
Time:        3.574 s, estimated 4 s
Ran all test suites matching rv01-loopback.
Exit code: 0
```

Both unchanged runs were green. The six findings are `it.failing` tripwires, so that green result alone does not show the assertions pass against the current implementation.

## 2. Red-tripwire proof using an external copy

Copied `tests/rv01-loopback-http-offline.test.ts` to `C:\Users\Gem\AppData\Local\Temp\rv01-loopback-verify-534b66644fab4540abc4bc55522bdfbc\services\orchestrator\tests\rv01-loopback-http-offline.test.ts`, changed only the six copied `it.failing(` markers to `it(`, and ran:

```text
npx jest --runInBand --config C:\Users\Gem\AppData\Local\Temp\rv01-loopback-verify-534b66644fab4540abc4bc55522bdfbc\services\orchestrator\jest.config.cjs --runTestsByPath C:\Users\Gem\AppData\Local\Temp\rv01-loopback-verify-534b66644fab4540abc4bc55522bdfbc\services\orchestrator\tests\rv01-loopback-http-offline.test.ts
cwd: D:\Git\dugate\du-rework\services\orchestrator
```

Observed Jest result: `Test Suites: 1 failed, 1 total; Tests: 6 failed, 39 passed, 45 total; Snapshots: 0 total`. The Jest child exit code was **1**. A PowerShell wrapper printed `FLIPPED_COPY_EXIT=1` and itself exited 0 after capturing that child status; the Jest result is therefore a failure as expected, not a successful test run.

Failure observations from the copied run:

| Finding | Assertion expected | Current copied-run observation |
|---|---|---|
| F1 | Complete 17-byte `# downloaded body`, status 200, not aborted | Status 200 and declared length 17, but body was `{}` (2 bytes) and response was aborted. `legacy-http-mount.ts:601-607` returns an empty body with the source-byte length; `server.ts:814-820` writes JSON `{}` when `raw` is absent. Legacy inline output is returned at `app/api/v1/operations/[id]/download/route.ts:44-57`. |
| F2 | 404 body has exactly `status,title,type` | Actual body includes the extra `detail`. `legacyError()` always creates that key at `legacy-http-mount.ts:159-172`; the legacy cancel route's missing-operation body has three keys at `app/api/v1/operations/[id]/cancel/route.ts:17-21`. |
| F3 | 409 type is `https://dugate.vn/errors/already-done` | Actual type is `https://dugate.vn/errors/already-completed`: current title-to-slug construction is at `legacy-http-mount.ts:165-169`, while legacy hardcodes `already-done` at `app/api/v1/operations/[id]/cancel/route.ts:32-35`. |
| F4 | Missing credential returns 401 | Actual status is 500. `safePrincipal()` converts the resolver rejection to `null` at `legacy-http-mount.ts:96-105`; list handling maps null to `internalError()` at `:507-508`, whose status is 500 at `:295-302`. **Qualification:** the test itself notes legacy did not return 401 either: `middleware.ts:32-38` allows `/api/v1/*` after stripping client-supplied identity headers, while `app/api/v1/operations/route.ts:35-38` applies the key filter only when `x-api-key-id` is present. Treat that legacy missing-fence behavior as MUST-NOT-REPLICATE; the 401 is a security expectation, not verified legacy parity. |
| F5 | Unknown docs action returns namespaced `Service Not Found` 404 | Actual current response is canonical `urn:du:error:not_found`. `parseLegacyDocsPath()` rejects unknown actions at `legacy-http-mount.ts:192-200`; the facade declines the route at `:391-392`, and canonical fallback returns the `urn` type at `server.ts:2787`. **Qualification:** legacy `runEndpoint()` does construct a namespaced 404 for an unregistered `serviceSlug` at `lib/endpoints/runner.ts:75-77`, but I did not establish that an unknown docs URL is routed to that function: the inspected docs handlers are concrete action paths, not an observed dynamic catch-all. Thus the current fallthrough is verified; URL-level legacy parity is not independently established here. |
| F6 | JSON submit returns 415 Unsupported Media Type | Actual status is 400. The streaming branch is selected only for multipart content at `server.ts:739-753`; without a stream, `decodeLegacyMultipart()` throws 400 at `legacy-http-mount.ts:267-272`, then maps the status at `:419-425`. **Qualification:** `titleForStatus()` has a 415 label at `:355-365`, but that does not make this guard produce 415. I found no explicit 415 branch in the legacy `runEndpoint()`/action-route code inspected (`lib/endpoints/runner.ts:80-85` calls `req.formData()`); the 415 legacy expectation is therefore not independently confirmed. |

**Six-tripwire verdict:** all six copied assertions failed against current source, with 39 other assertions passing. F1–F3 and the current-code sides of F4–F6 are independently confirmed. The qualifications above limit claims of actual legacy URL-level behavior for F4–F6; the report does not recast those expectations as observed legacy results.

The external scratch tree was removed after the run. Its source/dependency junctions were removed before deleting the remaining temporary files; final `Test-Path` result was `False`.

## 3. F1–F6 cross-check summary

| Finding | Verified? | Evidence / boundary |
|---|---|---|
| F1 download wire body | Yes | Copied probe observed 2-byte `{}` with a declared 17-byte length and an aborted response; see `legacy-http-mount.ts:601-607`, `server.ts:814-820`, and legacy inline response `app/api/v1/operations/[id]/download/route.ts:44-57`. |
| F2 cancel-404 body shape | Yes | Probe observed extra `detail`; `legacyError()` adds it at `legacy-http-mount.ts:165-172`; legacy shape at cancel route `:17-21`. |
| F3 cancel-409 type slug | Yes | Probe observed `already-completed`; legacy literal is `already-done` at cancel route `:32-35`; generation is at `legacy-http-mount.ts:165-169`. |
| F4 missing-credential status | Yes for the current 500 mismatch; **No** for “legacy is 401” | `safePrincipal` + error path at `legacy-http-mount.ts:96-105,295-302,507-508` and copied probe confirm 500. Legacy middleware and conditional filter (`middleware.ts:32-38`; `app/api/v1/operations/route.ts:35-38`) do not establish 401 and expose the missing-fence behavior noted above. |
| F5 unknown-docs namespace | Yes for current fallthrough; **not established** as an actual legacy URL response | Parser/facade and canonical fallback at `legacy-http-mount.ts:192-200,391-392`; `server.ts:2787`. Legacy runner's conditional namespace behavior is at `lib/endpoints/runner.ts:75-77`, but route-to-runner mapping for an unknown URL was not proven. |
| F6 JSON-body status | Yes for current 400 vs the tripwire's 415 assertion; **not established** as legacy 415 | Server stream predicate and decoder guard at `server.ts:739-753`; `legacy-http-mount.ts:267-272,419-425`. The 415 label alone (`:363`) is not the path taken. Legacy action runner invokes `formData()` at `lib/endpoints/runner.ts:80-85`; no explicit legacy 415 branch was found in the inspected path. |

## 4. §7 legacy regression filter

Discovery command: `npx jest --runInBand --listTests --testPathPatterns "legacy"` (exit 0), listing 11 matching suites. Then ran `npx jest --runInBand --testPathPatterns "legacy"` from the orchestrator cwd.

```text
Test Suites: 11 passed, 11 total
Tests:       237 passed, 237 total
Snapshots:   0 total
Time:        3.277 s
Ran all test suites matching legacy.
Exit code: 0
```

No suite selected by the `legacy` filter failed. This is a filtered regression check only, not a whole-orchestrator-suite result.

## Scope and worktree note

No live PG/Redis/service was contacted. At verification time, `git status --porcelain` reported the original RV01 test path as `?? du-rework/services/orchestrator/tests/rv01-loopback-http-offline.test.ts` (untracked); that status cannot establish its pre-task state. I did not modify that in-repository file. The only in-repository file written for this task is this receipt.

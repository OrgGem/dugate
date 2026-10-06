# WT-03 - CB-02 write/retry boundary tests - 2026-10-07

Owner: codex_arch. Canonical plan: `tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md` section 2.2. Scope: du-rework only. Status: IMPLEMENTED; owner offline checks passed, independent verification/acceptance pending. No commit or push. Product source and legacy root were not changed by this task; existing concurrent hunks were preserved.

## Coverage delivered

`services/orchestrator/tests/cb02b-profile-publish-callback.test.ts` (9 cases):

- Actual `createProfileService().createRevision()` executes with a stub PoolClient capturing SQL and bound values. Absent policy, absent key and explicit undefined inherit the previous revision; SELECT requests callback_policy for the correct profile/revision.
- Explicit null bypasses malformed previous content and binds SQL NULL at callback_policy ($16 / parameter index 15).
- Invalid client policy fails with 422 / INVALID_SCHEMA and `/callbackPolicy/mode`, before any INSERT/UPDATE.
- Valid client policy replaces a malformed previous pin, validates against the contract and retains only secret refs. Inherited valid policy retains the same refs; no resolver/secret service is injected or called.
- First revision without a policy writes SQL NULL. Malformed inherited policy fails closed with 500 before publishing.
- Actual effective-profile SELECT/decode retains valid stored callback refs and includes p.callback_policy with the expected lookup parameters.

`services/orchestrator/tests/cb02c-retry-callback-pin.test.ts` (2 cases):

- Executes actual retryOperation for both a contract-valid snapshot and SQL NULL. Captures the operation INSERT SELECT, checks target/source counts and positional mapping, and emulates direct original-column copying.
- Both target and SELECT order must contain exactly `profile_policy_snapshot -> callback_policy -> prompt_revisions_pin`. Asserts callback_policy retains the original snapshot/null, adjacent profile/prompt pins remain intact, lookup uses the original operation ID, retry creates a fresh operation, and no live profile read occurs.
- This three-column order belongs to operations retry, not profile_bindings (which has no profile_policy_snapshot/prompt_revisions_pin columns). Profile publish independently verifies its callback column/parameter alignment. Admission INSERT uses explicit columns with its own valid ordering; no gratuitous source reorder was performed.

## Failing-first evidence

Current production behavior already implements the requested carry-forward, validation and retry pinning. No existing product defect was manufactured or claimed. Before the canonical green run, tests were executed against an isolated temporary source copy with two deliberate regressions: inherited callback policy replaced by null, and retry SELECT callback_policy replaced by NULL. Shared source was never mutated.

Result: exit 1, 2 failed suites, 6 failed / 5 passed / 11 total; failures are behavioral assertions, not compilation errors. Final fixture was also rerun on this mutant with the same result. Mutation patch, sandbox cwd, log and exit code are retained under `raw/wt03-cb02-write-tests-2026-10-07/`. This is failing-first regression sensitivity evidence, not a claim that canonical source initially failed.

## Commands and results

Node: **v24.21.0**.

| cwd | command | exit | passed / failed |
|---|---|---:|---|
| Temporary isolated cwd recorded in raw/mutation-sandbox.txt | `node node_modules/jest/bin/jest.js --runInBand --no-cache tests/cb02b-profile-publish-callback.test.ts tests/cb02c-retry-callback-pin.test.ts` | 1 expected | 5 / 6, 11 total; 2 suites failed |
| `D:/Git/dugate/du-rework/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand tests/cb02b-profile-publish-callback.test.ts tests/cb02c-retry-callback-pin.test.ts tests/cb02-admission-writer.test.ts` | 0 | 18 / 0; 3 suites passed |

Final raw evidence: `raw/wt03-cb02-write-tests-2026-10-07/final-suite.log`, `final-suite.exit.txt`, `failing-first.log`, `failing-first.exit.txt`, `mutation.patch`, `source-sha256.txt`.
PowerShell wraps Jest stderr in NativeCommandError text; final process exits and Jest summaries above are authoritative.

## Limits and handoff

These are offline unit/contract checks using strict SQL stubs. They do not execute PostgreSQL, a live retry workload, Portal interaction or secret resolution. The SQL-copy emulation verifies mapping, not PostgreSQL execution. No whole-plan or independent VERIFIED/ACCEPTED claim is made. Coordinator/tester can independently rerun the exact three-file suite; global plan state remains owned by the coordinator.

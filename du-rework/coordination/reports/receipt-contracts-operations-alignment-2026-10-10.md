# Receipt: Contracts operations list alignment

- **Packet:** Contracts alignment after AWEB-16b / AWEB-20a
- **Completed:** 2026-10-10 15:42 UTC
- **Scope:** `du-rework/orchestrator/packages/contracts/tests/operations-list-contract.test.ts`

## Change

Updated the operations list contract test to expect all eight supported query parameters, including `from` and `to`. The same existing test now confirms valid UTC bounds are accepted and a date-only `from` value is rejected. The suite test count remains unchanged.

## Verification

- **Command:** `node ./node_modules/jest/bin/jest.js --runInBand`
- **Working directory:** `du-rework/orchestrator/packages/contracts`
- **Node:** `v24.21.0`
- **Result:** exit 0; 30/30 suites and 570/570 tests passed; 0 snapshots.
- **Diff check:** `git diff --check -- tests/operations-list-contract.test.ts` passed.
- Ran locally with no external services.
- **Raw Jest output:** [`raw/contracts-operations-alignment-2026-10-10/jest-full.log`](raw/contracts-operations-alignment-2026-10-10/jest-full.log)

No files were staged, committed, or pushed.

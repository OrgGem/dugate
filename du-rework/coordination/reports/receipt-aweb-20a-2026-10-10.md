# Receipt AWEB-20a — Operations `from`/`to` filter

Implemented the server-side Operations time window within the packet lease.

- Added `from` and `to` to `OPERATIONS_LIST_QUERY_PARAMS` and the strict UTC ISO timestamp fields in `ListOperationsQuerySchema`.
- The route parser rejects malformed/non-UTC/impossible timestamps with `422 INVALID_SCHEMA`, rejects an inverted range with the same status, and compares optional microseconds without truncating them.
- Added bound inclusive `created_at >= from` and `created_at <= to` predicates. The shared predicates and parameters apply to both page and count queries.
- Added `from` and `to` to the Operations BFF forwarding allowlist.
- Added offline coverage for contract validation, UTC/range rejection before DB access, bound page/count predicates, open-ended ranges, and BFF forwarding through a localhost stub.

## Verification

- `@du/contracts`: `npm run build` — pass.
- `@du/contracts`: `npm run test:typecheck` — pass.
- `@du/orchestrator`: `npm run typecheck` — pass.
- `@du/orchestrator`: `npm run test:unit -- --runTestsByPath tests/or10-operations-time-filter.test.ts` — 5/5 pass.
- `@du/orchestrator`: `npm run test:unit -- --runTestsByPath tests/admin-operations-sql.test.ts tests/operations-list-cursor-sort-binding.test.ts` — 96/96 pass.

The existing `packages/contracts/tests/operations-list-contract.test.ts` and `services/orchestrator/tests/operations-list-contract-conformance.test.ts` each have stale six-parameter expectations; the conformance test also lacks invalid-value fixtures for the two new parameters. Those files were outside the packet lease, so they were not changed. Their focused runs report respectively 15/16 and 17/19 tests passing, with failures limited to those stale assertions/fixtures. No staging, commit, push, or gate update was performed.

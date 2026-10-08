# Workflow API parity verification

This directory owns WFA-04 independent fixtures and HTTP-to-worker verification. It is separate from the shared legacy facade unit tests so its receipt only represents tests that drive the real new composition.

Run the focused verifier from `du-rework/` with Node 24.21.0. The runner records cwd, Node version, command, raw stdout/stderr, and exit code under `tests/workflow-api/logs/`:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs
```

The suite defaults to its dedicated loopback services at PostgreSQL `127.0.0.1:55498` and Redis `127.0.0.1:56398`. Override them only with `WFA_DATABASE_URL` and `WFA_REDIS_URL`, each pointing to loopback and an explicitly assigned port. It creates a unique PostgreSQL schema and a non-default Redis database. It does not inherit `DATABASE_URL`, `REDIS_URL`, or the legacy application's environment. Test teardown removes only its generated schema and scratch directory; raw failure output stays in `logs/`.

To run a focused test through the same receipt writer, pass a `.log` receipt name first and then Jest arguments:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs worker-node24.log tests/workflow-api/http-worker.integration.test.ts
```

`legacy-contract-baseline.json` and `schema-primitives.json` are frozen input fixtures derived from the old route, registry, worker, operation formatter, and workflow-builder source. `acceptance-cases.json` keeps every WFA-T01..38 requirement visible. Fixture and decoder unit checks do not count as HTTP or worker evidence. `schema-catalog.postgres.test.ts` applies the real migrations and exercises the encrypted catalog through a fresh isolated PostgreSQL schema. `http-schema-pin.integration.test.ts` checks real HTTP admission, encrypted uploads, immutable pins, and denial cleanup. `http-worker.integration.test.ts` drives the production outbox and Redis worker through the legacy poll/result/download facade; its controls use only offline input and human nodes.

## WFA-VERIFY-BASELINE fixtures (OC lane, 2026-10-07)

- `fixtures/named-processes.json` — named-process case manifests for WFA-T01..T03 (process, synthetic files, variables, frozen 202 envelope keys, baseline state).
- `fixtures/leaf-nodes.json` — manifests for the six executable leaf nodes (WFA-T15, T18..T22) with loopback-only mock shapes, output selection and required fences.
- `fixtures/security-vectors.json` — fail-closed vectors for T22/T33..T35 (path traversal, SSRF/redirect, prototype keys, explicit bounds; `maxFanout` flagged as an open contract item).
- `wfa-verify-scaffold.test.ts` — 11 offline checks that lock the fixture layer above and prove case IDs cannot disappear (no PG/Redis/worker needed).
- `named-processes-admission.integration.test.ts` — worker-free admission baseline over the real composition and isolated infra: asserts the frozen 202 envelope for the three named processes; fail-first failures are reported as `BASELINE-FAIL (expected, pending qwen items)`.

`run-jest.cjs` writes a receipt for every run under `logs/`; keep fail-first logs. Worker execution evidence remains owned by the full-worker lane.

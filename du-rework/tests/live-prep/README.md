# PLAN04 live-test preparation fixtures

This directory contains offline-only preparation material for the PLAN04-03
live evidence window. The fixture generator uses Node.js built-ins only. It
does not open sockets, read `.env` files, or contact PostgreSQL, Redis, MinIO,
Vault, the Orchestrator, the Connector, or a browser.

From the repository root, prepare a fresh fixture directory with:

```powershell
node du-rework/tests/live-prep/prepare-live-fixtures.mjs `
  --run-id plan04-20261004-a `
  --out-dir "$env:TEMP\du-live-prep\plan04-20261004-a"
```

The destination must not already exist. Each run creates a synthetic one-page
PDF, the expected extracted text, a manifest with hashes but no sentinel value,
and a receipt stub. The PDF contains a unique synthetic sentinel so a future
live test can check that it is absent from stored object bytes and metadata,
then compare the authorized downloaded output with the expected text. Keep the
fixture directory local to the approved test runner; do not attach or log the
raw sentinel, API keys, Vault tokens, or credential values.

The generated fixture is input data only. It does not provision tenants,
identities, policies, buckets, keys, or operations. Those must be created in
the isolated namespace approved for the live window. The full execution matrix
and gate holds are in
`du-rework/coordination/reports/live-test-prep-2026-10-04.md`.

The DD-03 PostgreSQL legacy-snapshot census is separately packaged as
`scan-legacy-snapshot-counts.mjs` with
`dd03-count-only-runbook.md`. It is offline-prepared and must only be invoked
inside a user/Coordinator-approved live window. It requires a protected
read-only PostgreSQL service configuration and returns four aggregate counts;
it does not return row values or IDs. The current prep task did not run it.

# DD-03 legacy snapshot count-only scan runbook

This runbook and `scan-legacy-snapshot-counts.mjs` were prepared offline. Do not run them until the user/Coordinator opens and identifies a live window. The scan is a candidate census only; it does not validate every snapshot against the application schema and cannot prove that a field's contents are plaintext.

## Hard limits

- Use a dedicated PostgreSQL login whose only effective data permissions are `SELECT` on the required `operations` and `tasks` relations. It must not be a superuser, table owner, or a role with write grants. Use the approved database/schema and confirm the service alias privately before the window.
- The script sends one fixed query inside `BEGIN TRANSACTION READ ONLY`, sets `statement_timeout` to `5s`, also bounds connection setup with `PGCONNECT_TIMEOUT=5`, and ends with `ROLLBACK`. Its `psql` child receives an allowlisted environment so unrelated `PGHOST`/`PGDATABASE` variables cannot silently override the approved service entry. It has no write, delete, update, DDL, or cleanup operation.
- The query returns exactly four aggregate counts. It never projects snapshot JSON or a row ID. An operation ID is referenced only inside an `EXISTS` predicate to correlate task state; no ID is returned. Snapshot fields are used only as predicates to compute counts.
- Client stdout is accepted only if it consists of one four-count row. The script discards client stderr and withholds all output on a nonzero client exit or unexpected stdout. Never enable psql echo/debug flags or replace the fixed query with ad hoc SQL.
- Do not use `DATABASE_URL`, put passwords/tokens in argv, print environment values, save `.env`, query individual rows, select/copy/export snapshot data, or log IDs or JSON. No delete, rewrite, migration, or backfill is part of this scan.

## Window inputs — required before starting

The Coordinator/user must fill and approve all of these in the live-window record:

| Input | Required value / confirmation |
|---|---|
| Window | Approved window ID and start/end time; operator and stop contact |
| Target | Explicit non-production stack, current build/commit digest, PostgreSQL namespace and schema |
| PostgreSQL | Approved service alias, proof the alias maps to the intended target, read-only login owner and grants review |
| Secret channel | Protected `pg_service.conf` outside the repository, with host/port/database/user and TLS settings but no password; protected `PGPASSFILE` outside the repository; do not copy either file into this worktree |
| Scope | Confirmation that the deployed schema has the expected `operations.profile_policy_snapshot`, `operations.state`, `tasks.operation_id`, and `tasks.state` contract |
| Evidence | Approved sanitized receipt path for four counts, literal process exit code, time, namespace label, command and operator |

If any input is missing, stop before invocation. Do not probe alternate databases or infer current endpoints from historical reports. LIV03's ports (`Postgres 5433`) and container mapping describe the earlier 2026-10-04 snapshot only and must be rechecked by the window owner.

## Configure and run (PowerShell)

Have the window owner provision the service entry and password file through the approved secret-handling procedure. Set their paths without displaying their contents. Replace every angle-bracket placeholder with a value supplied for this window; use the service alias, never a URL or password on the command line.

```powershell
$env:DD03_WINDOW_APPROVED = '1'
$env:DD03_WINDOW_ID = '<APPROVED_WINDOW_ID>'
$env:PGSERVICEFILE = '<PROTECTED_PATH_OUTSIDE_REPOSITORY\pg_service.conf>'
$env:PGPASSFILE = '<PROTECTED_PATH_OUTSIDE_REPOSITORY\pgpass.conf>'

node du-rework/tests/live-prep/scan-legacy-snapshot-counts.mjs `
  --run `
  --service '<APPROVED_READ_ONLY_SERVICE_ALIAS>'
$scanExit = $LASTEXITCODE
```

Record `$scanExit` literally in the live receipt. The script's successful stdout is limited to these labels and integer counts:

```text
legacy_config_field_rows=<count>
rows_with_nonempty_legacy_credential_fields=<count>
missing_new_shape_candidate_rows=<count>
nonterminal_legacy_candidates=<count>
```

The window operator should write only those counts and the literal exit code into the approved evidence path. Do not use `Tee-Object` or shell redirection unless that path was approved; never capture psql stderr separately. Clear the four environment variables after the run without echoing them. A missing `psql`, unavailable service, SQL error, timeout, nonzero client exit, or unexpected output is a **STOP/HOLD**, not a reason to expose diagnostics or try a broader query. Obtain a reviewed fix/re-run instruction.

## Interpret and stop conditions

- Exit `0` with all four counts `0`: this candidate scan found no rows matching these predicates in the scanned namespace at that time. This does not establish application-schema validity or make other live gates pass.
- Any count above `0`: stop claims for affected legacy candidates and keep the relevant live gate on HOLD. Do not identify rows, read snapshots, or perform rewrite/delete/backfill. Ask the implementation/data owner for a separately reviewed remediation and an approved rescan.
- Any nonzero exit, timeout, parser rejection, or ambiguous target: treat the result as unavailable and HOLD. Do not retry against a guessed service or database.

The script intentionally does not print the service alias, window ID, connection details, row values, or IDs. The operator records the approved namespace label separately in the sanitized receipt.

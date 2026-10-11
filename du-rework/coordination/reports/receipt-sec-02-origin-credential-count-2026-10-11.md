# SEC-02 origin credential count receipt

Status: blocked at the required schema preflight; no cipher row count was run.

## Read-only evidence

- Read the SEC-02 dispatch spec before database access.
- Inspected the local du-rework phase-B test database in container arch-phase-b-20261006-postgres-1. This is not the live or legacy database.
- Ran the information_schema probe inside a BEGIN READ ONLY transaction after SET LOCAL transaction_read_only = on. SHOW transaction_read_only returned on.
- The profile_bindings schema contains file_url_auth_cipher as nullable text, but does not contain allowed_origins.
- Per dispatch spec section 3, stopped before the count query because allowed_origins is missing. The row and profile counts are not measured, not zero.
- The intended du-rework-test postgres container is stopped. Starting it failed because its 127.0.0.1:5433 binding is occupied by the separate du-live-postgres container. The live container was not queried, stopped, or modified.
- Warning log counts: no data for the applicable target deployment. The unrelated phase-B test logs were not used as a substitute.
- No ciphertext was selected, printed, or stored.
- Runtime dispatch ID: not provided with the direct user task; the current runtime roster showed only /root. This receipt does not claim runtime dispatch proof.

Raw schema probe output: coordination/reports/raw/sec-02-count-2026-10-11/schema-target-assessment.txt

No code, migration, or configuration was changed. No git add, commit, push, or gate update was performed.

Next prerequisite: provide access to the intended du-rework database with migration 0041 applied and its own non-live connection path, then rerun the count under the same read-only transaction controls.

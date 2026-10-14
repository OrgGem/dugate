# Database migrations

The project migration commands cover both Orchestrator and Connector, using
the `DATABASE_URL` selected by the environment file:

```sh
pnpm run migrate
pnpm run migrate:status
pnpm run migrate:verify
pnpm run migrate:baseline-reviewed
```

`migrate` checks the complete applied ledger before applying any pending SQL.
It rejects missing, renamed, orphaned, or content-changed migration files. New
files run in sequence order, each in its own transaction with its ledger row.
The migration runners hold a PostgreSQL advisory lock from planning through
the final transaction so concurrent service starts cannot apply the same file.
For applied migrations with known checksums, `status`, `verify`, and `migrate`
also check declared table and index objects in PostgreSQL catalogs. A missing
object is reported for repair; migration SQL is never replayed automatically.

Checksums are SHA-256 over UTF-8 SQL after CRLF pairs are changed to LF. This
normalizes Windows checkout line endings; all other SQL content remains part
of the digest. Rows applied by the runner record `migration` provenance.

Older Orchestrator and Connector ledgers contain no checksum. Their content is
reported as unknown until an operator reviews the existing schema and runs
`pnpm run migrate:baseline-reviewed`. That command records hashes and
`reviewed-baseline` provenance only for ledger rows that exactly match files on
disk. It does not run migration SQL. It refuses orphaned, renamed, or
object-drifted rows and never replaces a known checksum. After a baseline,
`status` reports which rows carry reviewed-baseline provenance.

`status` and `verify` only read PostgreSQL catalogs and ledger rows. They do
not create or alter tracking tables. The first `migrate` or
`migrate:baseline-reviewed` call bootstraps checksum metadata columns on the
tracking tables; a legacy ledger's checksums stay NULL until explicit review.
`status` exits nonzero for unknown checksums or ledger/object integrity issues;
pending migrations by themselves remain a valid status for a new database.

Orchestrator startup verifies migrations by default; `AUTO_MIGRATE=true`
enables its existing opt-in auto-apply behavior. Connector preserves its
existing default of applying pending migrations at startup and then verifying
the ledger. Set `CONNECTOR_AUTO_MIGRATE=false` to make Connector verify-only.
The project `dev` command runs the consolidated migration command before
starting either service.

# LDBA-A1 Timezone Guard Receipt

- Date: 2026-10-09
- Scope: du-rework only
- Status: guard implemented; legacy timezone remains unproven; no gate ticked

## Legacy timezone finding

The legacy source code does not prove that naive timestamps represent UTC:

- lib/db/schema.ts:3,40-42 declares PostgreSQL timestamp columns with mode date and precision 3, without withTimezone. The generated legacy migration uses timestamp (3), also without a timezone, at drizzle/0000_violet_franklin_storm.sql:104-106.
- lib/pipelines/submit.ts:312-327 inserts Operation without createdAt or updatedAt. createdAt therefore uses the CURRENT_TIMESTAMP(3) database default from lib/db/schema.ts:40. updatedAt uses the Drizzle on-update callback returning new Date() at lib/db/schema.ts:41.
- lib/db/index.ts:7-14 configures the postgres-js client without a timezone option. These source paths do not pin the database session or application host timezone.

Conclusion: the stored values are naive timestamps, but source alone cannot establish whether their wall-clock values are UTC or local time. The legacy timezone remains unresolved, consistent with PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:330. No database setting or row was queried. A1 remains open and synthetic UTC fixtures do not prove the legacy timezone.

## Change

In orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs, runBackfill now returns BLOCKED_TIMEZONE_UNVERIFIED with failure code LEGACY_TIMEZONE_UNVERIFIED before scanning or writing when execution is requested and no explicit bypass is present. Read-only preflight remains available. The CLI also refuses --execute before loading the adapter unless the bypass is set.

The existing timestamp transform is unchanged: naive timestamps are interpreted as UTC, while timestamps with an offset or Z are rejected. The offline test now covers both offset and Z rejection and verifies the naive UTC result.

The bypass is LDBA_ALLOW_UNVERIFIED_TIMEZONE=1. It disables the timezone guard and is unsafe. It must not be set in any real environment; it is present only temporarily in the offline synthetic-fixture test helper. The dedicated guard test clears it and proves the default block.

## Verification

- Node version: v24.21.0
- node --check scripts/ldba-03-backfill.cjs - exit 0
- node --test tests/ldba-03-backfill-offline.test.cjs - tests 21, pass 21, fail 0, exit 0
- git diff --check for the runner and offline test - exit 0
- Guard test confirms no source scan, tenant seed, or target write occurs without timezone evidence. CLI test confirms refusal happens before adapter loading.

## Boundaries

Changes in this task are limited to the runner, its offline test, and this receipt. No database, migration, container rehearsal, build, or live/legacy data access was performed. No commit, git add, or push was performed. No gate was ticked.

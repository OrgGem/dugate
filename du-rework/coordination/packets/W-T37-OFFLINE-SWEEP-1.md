# W-T37-OFFLINE-SWEEP-1 -- Strict-offline x3 sweep including submission suites (T200-P2 closure)

**Owner:** Tester (term_4bb58313, qwen-code qwen3.8-max) -- dedicated tester lane
**Priority:** P1 -- verifies W-INGEST-PG-FAILCLOSED-1 source fix (T200-P2)
**Due:** when DB window FREE (strict offline, no DB needed)
**Prerequisite:** W-TYPECHECK-ALIAS-1 (so typecheck step is real) + submission.ts settled

## Objective
- Task: Run strict-offline x3 sweep of 7 suites (T-36 five + 2 submission suites) with hash guard.
- Suites: credential-legacy-transition-offline, vault-bootstrap-offline, url-ingestion-consumer-offline.functional, admin-operations-sort-http-offline, admin-keyset-explain (offline half), PLUS url-ingestion-backend-failclosed-offline and url-ingestion-offline.functional.
- Acceptance: each suite green in 3/3 consecutive blocks, every per-run literal ExitCode 0; SHA256 of all 7 suite files identical across HASHES_BEFORE/AFTER/FINAL; log carries DU_LIVE_INFRA not defined; packet STEP6A now executes via fixed typecheck alias; no product source edits.
- Evidence: raw log T-CODEX-TEST-37-*.log + receipt in coordination/reports/tester.md with per-block counts, 3x exit 0, SHA guard, deviation note if any.

## Read first
- coordination/reports/review.md T200-P2 + T200-P1
- coordination/reports/qwen-platform.md Sec 12 (submission.ts guard)
- coordination/reports/tester.md T-36 sweep format
- All 7 suite files on disk

## Ownership
- Allowed write: coordination/reports/tester.md, coordination/reports/T-CODEX-TEST-37-*.log
- Read-only: product source (read to select cases, no edits)
- Non-goal: live DB window, acceptance decisions

## Rules
- STRICT OFFLINE: DU_LIVE_INFRA not defined, no PG/Redis/S3 contact, no DB window claim.
- Do not edit product source; do not claim ACCEPTED.

## Handoff format
Receipt in tester.md: sweep timeline, per-suite 3/3 counts, block aggregates, SHA guard, deviations, raw log path, honest status.

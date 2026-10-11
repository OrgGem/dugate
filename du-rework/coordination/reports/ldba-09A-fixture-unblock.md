# LDBA-09A fixture unblock receipt

Date: 2026-10-09
Scope: du-rework only
Status: BLOCKED at rehearsal round 3, per dispatch stop condition

## Changes in the LDBA-09A lease

- W3 adds only `adapter: 'synthetic-fixture-adapter:' + row.id` to the connector revision fixture. The value is deterministic, non-empty, and explicitly synthetic.
- W4 corrects the expected override outcomes: override 2 references the connector skipped by policy; override 3 has the text connector id.
- W2 adds exactly two offline write tests: assignment for an already-present fake target user, and connector revision plus secret writes from a complete fake context result including `adapter`.
- The LDBA-03 runner and production code were not changed.

## Offline checks

Command: `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs`

Literal summary: tests 36, pass 36, fail 0, exit 0.

Command: `node --test tests/ldba-03-runner-skip.test.cjs`

Literal summary: tests 16, pass 16, fail 0, exit 0.

`node --check` passed for W2, W3, and W4. The combined command exit code was 0.

## Disposable PG16 rehearsal

Command: `node scripts/ldba-09-harness.cjs`

The harness used a new disposable `postgres:16-alpine` container with `--network none`, tmpfs data storage, and no published ports. Node 24.21.0 ran inside the container. Both migration sets were applied there. No production, legacy, or shared database was accessed.

Migration evidence: orchestrator 37 files and 37 `schema_migrations` rows; connector 9 files and 9 `connector_schema_migrations` rows; 33 target base tables. Synthetic source rows totaled 22: Operation 2, ApiKey 2, ExternalApiConnection 3, ExternalApiOverride 3, ProfileEndpoint 2, AppSetting 3, FileCache 2, User 3, UserProfileAssignment 2. Tenant `legacy-default` was inserted by name only and resolved at runtime to `0fa68f10-e7c3-40b8-8de4-2de9431f528e`.

| Round | Literal | Result |
|---|---|---|
| 1 fixture preflight | `RUNNER ldba-09-skip-fixture-adapter.cjs --preflight policy=report exit=0 status=PREFLIGHT_READY` | Pass. Zero failures; expected controlled skip list and workflow duplicate key were reported. |
| 2 first execute | `RUNNER ldba-09-skip-fixture-adapter.cjs --execute policy=report exit=0 status=APPLIED` | Pass. `destinationRows.written=20`; no row failures. |
| 3 replay | `RUNNER ldba-09-skip-fixture-adapter.cjs --execute policy=report exit=1 status=BLOCKED_TARGET_CONFLICT` | Fail. Six `TARGET_IMMUTABLE_CONFLICT` rows: Operation 2, ProfileEndpoint 2, FileCache 2. |
| 4 fail-policy preflight | Not run | Stopped after round 3 failed. |
| 5 LDBA-08 regression preflight | Not run | Stopped after round 3 failed. |

No parse failures or unexpected controlled skips were reported in rounds 1 and 2. Round 1 planned these destination counts: api_keys 2; connector_revisions 2; secret_versions 2; profile_bindings 2; profile_active_revisions 2; profile_names 2; operations 2; connector_prompt_overrides 1; artifacts 2; artifact_blobs 2; admin_local_users 0; user_profile_assignments 0; legacy_workflow_schemas 1. A final target-count query was not reached because round 3 failed.

The round 3 failure is the literal stopping condition in the dispatch. The runner reported immutable conflicts for the six source rows above, without exposing the differing destination fields. No retry or further rehearsal was performed. Container cleanup literal: `CONTAINER_REMOVED du-ldba09-pg16-1791506500324-26204`. Harness exit: 1.

## Preserved fixture boundaries

- AppSetting keeps the two duplicate workflow rows on the same key, `wb_schema:analyze`. Because the runner derives the slug directly from the key suffix, different keys cannot form the same slug under the current contract. This verifies the diagnostic prints the real key but does not prove a different-key tiebreak.
- All three synthetic users remain pending rehash. No scrypt hash was generated and no `admin_local_users` row was written. The first assignment references a skipped user; the second uses a non-UUID user id. The offline W2 test separately covers assignment writing for a user already present in the fake target.
- A1 remains open. Explicit synthetic UTC timestamps in this rehearsal do not establish timezone behavior for a real legacy source.

## Open items for coordinator

- Resolve the six replay conflicts before another rehearsal: Operation source rows `20000000-0000-4000-8000-000000000001` and `20000000-0000-4000-8000-000000000002`; ProfileEndpoint source rows `50000000-0000-4000-8000-000000000001` and `50000000-0000-4000-8000-000000000002`; FileCache source rows `60000000-0000-4000-8000-000000000001` and `60000000-0000-4000-8000-000000000002`. No destination field detail was available from the redacted immutable-conflict report.
- Rounds 4 and 5 remain unverified because the required stop condition triggered at round 3.

## Boundary

Only W2, W3, W4, and this receipt were written. The runner, production adapters, migrations, plans, and other files were not changed. The disposable container was removed. No DB window is claimed. No commit, git add, push, or gate tick was performed.

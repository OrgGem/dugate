# PREP-PC-09 — End-to-end verification matrix and phased cutover design

| Field | Value |
|---|---|
| Packet | PREP-PC-09 (pre-analysis for **PC-09 Verification and cutover**) |
| Role | DeepSeek Worker 3 — System Integration & Verification Specialist |
| Master plan | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §PC-09, §Acceptance matrix, §Rollout order |
| Prerequisites | PC-01, PC-02, PC-03, PC-05, PC-06 accepted; PC-04 in final sweep; PC-07/PC-08 in flight |
| Source files modified | **None.** Read-only audit; this report is the only artifact. |

## 0. TL;DR

1. **Three of the harness names in the dispatch do not exist.** There is no
   `orchestrator/services/orchestrator/tests/e2e/` (verified absent), no
   `getScratchClient`, and no `runAllMigrations` (both grep to zero hits). The
   real conventions are `tests/helpers/runtime-harness.ts`
   (`createRuntimeFixture`), per-suite scratch databases created with a raw `pg`
   `Pool`, `tests/helpers/test-target-guard.ts`
   (`validateTestDatabaseTarget`), and `du-rework/tests/harness/listen-loopback.ts`
   for a deterministic bind port.
2. **The shared fixture cannot express the 6-endpoint matrix.** It registers a
   synthetic single-action business (`Test Business` / `extract` only) with a
   required connector slot. PC-09 needs a **6-action, connector-free fixture
   manifest** so admission is deterministic and no provider is involved.
3. **A real conflict in the deployment guide.** `12b-deployment-guide.md` says
   *"stop the API and workers first … Do not allow an older API to serve traffic
   while changing its schema."* That rule forbids the phased, zero-downtime
   order PC-09 requires. It was written for breaking migrations; `0070`/`0071`
   are additive, so the true condition is narrower and the runbook must say it
   precisely (§6.4).
4. **The conversion proofs are stronger than the dispatch assumed.** `convertGroupToGrantAuthority`
   implements P1–P7, blocks on the first failure with a field-level `check`
   pointer, and is idempotent on an already-converted group. PC-03's PG suite
   already covers the happy path and the shared-key block; PC-09 must cover the
   *drill*, not re-prove the function.
5. **The gate must not be `live-pipeline-e2e.test.ts`.** That suite needs a live
   Orchestrator on :3000, Connector on :8091, MinIO, Vault and a real BullMQ
   worker. It is a separate live proof, never the deterministic gate.

## 1. Evidence boundary

Read: the whole `orchestrator/services/orchestrator/tests/` inventory (421 `*.test.ts` files),
`tests/helpers/*`, `du-rework/tests/e2e/live-pipeline-e2e.test.ts`,
`du-rework/tests/harness/listen-loopback.ts`, `src/modules/profiles/profile-groups.ts`
(conversion), `src/modules/operations/submission.ts` (post-PC-05), the accepted
suites `profile-resolution-pg.test.ts`, `profile-v2-http.test.ts`,
`profile-groups-v2-pg.test.ts`, `profile-control-plane-migration.test.ts`,
`docs/12b-deployment-guide.md`, `orchestrator/docs/migrations.md`, and the
PC-02/PC-05/PC-06 receipts.

Not done: nothing was executed against a database in this packet, and no file
outside this report was written. Every statement about *future* behaviour is a
design statement, not a measurement.

## 2. Harness inventory (what actually exists)

| Harness | Location | Boots | Use for PC-09 |
|---|---|---|---|
| `createRuntimeFixture({suite})` | `services/orchestrator/tests/helpers/runtime-harness.ts` | Real `createApp` against a real PG + Redis, returns `baseUrl`, tokens, `http()` helper, `findJobForOperation` | **Base** for the HTTP matrix, needs a 6-action manifest variant |
| `LIVE` / `liveDescribe` / `warnIfSkipped` | same file | Gate on `DU_LIVE_INFRA=1` | Reuse verbatim |
| `listenLoopback(server, preferPort)` | `du-rework/tests/harness/listen-loopback.ts` | Deterministic port outside the ephemeral band | Reuse for any suite that binds |
| `validateTestDatabaseTarget` / `validateTestRedisTarget` | `tests/helpers/test-target-guard.ts` | Refuses a non-test database/Redis URL and returns sanitized targets | Reuse before any seeding |
| Scratch-DB pattern | `migrations.test.ts`, `profile-control-plane-migration.test.ts`, `profile-resolution-pg.test.ts` | `DROP/CREATE DATABASE` over the `postgres` maintenance DB, then `migrate(db, MIGRATIONS_DIR)` | Reuse for the PG tier |
| `du-rework/tests/e2e/live-pipeline-e2e.test.ts` | `du-rework/tests` | External stack on :3000/:8091/:5433/:6380 + MinIO + Vault | **Live proof only**, never the gate |
| `tests/deployment/*.cjs` | `du-rework/tests/deployment` | Compose/Docker smoke | Phase-6 deploy evidence |
| Browser suite | `du-rework/tests/browser` (Playwright) | Real UI | PC-08's surface, out of PC-09 scope |

### 2.1 Gaps found

| Gap | Consequence | Fix in PC-09 |
|---|---|---|
| No shared live-PG helper: several live suites each carry their own ~60-line scratch-DB setup | Drift risk; slow triage | Extract `helpers/scratch-db.ts` (`withScratchDatabase({suite})` returning `{db, url, close}`), **without** changing the existing suites |
| `buildManifest(businessId)` is private and single-action | The 6-endpoint matrix has no fixture | New `helpers/profile-control-plane-harness.ts` with a 6-action manifest |
| No cohort seeder | Every matrix cell would hand-write 8 tables | Cohort builders in the new harness (§4.2) |
| No worker-side claim consumer in the matrix | "Resolved parameters reach the handler" is untested end-to-end | Tier-3 assertion using `DefaultTaskContext.resolvedParameters()` from a real claim |

## 3. The 6 × 5 matrix

### 3.1 Cohort definitions (state, not intention)

| Cohort | `api_keys.key_mode` | `profile_groups.auth_authority` | Resolution path |
|---|---|---|---|
| **A — legacy standalone** | `LEGACY_STANDALONE` | — (no group) | v1 child membership → pinned profile |
| **B — unmanaged legacy** | `UNMANAGED_LEGACY` | — | `mode: 'legacy'`, no profile pin |
| **C1 — group pre-cutover** | `LEGACY_STANDALONE` | `CHILD_PROJECTION` | v1 child membership (group children still hold memberships) |
| **C2 — group post-cutover** | `GROUP_MANAGED` | `GROUP_GRANT` | root grant + unique function selector |
| **C3 — illegal mix (defensive)** | `GROUP_MANAGED` | `CHILD_PROJECTION` | must deny `409 PROFILE_CHANGED`, never fall back |
| **D — multi-key group** | `GROUP_MANAGED` × N keys | `GROUP_GRANT`, ≥2 ACTIVE grants | per-key resolution; each key pins its own admission |

The dispatch's "single-key vs multi-key" split is a property of **C2/D**, not a
separate authority state: a group with one grant and a group with three grants
resolve identically, and differ only in cross-key isolation and in the
workbench's explicit key choice.

### 3.2 Expected outcome per cell

Every cell asserts four things: (i) HTTP status, (ii) the operation's pin
columns, (iii) the effective parameters handed to the worker, (iv) whether a
fingerprint is required.

| Endpoint (action) | A | B | C1 | C2 (v1 body) | C2 (v2 submit) | C3 | D |
|---|---|---|---|---|---|---|---|
| `ingest` | 202 pinned | 202 legacy | 202 pinned | 202 pinned via grant | 202 + fp | 409 | 202 per key |
| `extract` | 202 pinned | 202 legacy | 202 pinned | 202 pinned via grant | 202 + fp | 409 | 202 per key |
| `analyze` | 202 pinned | 202 legacy | 202 pinned | 202 pinned via grant | 202 + fp | 409 | 202 per key |
| `transform` | 202 pinned | 202 legacy | 202 pinned | 202 pinned via grant | 202 + fp | 409 | 202 per key |
| `generate` | 202 pinned | 202 legacy | 202 pinned | 202 pinned via grant | 202 + fp | 409 | 202 per key |
| `compare` | 202 pinned | 202 legacy | 202 pinned | 202 pinned via grant | 202 + fp | 409 | 202 per key |

Pin assertions per cohort:

| Cohort | `operations.profile_id` | `profile_revision` | `profile_policy_snapshot` | `submission_keys.resolution_fingerprint` |
|---|---|---|---|---|
| A | child profile id | active revision | present | `NULL` (v1) |
| B | `NULL` | `NULL` | `NULL` | `NULL` |
| C1 | child profile id | pinned revision | present | `NULL` |
| C2 v1 | child profile id | pinned revision | present | `NULL` |
| C2 v2 | child profile id | pinned revision | present | **non-NULL**, 64-hex |
| C3 | — no row is written — | | | |
| D | per-key child pin | | present | per-key fingerprint |

### 3.3 Negative cells (same matrix, per endpoint)

| Case | Expected |
|---|---|
| presented key revoked (`api_keys.status='REVOKED'`) | 401 on every cohort |
| grant revoked while key stays ACTIVE (C2/D) | 403 `PROFILE_GROUP_UNAUTHORIZED`, zero rows |
| function `enabled=false` | 403, zero rows |
| v1 selector matches two group functions | 403 (ambiguity denial), zero rows |
| each of the 6 P-blocks (see §5.2) | 409 `STATE_CONFLICT` with the named `/check` pointer |
| stale v2 fingerprint on a new `Idempotency-Key` | 409 `PROFILE_CHANGED`, zero rows |
| same key + different fingerprint | 409 `IDEMPOTENCY_CONFLICT` |
| cross-key operation read (D) | 404 for the other key, 200 for the owner |

## 4. Harness design

### 4.1 `tests/helpers/scratch-db.ts` (new, shared)

```ts
export interface ScratchDatabase { url: string; db: Db; close(): Promise<void>; }
export async function withScratchDatabase(input: {
  suite: string;                 // becomes the DB name suffix; asserted /test/i
  migrationsDir?: string;        // default: the packaged migrations dir
  applyAllMigrations?: boolean;  // default true
}): Promise<ScratchDatabase>;
```

Rules it must keep from the existing suites: create over the `postgres`
maintenance database (never inside a transaction), terminate stragglers before
`DROP`, run the **real** runner (`migrate`) so checksums and the declared-object
drift guard are exercised, and drop in `afterAll` best-effort.

### 4.2 `tests/helpers/profile-control-plane-harness.ts` (new)

Registers a **connector-free** 6-action business so admission never needs a
Connector or provider:

```ts
export const PC09_BUSINESS = 'pc09-core';
export const PC09_ACTIONS = ['ingest','extract','analyze','transform','generate','compare'] as const;
export const PC09_MANIFEST_V1: BusinessManifest;  // no parameterResolution
export const PC09_MANIFEST_V2: BusinessManifest;  // parameterResolution on every action
```

`PC09_MANIFEST_V2` declares, per action, one `requestDefaults` property and one
`profileSettings` property, plus one **intentional overlap** property declared in
both schemas and mapped to exactly one source — the plan's own example shape.
`applyTopLevelDefaults` is `true` on `extract` only, so both branches of the
fallback rule are exercised.

Cohort builders (each returns the ids it created and is idempotent per tenant):

```ts
buildCohortA(h, { tenant, action })            // LEGACY_STANDALONE + pinned profile
buildCohortB(h, { tenant })                    // UNMANAGED_LEGACY, no profile
buildCohortC1(h, { tenant, action })           // CHILD_PROJECTION group + memberships
buildCohortC2(h, { tenant, action })           // GROUP_GRANT group + one ACTIVE grant
buildCohortC3(h, { tenant, action })           // GROUP_MANAGED key + CHILD_PROJECTION group
buildCohortD(h, { tenant, action, keys: 3 })   // GROUP_GRANT group + 3 ACTIVE grants
```

### 4.3 Tiers

| Tier | What it boots | What it proves |
|---|---|---|
| **T1 — HTTP admission** | `createApp` in-process on a loopback port, real PG, stub Redis | status codes, DTO strictness, pin columns, fingerprint storage, idempotent replay |
| **T2 — PG resolver** | `createDb` + real migrations, direct service calls | cohort branching, lock order, conversion drill, concurrency races |
| **T3 — worker consumption** | no server: a claim object shaped like `runtime.ts` returns | the resolved parameters reach `DefaultTaskContext.resolvedParameters()` unchanged; provider model precedence |

T3 is the only place where "the worker actually sees it" is proven; T1 stops at
the accepted operation.

## 5. Suite outline

### 5.1 `tests/profile-control-plane-matrix-pg.test.ts` (T2, new)

6 actions × cohorts A/B/C1/C2/C3 (+D on one action to keep runtime bounded) through
`submission.submit` and `submission.previewProfileV2`/`submitProfileV2`, asserting
the pin table in §3.2. Includes the §3.3 negatives that are cheap at this tier.

### 5.2 `tests/profile-cutover-drill-pg.test.ts` (T2, new)

The drill: seed an unconverted group (C1), run the phased sequence, assert each
gate.

| Step | Action | Assertion |
|---|---|---|
| D1 | dry-run inventory (PC-02 `INV-*`) on the seeded cohort | every query executes; the ambiguity/shared-key detectors are clean |
| D2 | call `convertGroupToGrantAuthority` | `previousAuthority='CHILD_PROJECTION'`, `alreadyConverted=false`, `accessVersion` bumped by exactly 1 |
| D3 | re-read the group | authority `GROUP_GRANT`; child memberships `REVOKED`; key `key_mode='GROUP_MANAGED'`; grant `ACTIVE` |
| D4 | v1 body submit for the same action | still 202 (v1 has no fingerprint), pins now come from the grant |
| D5 | v2 preview → submit | fingerprint returned, then accepted; `submission_keys.resolution_fingerprint` non-NULL |
| D6 | call conversion again | `alreadyConverted=true`, no second access-version bump, no duplicate grant |
| D7 | v1 **write** surfaces on the converted group (`profile.upsert`, attach, self-service) | `409 PROFILE_GROUP_V2_REQUIRED` |

P-block coverage (each seeded to trip exactly one proof and assert the `/check`
pointer): `P1_CANDIDATE_KEY` (two candidate keys, or a revoked candidate),
`P2_CHILD_MEMBERSHIP` (a child with a second ACTIVE membership),
`P3_SHARED_KEY` (candidate active on a standalone profile),
`P4_FOREIGN_AUTHOR` (candidate authored another group's revision),
`P5_CHILD_OWNERSHIP` (child `profile_names.group_id` mismatch),
`P6_CHILD_POINTER` (active pointer ≠ member `binding_revision`),
`P7_INFLIGHT_OPERATION` (a child with an operation in a non-terminal state).

### 5.3 `tests/profile-cutover-bridge-pg.test.ts` (T2, new)

The **bridge** window: a converted group whose grants are all revoked must still
be readable through v2 (`apiKeyGrants: []`, config visible) and must deny every
public admission. This is the exact state a botched cutover produces, and it is
the only rollback state the plan permits without a restore (§7).

### 5.4 `tests/profile-control-plane-http.test.ts` (T1, new)

Per endpoint, per cohort: 202/200 replay/401/403/409/422, the pin columns, the
`Idempotency-Key` requirement on v2, and the "no provider secret, no raw key" redaction
check on preview bodies.

### 5.5 `tests/profile-v2-workbench-http.test.ts` (T1, new, after PC-08)

Workbench v2 preview/submit with an admin session: explicit `apiKeyId`, local-USER
fence, CSRF, viewer denial, multi-key group requiring an explicit choice.

### 5.6 `packages/worker-sdk/tests/pc09-task-consumption.test.ts` (T3, new)

Claim → `DefaultTaskContext` → `resolvedParameters()` equals the pinned effective
input; `profileSettings` absent from it; `input.model` never becomes `providerModel`.

### 5.7 Kept as live proofs, never as gates

`live-pipeline-e2e.test.ts` (external stack) and `tests/deployment/*.cjs` run in
the deployment evidence step (§6.6). If they fail while the in-process gate is
green, the report must say so — the two levels are not interchangeable.

## 6. Phased cutover runbook

### 6.1 Phase 0 — freeze and capture

- Freeze profile/group/key authoring for the target tenant cohort.
- Capture `INV-01..INV-16` (PC-02) and store them as the conversion evidence.
- Record the **source commit** and the **image digest** separately; they are not
  the same claim.

Gate: inventory clean for the cohorts being converted; every ambiguity in
`INV-04`/`INV-07`/`INV-11` either resolved or the group is excluded.

### 6.2 Phase 1 — schema first (readers before writers)

1. Back up PostgreSQL (the only real rollback for a converted cohort).
2. Apply `0070` (and `0071` if not already applied):
   `docker compose --env-file .env.docker --profile migration run --rm orchestrator-migrate migrate`
3. Verify: `migrate:status` / `migrate:verify` exit 0, `VER-01..VER-09` green,
   `VER-04` shows no `<NULL>` key mode.
4. Deploy the **resolver-capable** Orchestrator image with no v2 writer use.

Gate: an unchanged v1 client keeps working for every cohort; the old image is
NOT required to run during the migration (see §6.4 for why the guide's blanket
rule does not apply here).

### 6.3 Phase 2 — convert one cohort

1. Run the drill (§5.2) against a restored copy first; attach its output to the
   release record.
2. Convert the cohort's groups through the PC-03 operation; capture the
   `P1..P7` result and the returned `accessVersion`.
3. Immediately exercise, per endpoint: one v1 submit (no fingerprint) and one
   v2 preview+submit.
4. Verify the v1 write firewall: `profile.upsert`/attach/self-service on the
   converted group returns `409 PROFILE_GROUP_V2_REQUIRED`.

Gate: 6/6 endpoints green for the cohort; no `PROFILE_CHANGED` on unchanged
clients; grant revoke denies within one request (no cached authorization).

### 6.4 Phase 3 — repeat per cohort, with a bridge window

Convert by tenant/group cohort, never globally. Between cohorts the system holds
**two authorities at once**, which is legal because the resolver branches per key.
The existing deployment-guide sentence forbids exactly this; the PC-09 runbook
must replace it with the narrower, true rule:

> An older Orchestrator may keep serving during an **additive** migration
> (`0070`, `0071` add columns/tables only). It must NOT serve across a breaking
> migration. After a cohort has written v2-only configuration (a `GROUP_GRANT`
> group with grant rows and requested defaults), rollback for that cohort is
> restore-or-forward-fix, not a schema downgrade.

### 6.5 Phase 4 — shadow compare (diagnostic only)

For each converted cohort, replay a read-only comparison: resolve the same
request through the root-grant resolver and through the pre-conversion
child-membership projection, and log differences.

Hard rule: **a mismatch never authorizes and never denies**. It produces an
incident row and a manual review. There is no fallback path from a mismatch to
either resolver: the plan's "no permissive legacy fallback" applies to
production traffic, and a shadow comparator that could switch resolvers would be
a second authority source.

### 6.6 Phase 5 — evidence assembly

| Level | Evidence | Must not be conflated with |
|---|---|---|
| Source | commit sha, suite output, exit codes | image |
| Built image | image digest, build log, bundled migration count | source |
| Running container | `/health`, migration ledger rows, route smoke, grant-revoke behaviour | image |

The plan requires all three separately; a green suite proves none of the other two.

### 6.7 Phase 6 — post-cutover steady state

- Global key revoke invalidates authentication everywhere and tombstones every
  grant in the same transaction (PC-03 `revokeAllGroupGrantsForApiKey`).
- Group grant revoke leaves the key ACTIVE and only that group denied.
- Rollback of a config revision never reactivates a revoked grant.

## 7. Rollback policy

| Window | Allowed | Not allowed |
|---|---|---|
| Before any v2 write for the cohort | Revert the image; the added columns are nullable/defaulted and the old reader ignores them | — |
| After v2 writes, before conversion | Revert the image is still safe (no group is `GROUP_GRANT`) | Assuming the v2 config is visible to the old reader |
| After conversion (`GROUP_GRANT`) | Restore from the phase-1 backup, or forward-fix | Downgrading `auth_authority`, dropping grants, re-creating child memberships |

There is no down migration. `0070` recreates an index under its original name
specifically so the runner's declared-object guard stays green; a file that
dropped `0070`'s objects would trip the same guard and block every startup.

## 8. Acceptance criteria for PC-09 execution

1. Every §3.2 cell has a passing assertion in the named suite.
2. Every §3.3 negative has a passing assertion and proves **zero durable rows**
   on denial (`operations`, `tasks`, `submission_keys`, `outbox`).
3. The drill (§5.2) passes on a restored copy and on the converted cohort, with
   P1–P7 each demonstrated at least once.
4. The bridge window (§5.3) is proven: readable config, zero admissions.
5. Shadow compare produces a log and changes no outcome.
6. Worker consumption (§5.6) proves parameters and model precedence from a
   real claim shape.
7. The three evidence levels of §6.6 are recorded separately, each with its own
   artefact.
8. Every suite runs with `DU_LIVE_INFRA=1` against a disposable database, and the
   receipt states exactly which suites were skipped and why.

## 9. Risks and open questions

| # | Risk / question | Recommendation |
|---|---|---|
| R-1 | The 6-endpoint T1 matrix is the most expensive suite in the repo (6 actions × 5 cohorts × ~4 assertions, each with an app boot). | Share one app boot per file, one database per file, and a per-suite `suite` prefix; keep D to a single action. |
| R-2 | `pc09-core` is a synthetic business, so the matrix proves the *platform*, not document-core's real manifest. | Run the same matrix once against `document-core` 1.2.0 as a slow confirmation, not in the gate. |
| R-3 | Shadow compare needs a pre-conversion projection that conversion deletes (memberships). | Capture the projection **before** conversion into the drill's evidence file; the comparator must read the captured projection, never resurrect memberships. |
| R-4 | PC-07 (retry) and PC-08 (workbench) are still in flight; their suites are listed here but cannot be written yet. | Sequence PC-09 execution after both; the retry cells reuse `assertGroupKeyAuthorized`. |
| R-5 | Does a converted cohort need a minimum soak time before the next cohort? | Yes — one full request cycle per endpoint with no `PROFILE_GROUP_UNAUTHORIZED` spike; the runbook should state a concrete interval set by the operator, not a guess. |
| R-6 | The existing guide's "stop everything" rule may be enforced by an operator checklist. | Ship the narrowed §6.4 wording **with** the release, not after; otherwise the operator will follow the stale rule and cause the downtime the plan forbids. |

## 10. References

| Topic | Location |
|---|---|
| Shared in-process fixture | `services/orchestrator/tests/helpers/runtime-harness.ts` (`createRuntimeFixture`, `LIVE`) |
| Deterministic bind | `du-rework/tests/harness/listen-loopback.ts` |
| Scratch-DB precedent | `tests/migrations.test.ts`, `tests/profile-control-plane-migration.test.ts`, `tests/profile-resolution-pg.test.ts` |
| Accepted resolution suite | `tests/profile-resolution-pg.test.ts` (14 tests, PC-05) |
| Accepted group suite | `tests/profile-groups-v2-pg.test.ts` (14 tests, PC-03) |
| Accepted migration suite | `tests/profile-control-plane-migration.test.ts` (45 tests run, PC-02) |
| Conversion implementation | `src/modules/profiles/profile-groups.ts` (`convertGroupToGrantAuthority`, P1–P7) |
| Admission seams | `src/modules/operations/submission.ts` (`submit`, `previewProfileV2`, `submitProfileV2`) |
| Worker consumption | `packages/worker-sdk/src/task-context.ts` (`describeResolvedParameters`) |
| Migration operator docs | `orchestrator/docs/migrations.md` |
| Deployment order and rollback prose | `du-rework/docs/12b-deployment-guide.md` |
| Master plan | `du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` §PC-09, §Acceptance matrix |

# Receipt — PC-09-HARNESS (shared live-PG and cohort harness)

| Field | Value |
|---|---|
| Packet | `PC-09-HARNESS` — *Shared Live-PG & Profile Control Plane Test Harness* |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — smoke suite 13/13, service tsc 0, scratch database proven dropped |
| Design source | [`prep-pc09-cutover-spec.md`](prep-pc09-cutover-spec.md) §4.1, §4.2 |
| Lease respected | Exactly the three new files; no existing source or test was modified |

**Tóm tắt (VI).** Đã tạo hai helper dùng chung: `withScratchDatabase` (guard → tạo DB → chạy migration thật → drop) và harness 6 action không cần Connector với 6 cohort builder (A/B/C1/C2/C3/D). Smoke suite 13/13 pass trên PostgreSQL 16 thật. Hai lỗi thiết kế đã được phát hiện và sửa trong lúc làm: (1) migration hiện có **68 file** chứ không phải 72 (do 3 khoảng trống lịch sử 0053/0058/0062); (2) thứ tự seed group bắt buộc phải **hai pha** vì `profile_groups.active_revision` là FK deferrable còn `profile_names_owner_shape` đòi con phải có group ngay khi insert.

---

## 1. Files delivered

| File | Size | Content |
| :--- | ---: | :--- |
| `tests/helpers/scratch-db.ts` | 6.8 KB | `withScratchDatabase`, `expectedMigrationCount`, `SCRATCH_MIGRATIONS_DIR`, `ScratchDatabase` |
| `tests/helpers/profile-control-plane-harness.ts` | 26.1 KB | `PC09_BUSINESS`/`PC09_ACTIONS`, two immutable manifests + digests, business/tenant seeding, six cohort builders, selector/submission helpers |
| `tests/profile-control-plane-harness.test.ts` | 15.4 KB | 13 smoke tests (live-gated) |

## 2. Design decisions and why

### 2.1 `withScratchDatabase` — guard first, deterministic identity

| Decision | Reason |
|---|---|
| Base `DATABASE_URL` goes through `validateTestDatabaseTarget` **before** any connection | A production URL must be refused before a socket opens, not after |
| The derived scratch URL is validated again | The guard's `_test` naming rule then holds for the database actually migrated |
| Name is `du_scratch_<suite>_test`, deterministic | A crashed run leaks one reclaimable name instead of a new one per crash; the repo runs `--runInBand`, so same-suite concurrency is not a supported mode (documented in the file) |
| Migration via the real `migrate()` runner | Checksums, one-transaction-per-file and the declared-object drift guard are exercised exactly as at boot |
| `close()` is idempotent and runs on setup failure | A failed migration cannot strand a half-migrated database |
| `applyAllMigrations: false` escape hatch | A suite that needs a genuinely empty database is possible without a second helper |

Measured fact: the packaged directory declares **68** migrations (`0001…0071` minus the three historical gaps `0053/0058/0062`), and the ledger's max sequence is **71**.

### 2.2 The harness business is connector-free **on purpose**

`pc09-core` declares the six gateway actions with `connectorSlots: []`. Without that, every cell of the matrix would drag a Connector pin (and its tenant-default fallback) into what is a profile/authorization test. Two immutable versions exist so the same database can prove both generations:

- `1.0.0` — no `parameterResolution` → v1 merge semantics;
- `2.0.0` — capability declared, with `mode`/`enableReasoning` as `requestDefaults`, `maxParallel`/`reviewDepth` as `profileSettings`, and `enableReasoning` as the **intentional overlap** the capability must resolve to one source instead of inferring.

`reviewDepth` carries `defaultLocked: true`, so `explicit ?? schema.defaultLocked ?? false` is exercised by the fixture itself rather than only by a unit test.

### 2.3 Two-phase group seeding (a real constraint, discovered by running it)

The first implementation inserted the child before its group and re-pointed `profile_names.group_id` afterwards. It failed with `profile_names_owner_shape`: a registry row must carry a key **or** a group at insert time. Combined with the deferrable `profile_groups.active_revision` FK, the only order that works is:

```
insert group root (active_revision 0) → insert revision 1
  → insert children (group_id known) → insert members → UPDATE active_revision = 1
```

That invariant is encoded in `insertGroupRoot` / `insertMember` / `activateGroupRevision` and documented there, so a future builder cannot repeat the mistake.

### 2.4 Cohort semantics worth pinning

| Cohort | Shape | The property it lets a suite assert |
|---|---|---|
| A | `LEGACY_STANDALONE` + memberships | v1 pinned resolution still works |
| B | `UNMANAGED_LEGACY`, zero profile rows | `mode: 'legacy'`, and the row counts really are zero |
| C1 | `CHILD_PROJECTION`, memberships, no grant | pre-cutover behaviour is unchanged |
| C2 | `GROUP_GRANT` + grant, **no memberships** | the grant path works *and* `resolveEffectiveProfile` alone would answer `legacy` — the exact fallback the front resolver must pre-empt |
| C3 | `GROUP_MANAGED` + `CHILD_PROJECTION`, **grant and membership both present** | the `409 PROFILE_CHANGED` denial can only come from the authority check, never from missing state |
| D | `GROUP_GRANT` + N grants | every key resolves the same children |

C3 is deliberately over-provisioned: it holds both authorization paths, so a regression that reintroduced a fallback would resolve successfully instead of quietly passing.

## 3. Verification log (actually run)

Environment: Node v22.23.3, disposable `postgres:16-alpine` on host port 55440 (removed after the run). The project database was never contacted.

| # | Command (cwd `services/orchestrator`) | Result |
| :--- | :--- | :--- |
| 1 | `DU_LIVE_INFRA=1 DATABASE_URL=…jest --runInBand --config jest.config.cjs tests/profile-control-plane-harness.test.ts` | **exit 0** — `Tests: 13 passed, 13 total` |
| 2 | `jest --runInBand --config jest.unit.config.cjs tests/profile-control-plane-harness.test.ts` (no `DU_LIVE_INFRA`) | **exit 0** — `Test Suites: 1 skipped`, `Tests: 13 skipped, 13 total` |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 4 | `psql -c "select datname from pg_database where datname like 'du_scratch%'"` after the run | **no rows** — teardown dropped the scratch database |

Smoke coverage (all green):

1. every migration applies through the real runner; ledger count equals the directory count; max sequence is 71;
2. `verifyMigrations` resolves ⇒ declared-object drift guard green on a fresh database;
3. a non-test target (`du_production`) is refused before connecting;
4. both manifests validate, digests differ, v1 carries no capability, v2 carries the exact expected mapping, and every action is connector-free;
5. both versions registered with exactly one active pointer; catalog enabled and not paused;
6. `activatePc09Version` moves the pointer and moves it back;
7. `pc09ManifestFor` matches the registered digests and rejects an unknown version;
8. cohort A resolves `pinned` through its membership, and the group resolver returns `null`;
9. cohort B has zero profile and zero membership rows and resolves `legacy`;
10. cohort C1 resolves through child memberships with `CHILD_PROJECTION`;
11. cohort C2 resolves through the grant with zero memberships, and the v1 resolver alone answers `legacy`;
12. cohort C3 is denied `409 PROFILE_CHANGED`;
13. cohort D: three keys resolve the same children, and all six actions resolve on one converted group.

## 4. Deviations and known limitations (explicit)

| # | Item | Impact / follow-up |
|---|---|---|
| 1 | The smoke suite is **not** registered in `jest.unit.config.cjs`'s live-exclusion list. | That file is outside this lease. The suite guards itself with `DU_LIVE_INFRA`, so a default unit run compiles it and skips all 13 tests (one `console.warn`). Register it in the next packet that owns the config. |
| 2 | The four existing live suites keep their own scratch-database code. | The lease forbids editing accepted evidence. Consolidating them onto `withScratchDatabase` is a follow-up; until then the helper is the *new* suites' convention, not a repo-wide one. |
| 3 | The harness is PG-only: it does not boot the app. | Tier 1 (HTTP) still uses `createRuntimeFixture`; PC-09's HTTP suite needs both, or a six-action variant of the runtime fixture. |
| 4 | Deterministic database names collide if two instances of the same suite run concurrently. | Documented in the file; the repository runs `--runInBand`. Use distinct `suite` strings otherwise. |
| 5 | `profile-group` conversion is *not* exercised here. | The drill belongs to `profile-cutover-drill-pg.test.ts` (PC-09 execute); this packet only makes the cohorts seedable. |

## 5. Suggested next steps (PC-09 execute)

1. Register the smoke suite in the live-suite exclusion list, then write the matrix suite on top of these builders (`profile-control-plane-matrix-pg.test.ts`).
2. Add the conversion drill, which can now start from `buildCohortC1` and assert the P1–P7 gates plus `alreadyConverted` idempotency.
3. Add the bridge-window suite: revoke every grant on a `buildCohortC2` group and assert readable config plus zero admissions.
4. Extend `runtime-harness.ts` with a six-action manifest variant for the HTTP tier (separate lease).

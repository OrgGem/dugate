# Receipt — PC-09-MATRIX (6 × 5 cutover matrix)

| Field | Value |
|---|---|
| Packet | `PC-09-MATRIX` — *Profile Control Plane 6 × 5 E2E Cutover Matrix* |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — 43/43 tests pass on PostgreSQL 16, tsc 0, scratch DB dropped |
| Design source | [`prep-pc09-cutover-spec.md`](prep-pc09-cutover-spec.md) §3, §4 |
| Harness source | [`receipt-pc09-harness.md`](receipt-pc09-harness.md) |
| Lease respected | Exactly one new file; no existing source or test modified |

**Tóm tắt (VI).** Đã implement ma trận 6 action × 5 cohort (+ cohort D và chiều v2) trong `tests/profile-control-plane-cutover.test.ts`: **43/43 test pass** trên PostgreSQL 16 thật, chạy qua `submission.submit` thật và assert **cột pin trên hàng `operations`** chứ không phải giá trị trả về của service. Hai sự thật hành vi được phát hiện khi chạy: (1) mọi function kind `endpoint` **bắt buộc** có `endpoint_slug` (CHECK của 0070), nên một admission v1 phải mang selector thì cohort A/C1/C2 mới phân giải được; (2) cohort C3 và B không có con cho mọi action nên ô test phải rẽ nhánh trước khi tra child.

---

## 1. File delivered

`orchestrator/services/orchestrator/tests/profile-control-plane-cutover.test.ts` — 43 tests, live-gated on `DU_LIVE_INFRA=1`.

Composition:

| Block | Tests |
|---|---:|
| Cohort state invariants (C2 zero memberships, C3 dual authority, D three grants) | 3 |
| Cohort A × 6 actions | 6 |
| Cohort B × 6 actions | 6 |
| Cohort C1 × 6 actions | 6 |
| Cohort C2 × 6 actions | 6 |
| Cohort C3 × 6 actions (denial) | 6 |
| Cohort D × 6 actions × 3 keys | 6 |
| v2 dimension on C2 (preview+submit, replay after drift, stale fingerprint) | 3 |
| Cross-cohort isolation | 1 |
| **Total** | **43** |

## 2. What each cell asserts

The matrix asserts the **operation row**, not the service return value. The pin
columns are the durable fact every later consumer reads (claim, grant issuance,
retry, projection), so a green cell means the worker will receive that
configuration.

| Cohort | Key mode / authority | Expected admission | Pin asserted |
|---|---|---|---|
| **A** | `LEGACY_STANDALONE`, no group | admitted, v1 membership | `profile_id` = child, revision = 1, policy snapshot non-null |
| **B** | `UNMANAGED_LEGACY`, no profile | admitted in `legacy` mode | `profile_id`/`profile_revision`/`profile_policy_snapshot` all **NULL** |
| **C1** | `LEGACY_STANDALONE` + `CHILD_PROJECTION` | admitted, v1 membership | same pin as A |
| **C2** | `GROUP_MANAGED` + `GROUP_GRANT`, **zero memberships** | admitted through the root grant | same pin as A — reached with no membership to fall back to |
| **C3** | `GROUP_MANAGED` + `CHILD_PROJECTION`, grant **and** membership present | **409 `PROFILE_CHANGED`** | zero new rows (count compared before/after) |
| **D** | `GROUP_MANAGED` + `GROUP_GRANT` × 3 keys | each key admitted independently | identical `profile_id`/`revision` across keys; `api_key_id` differs per key |

v2 dimension (C2, real fingerprint flow):

| Case | Asserted |
|---|---|
| preview → submit | refs echo the group pin; `mode` reported as a schema default fill (`appliedSchemaDefaults`); `submission_keys.resolution_fingerprint` equals the preview fingerprint |
| replay after `access_version` drift | `replayed: true`, same operation id |
| stale fingerprint on a new `Idempotency-Key` | 409 `PROFILE_CHANGED`, operation count unchanged |

## 3. Two behavioural facts the matrix surfaced

### 3.1 An endpoint function can never be selector-free

`0070`'s `profile_group_members_function_shape` CHECK requires
`endpoint_slug IS NOT NULL` for every `function_kind = 'endpoint'` member. So a
group function is **always** endpoint-scoped, which means a v1 admission that
carries no selector cannot match it. The first matrix run failed every pinned
cohort with `api key is not authorized for action …` for exactly this reason.

The suite now passes the selector the way a real v1 client does
(`profileEndpointSlug: child.endpointSlug`), and the comment says why. This is
worth carrying into the runbook: **a v1 client that never sends an endpoint
selector cannot be served by a group-managed function**, and the fix is not in
the resolver — it is the schema's deliberate shape.

### 3.2 The defensive and profile-less cells must branch before lookup

`childFor(cohort, action)` assumed every cohort has a child per action. Two
cohorts legitimately do not:

- **B** has no profile at all;
- **C3** seeds a single action because the denial happens before selector
  matching, so additional children would prove nothing.

The cell now branches on the cohort kind first and only looks up a child for the
pinned cohorts. The receipt records this because it is the kind of assumption
that silently turns a "denial" test into a "missing fixture" test.

## 4. Verification log (actually run)

Environment: Node v22.23.3, disposable `postgres:16-alpine` on host port 55440
(removed after the run). Migrations `0001…0071` applied by the real runner
(68 files — three historical gaps). The project database was never contacted.

| # | Command (cwd `services/orchestrator`) | Result |
| :--- | :--- | :--- |
| 1 | `DU_LIVE_INFRA=1 DATABASE_URL=… jest --runInBand --config jest.config.cjs tests/profile-control-plane-cutover.test.ts` | **exit 0** — `Test Suites: 1 passed`, `Tests: 43 passed, 43 total` |
| 2 | `jest --runInBand --config jest.unit.config.cjs tests/profile-control-plane-cutover.test.ts` (no `DU_LIVE_INFRA`) | **exit 0** — `Test Suites: 1 skipped`, all tests skipped |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 4 | `psql -c "select datname from pg_database where datname like 'du_scratch%'"` after the run | **no rows** — teardown dropped the scratch database |

Observed operation volume: 30 pinned/legacy admissions (5 cohorts × 6 actions,
minus the 6 denied C3 cells) + 18 cohort-D admissions + 3 v2 submissions, all
against one scratch database seeded once per cohort.

## 5. Deviations and known limitations (explicit)

| # | Item | Impact / follow-up |
|---|---|---|
| 1 | The suite is **not** registered in `jest.unit.config.cjs`'s live-exclusion list. | Outside this lease. The suite self-guards with `DU_LIVE_INFRA`, so a default unit run compiles it and skips every test (one `console.warn`). Register it in the next packet that owns the config. |
| 2 | The matrix drives the **service** seam (`submission.submit` / `submitProfileV2`), not HTTP. | Tier 1 (HTTP status codes, headers, DTO strictness) still belongs to `profile-control-plane-http.test.ts` in the PC-09 execute packet, which also needs a six-action runtime fixture. |
| 3 | Conversion (`convertGroupToGrantAuthority`) is not exercised here. | The drill is `profile-cutover-drill-pg.test.ts`; C2 is seeded in its **post-cutover** shape so the matrix can start from a converted group without re-running conversion. |
| 4 | The matrix runs against the opt-in manifest (`2.0.0`) only. | v1-only manifests are covered by the harness smoke test (version 1.0.0 validates and carries no capability); running the full matrix twice would double runtime for little added signal. |
| 5 | `cross-cohort isolation` asserts no key appears under two tenants. | It is a sanity check over the matrix's own writes, not a substitute for the dedicated tenant-fence suites already in the repo. |

## 6. Suggested next steps (PC-09 execute)

1. **Cutover drill** (`profile-cutover-drill-pg.test.ts`): start from the
   harness's C1 cohort, convert, and assert P1–P7 plus `alreadyConverted`
   idempotency and the v1 write firewall (`409 PROFILE_GROUP_V2_REQUIRED`).
2. **Bridge window**: revoke every grant on a C2 group and assert readable v2
   config plus zero admissions — the only rollback state the plan permits
   without a restore.
3. **HTTP tier**: extend `runtime-harness.ts` with a six-action manifest and
   assert status codes and the redaction of preview bodies.
4. **Shadow compare**: capture the pre-conversion projection during the drill and
   prove a mismatch changes no outcome.

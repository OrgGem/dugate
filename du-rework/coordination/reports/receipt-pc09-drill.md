# Receipt — PC-09-DRILL (phased cutover and conversion drill)

| Field | Value |
| :--- | :--- |
| Packet | `PC-09-DRILL` — *Phased Cutover & Conversion Drill Test Suite* |
| Worker | `dsh_1` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Date | 2026-10-21 |
| Design source | [`prep-pc09-cutover-spec.md`](prep-pc09-cutover-spec.md) §5.2 and §6 |
| Status | **COMPLETE** — live 20/20, `tsc --noEmit` exit 0, offline run skips cleanly |
| Lease | one file: `tests/profile-control-plane-cutover-drill.test.ts` (new) |

**Tóm tắt (VI).** Bộ diễn tập chuyển đổi theo giai đoạn đã chạy thật trên PostgreSQL 16 (scratch
database, chuỗi migration thật `0001…0071`): cohort C1 (`CHILD_PROJECTION` + key `LEGACY_STANDALONE`)
qua được kiểm kê khô; chuyển đổi báo `CHILD_PROJECTION → GROUP_GRANT`, tăng `access_version` đúng 1,
tạo grant `ACTIVE`, tombstone toàn bộ membership con, nâng key thành `GROUP_MANAGED`; cả 7 bằng chứng
P1–P7 đều chặn được và **không ghi gì**; sau chuyển đổi, submit v1 vẫn 202 (pin qua grant), v2
preview→submit lưu `resolution_fingerprint`; chuyển đổi lần hai idempotent; mọi bề mặt ghi v1 trả
`409 PROFILE_GROUP_V2_REQUIRED`; rollback cấu hình không đụng grant ledger và không làm giảm
`access_version` (kể cả sau khi grant đã bị revoke).

---

## 1. File delivered

| File | Δ | Content |
| :--- | :--- | :--- |
| `tests/profile-control-plane-cutover-drill.test.ts` | **new** (20 cases) | T2 drill: inventory → conversion → P1–P7 blocks → post-cutover admission → firewall → config rollback |

No production file was touched. The only imports are the accepted PC-09 helpers
(`helpers/scratch-db.ts`, `helpers/profile-control-plane-harness.ts`, `helpers/runtime-harness.ts`) and
the accepted services (`submission`, `profiles`, `registry`, `profile-groups`).

## 2. What each leg proves

| Step | Case | Assertion (actually executed) |
|---|---|---|
| **D1** | the C1 cohort is clean | one candidate key; zero cross-group sharing; zero standalone/group mix; zero endpoint-aware selector overlap; zero in-flight child operations |
| **D2** | conversion reports the flip | `previousAuthority='CHILD_PROJECTION'`, `authority='GROUP_GRANT'`, `alreadyConverted=false`, `grantedKeyId=<the key>`, `revokedChildMemberships=6` (one per action), `accessVersion = before + 1` |
| **D3** | post-state | exactly one `ACTIVE` grant; `api_keys.key_mode='GROUP_MANAGED'`; all child memberships `REVOKED` (tombstones, not deletes); config `active_revision` unchanged by a conversion |
| **D3b** | resolution source | `resolveRootGrant` returns the group + `accessVersion`; `readGroupAuthority` returns `GROUP_GRANT` |
| **P1** | two candidates | two keys that are members of every child ⇒ `P1_CANDIDATE_KEY` |
| **P1b** | no candidate | the only candidate revoked ⇒ `P1_CANDIDATE_KEY` |
| **P2** | second membership | a rival key on **one** child of a two-action cohort ⇒ `P2_CHILD_MEMBERSHIP` |
| **P3** | shared key | candidate also `ACTIVE` on a standalone profile ⇒ `P3_SHARED_KEY` |
| **P4** | foreign author | candidate named by another group's revision ⇒ `P4_FOREIGN_AUTHOR` |
| **P5** | child ownership | the `(profile_id, group_id)` FK refuses the dirty state (`23503`), so P5 is defence-in-depth; the clean cohort then still converts |
| **P6** | child pointer | a child pointer moved to revision 2 while the member pins 1 ⇒ `P6_CHILD_POINTER` |
| **P7** | in-flight work | a `RUNNING` operation on a child ⇒ `P7_INFLIGHT_OPERATION` |
| **D4** | v1 after cutover | `submission.submit` accepts; the operation pins the **child** profile, its revision, a non-null policy snapshot and the original `api_key_id` |
| **D5** | v2 after cutover | preview returns `sha256:<64>` and child refs; submit accepts and `submission_keys.resolution_fingerprint` equals it |
| **D6** | re-convert | `alreadyConverted=true`, `revokedChildMemberships=0`, `accessVersion` unchanged, still one grant |
| **D7** | v1 firewall | `assertLegacyGroupWriteAllowed` by group **and** by profile ⇒ 409; `saveProfileGroup` and `rollbackProfileGroup` ⇒ 409 `PROFILE_GROUP_V2_REQUIRED`; revision and grant unchanged |
| **R1** | config rollback | rev 2 published then rolled back to rev 1: `access_version` unchanged by both config writes, one `ACTIVE` grant, original policy/requestDefaults restored |
| **R2** | revoke then rollback | grant revoked (bump +1), then a config rollback: `access_version` stays at the post-revoke value, the tombstone survives, and the API key stays `ACTIVE` |
| **R3** | fixture boundary | a config rollback on the synthetic C1 cohort is refused by catalog validation (`INVALID_SCHEMA`), not by authority, and mutates nothing |

Every P-block case additionally asserts **zero writes** on refusal: authority and `access_version`
unchanged, no grant row, key mode still `LEGACY_STANDALONE`, child memberships untouched.

## 3. Verification (actually run)

| # | Command | Result |
|---|---|---|
| 1 | `DU_LIVE_INFRA=1 DATABASE_URL=…/du_orchestrator_test node node_modules/jest/bin/jest.js --runInBand tests/profile-control-plane-cutover-drill.test.ts` | **exit 0** — `Test Suites: 1 passed`, `Tests: 20 passed, 20 total` |
| 2 | same file with `--config jest.unit.config.cjs` and **no** `DU_LIVE_INFRA` | `Test Suites: 1 skipped`, `Tests: 20 skipped` — no connection attempt, so the offline gate stays green |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**, no diagnostics |

Environment: PostgreSQL 16.11 (`127.0.0.1:15433`), scratch database `du_scratch_pc09_cutover_drill_test`
created and dropped by `withScratchDatabase`, real migration runner (`migrate`) so checksums and the
declared-object drift guard were exercised. The project database (`du_orchestrator_dev`) was **not**
touched; the suite derives its scratch database from a `_test`-suffixed base URL, which is what the
test-target guard requires.

## 4. Deviations and judgement calls

1. **The rollback leg authors its own group.** The C1/C2 harness cohorts carry synthetic function
   identities (`<action>.default` / `<action>:default`) that the real business catalog does not
   declare, so any v2 config write on them is refused by *catalog validation* — a fixture limitation,
   not an authority bug. Case **R3** pins that boundary honestly, and cases **R1/R2** run the rollback
   drill on a catalog-compatible group authored through `saveProfileGroupV2` + `issueGroupKey`, i.e.
   the same `GROUP_GRANT` state a converted cohort reaches. The granted invariants (monotonic
   `access_version`, grants intact across config rollbacks, no resurrection after revoke) are exactly
   the ones the dispatch names.
2. **P5 is asserted as a schema guarantee.** `profile_group_members` has a composite FK to
   `profile_names (profile_id, group_id)`, so a member whose registry row points at another group
   cannot exist. The case proves the FK refuses the mutation and that the clean cohort still converts,
   which is the strongest reachable statement.
3. **P2 needed a two-action cohort.** With a single child, a second member automatically becomes a
   full-intersection candidate and the conversion stops at P1. The case therefore seeds two actions so
   the rival is a member of one child only — that is what makes P2 the first failing proof.
4. **Not added to `jest.unit.config.cjs`.** That file is outside this packet's lease. The suite
   self-gates on `DU_LIVE_INFRA=1` and skips without connecting, so the offline run is unaffected; a
   one-line `liveSuites` registration remains available to the coordinator if the convention (as with
   `profile-resolution-pg.test.ts`) should be uniform.

## 5. Handoff

**Runbook (§6 of the spec).** The drill is the artifact to attach to a release record for phase 2:
run it against a restored copy first, then convert the cohort and re-run D2–D7 on the real cohort.

**Operator notes learned while executing it**

* A conversion is not a config edit: `active_revision` must not move (asserted in D2).
* Grant changes are the only thing that moves `access_version`; both config writes in R1 leave it
  alone, and the rollback in R2 cannot undo a revoke.
* `profile_groups_active_revision_fk` is deferrable — a group root and its first revision must be
  created in one transaction, or the FK fails at statement end. Anyone scripting a cohort seed will
  hit this.
* `revokedChildMemberships` equals the number of functions in the group, because each child holds
  exactly one membership.

**Still open for PC-09 proper (not this packet):** the 6 × 5 admission matrix
(`profile-control-plane-matrix-pg.test.ts`), the bridge window (`profile-cutover-bridge-pg.test.ts`),
the HTTP tier, the worker-consumption tier, and the three evidence levels. This packet delivers the
drill only.

## 6. Evidence boundary

Source + test evidence against a disposable PostgreSQL 16 database. No built image, no running
container, no deployment claim. Migration state: the suite applies the full packaged chain to its own
scratch database; `0070` is still **not** applied to the project dev database.

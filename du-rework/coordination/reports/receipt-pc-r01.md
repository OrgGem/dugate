# Receipt — PC-R01 (Explicit key mode controls fallback)

| Field | Value |
| :--- | :--- |
| Finding | **PC-R01** — *Explicit standalone mode still reaches unmanaged fallback* (P1) |
| Packages touched | PC-04, PC-05 (PC-09 regression evidence) |
| Worker | `dsh_1` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Date | 2026-10-21 |
| Status | **COMPLETE** — gate suites 100/100, `tsc --noEmit` exit 0 |
| Lease | `profiles.ts`, `api-keys.ts`, `submission.ts`, test files |

**Tóm tắt (VI).** Lỗ hổng: key `LEGACY_STANDALONE` **không có membership row nào** (issue với
`profileIds: []`, hoặc rotate từ key mà toàn bộ membership đã bị tombstone) rơi vào nhánh
`selectActiveRow → 'legacy'` và được cấp quyền kiểu *unmanaged* cho mọi action. Đã sửa: `key_mode`
được đọc **trước mọi membership** và là nguồn quyền duy nhất — chỉ `UNMANAGED_LEGACY` (và chỉ khi key
chưa từng có membership) mới đi nhánh legacy; `LEGACY_STANDALONE` không có membership hợp lệ bị từ
chối; `GROUP_MANAGED` không bao giờ mượn quyền child-membership; `NULL`/không rõ fail closed. Thêm
guard thứ hai ở `resolveAdmission` và bộ 15 test hồi quy phủ cả hai entry point của vòng đời key.

---

## 1. Files delivered

| File | Δ | Content |
| :--- | :--- | :--- |
| `src/modules/profiles/profiles.ts` | +43/−20 | `selectActiveRow`: authority-before-evidence. Reads `api_keys.key_mode` first; `UNMANAGED_LEGACY` (membership-free) is the only `'legacy'` path; `GROUP_MANAGED`, `LEGACY_STANDALONE`-without-membership and NULL/unknown all return `'not-authorized'` |
| `src/modules/operations/submission.ts` | +13 | `resolveAdmission`: on a `'legacy'` result, re-read the key and deny unless it is an **ACTIVE** `UNMANAGED_LEGACY` key (belt-and-braces; one read, only on that branch) |
| `src/modules/identity/api-keys.ts` | **0** | verified compliant — see §2 |

> **Reading `git status` on this tree.** `api-keys.ts`, `submission.ts` and `profiles.ts` all show as
> modified because the PC-03/PC-04/PC-05 lanes' work is still uncommitted on top of `HEAD`. PC-R01's
> own contribution is the `selectActiveRow` block in `profiles.ts` and the 13-line guard in
> `submission.ts`; **`api-keys.ts` was not edited by this packet at all** (its diff is PC-04's group
> key/grant work, which is exactly what §2 verifies).
| `tests/pc-r01-key-mode-fallback.test.ts` | **new** (15 cases) | lifecycle entry points, denial at three layers, unmanaged path, scoped behaviour preserved |

### Fixture harmonisation (test files, disclosed)

Three suites' hand-written fakes answered the new authority read incorrectly; they are fixture-only
edits, each with a `PC-R01` comment:

| File | Change |
| :--- | :--- |
| `tests/woc-profile-groups-backend.test.ts` | two routers project `key_mode` on their `api_keys WHERE id=$1` rows; the rotating fake now persists `key_mode` on insert instead of dropping it |
| `tests/cb02b-profile-publish-callback.test.ts` | one branch for the mode read; statement-ordering assertion now locates the profile SELECT instead of assuming index 0 |
| `tests/wt04-profile-invalid-callback-read.test.ts` | blanket fake now answers the mode query distinctly (it returned the binding row for *every* SQL) |

## 2. Requirement mapping

### 2.1 `profiles.ts` — authority before evidence

`selectActiveRow` now runs, in order:

1. `SELECT key_mode FROM api_keys WHERE id=$1`
2. missing key → `'not-authorized'` (nothing may resolve for it);
3. `UNMANAGED_LEGACY` → `'legacy'` **only** when the key has no membership row at all; a contradicting
   row (mode says unmanaged, memberships exist) → `'not-authorized'`;
4. `GROUP_MANAGED` → `'not-authorized'` — it is authorized by its root grant (PC-05), never by stale
   child memberships;
5. `NULL`/unknown → `'not-authorized'` (plan §2: after migration a missing mode is an authorization
   error, not a default);
6. `LEGACY_STANDALONE` → the unchanged membership path: active revision row, else the
   `pointer-missing` diagnostic, else **`'not-authorized'`**.

The behaviour change is exactly one sentence: *"no eligible membership" no longer means "unmanaged"*.

Because `resolveBinding` shares `selectActiveRow`, the discovery surface (`GET /api/v1/services`, which
resolves every sub-case and drops 403/404 rows) denies unassigned functions too.

### 2.2 `api-keys.ts` — reconciled, no change required

Verified rather than assumed:

* `issue` writes `key_mode = 'LEGACY_STANDALONE'` **literally** in the INSERT, so a key issued with
  `profileIds: []` is explicitly standalone and carries no entitlement.
* `rotate` pre-reads the mode with `parseKeyMode`, which throws `409 STATE_CONFLICT`
  (`'API-key authority mode is not declared'`) for `NULL`/unknown, and re-inserts the **preserved**
  mode. `LEGACY_STANDALONE` copies only the current ACTIVE membership set (tombstones are not
  resurrected); `UNMANAGED_LEGACY` inherits nothing by design; `GROUP_MANAGED` goes through the
  group-rotation path.

Both entry points therefore already track the mode explicitly; the defect lived entirely in the
admission fallback. The regression suite pins all four behaviours so a future edit cannot silently
infer a mode.

### 2.3 `submission.ts` — non-group admission checks the mode

`resolveAdmission` keeps `resolveGroupAdmission` first. On the non-group branch, if
`resolveEffectiveProfile` returns `mode: 'legacy'`, the key is re-read and the request is denied with
`403 PERMISSION_DENIED` unless the key is `ACTIVE` **and** `UNMANAGED_LEGACY`. This is defence in depth
for the one path with no profile fence; it costs one read and only on that branch.

## 3. Regression evidence (new suite, 15 cases)

| Group | Cases |
|---|---|
| Lifecycle entry points | issue with `profileIds: []`; rotate from tombstone-only; rotate keeps `UNMANAGED_LEGACY`; rotate refuses an undeclared mode with no replacement key minted |
| The fallback is closed | both lifecycle keys denied at the resolver; denied at discovery (`resolveBinding`); denied at `resolveAdmission` with **zero INSERTs**; denied at `submit` with **zero `operations`/`tasks`/`outbox`/`submission_keys` writes**; NULL-mode key denied |
| The one permitted unmanaged path | `UNMANAGED_LEGACY` with no membership history resolves `legacy` end-to-end; `UNMANAGED_LEGACY` that contradicts itself with membership rows is denied |
| Scoped behaviour preserved | assigned standalone key still resolves its pinned profile; `GROUP_MANAGED` never borrows child authority (resolver denies, front admission answers `PROFILE_GROUP_UNAUTHORIZED`); revoked-membership denial unchanged |

"Zero durable rows" is asserted from the fake's statement log, not inferred: the deny cases are shown
to reach the refusal without issuing any `INSERT INTO operations|tasks|outbox|submission_keys`.

## 4. Verification (actually run)

| # | Command | Result |
|---|---|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-api-keys.test.ts tests/profile-v2-http.test.ts tests/pc-r01-key-mode-fallback.test.ts` | **exit 0** — `Test Suites: 3 passed`, `Tests: 100 passed, 100 total` |
| 2 | same, incl. the three harmonised suites (`woc-profile-groups-backend`, `cb02b-profile-publish-callback`, `wt04-profile-invalid-callback-read`) | **exit 0** — `Tests: 132 passed, 132 total` |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**, no diagnostics |
| 4 | full offline suite (`--config jest.unit.config.cjs`), before vs after | before: 14 failing suites / 67 failing tests **on an already-dirty tree**; after: 18 / 68, of which the 4 extra belong to other lanes' in-flight work — see §5 |

## 5. Residual failures and attribution

The working tree is being edited concurrently by the PC-R03 (retry) and PC-R06 (editor) lanes. I
measured a **baseline before my first edit** and re-measured after, so the delta is attributable:

* **Newly introduced by PC-R01 and fixed here:** the three fixtures in §1 (`woc`, `cb02b`, `wt04`).
  All green.
* **Not mine — no import edge to the files I changed:** `orv12-callback-owner` (retry ordering;
  `retry.ts` was rewritten for PC-R03 and its call ordering changed) and the five retry suites that
  were red in the mid-run are now green again in the latest lane state.
* **Not mine — compile error in another package:** `aweb10-profile-group-v2-state` and
  `aweb10-profile-group-r06-lock-preservation` fail to *build*
  (`apps/admin-web/src/features/profiles/profile-group-state.ts:327: Duplicate identifier
  'requestDefaults'`), which is PC-R06's in-flight editor edit (`packages/**` and `apps/admin-web`
  bans in my dispatch).
* **Pre-existing at baseline, unchanged by this fix:** `br12-isolation-offline`, `crx01`,
  `enc-meta-sentinel-outbox-source-url`, `p730-prof03-invariant1`, `p745-prompt-carrier-producer`,
  `p745-prompt-producer-impl`, `profile-api-keys-membership-offline`,
  `public-upload-encryption-gateway`, `rfx10-seed-gate`, `submission-metadata-crypto-e2e`,
  `url-ingestion-backend-failclosed-offline`, `url-ingestion-offline.functional`,
  `w1-sub02-snapshot-secret`, `w1-sub03-sourceurl-extension`.

## 6. Deviations and judgement calls

1. **`NULL` mode fails closed at admission.** Plan §2 requires it; the migration backfills every key
   with `0070`, so `NULL` only survives in fixtures. This is the deliberate reason four fixtures
   needed harmonising — the fix cannot be "strict in production, lenient in tests" without reopening
   the hole.
2. **`UNMANAGED_LEGACY` with memberships is denied.** The mode and the data contradict each other;
   denying is the only fail-closed reading, and it is asserted explicitly.
3. **The mode read is one extra indexed query per standalone resolution.** Unavoidable: the mode *is*
   the authority, and caching it would reintroduce a stale-authority window on revoke/rotate.
4. **`GROUP_MANAGED` is denied by `selectActiveRow` rather than left to PC-05.** The group resolver
   runs first in every admission path, so this only fires for a direct/legacy call or a stale
   membership; denying is strictly safer than resolving through a child the key no longer owns.
5. **Test-file edits outside the regression suite.** Three fixture harmonisations were required for my
   own change to leave the suite green; each carries a `PC-R01` comment and is listed in §1. If the
   coordinator prefers those to belong to a separate sweep packet, they are separable with no effect
   on the source fix.

## 7. Handoff

**PC-09** — this regression belongs in the verification matrix; the suite is offline and runs under
`jest.unit.config.cjs`, so it needs no DB window.

**PC-04** — the mode is now authoritative at admission; any future issue surface must set `key_mode`
explicitly (the current two already do, and the suite pins it).

**PC-05** — `resolveAdmission` now refuses a `'legacy'` result for anything but an explicit
`UNMANAGED_LEGACY` key. Any new resolver must keep `selectActiveRow` as the single decision point for
standalone keys, or duplicate the rule.

**Real-PG follow-up (not in this lease):** the dispatch's real-PG concurrency gate is PC-09's harness
(`profile-resolution-pg.test.ts` / the drill). This fix is source + offline regression evidence only.

## 8. Evidence boundary

Source and offline unit-test evidence. No built image, no running container, no live database. The
`0070` migration is still not applied to the project dev database; the scratch-PG suites remain the
only PostgreSQL evidence in this lane.

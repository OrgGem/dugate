# ENCMETA-ENC09-KIND — `result_ref` registered in the ENC-09 inventory + PG-backed store — 2026-10-05

**Packet:** `coordination/dispatch-specs/2026-10-05-0305-WAVE-801.md` §4 (lane qwen_1, task `task_7901486104c7`).
**Baseline:** `coordination/reports/encmeta-backfill-prep-2026-10-05.md`.
**Mode:** offline; fake PG only, no live DB; no commit/push/tick.
**Lease:** `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts` + new tests.
**No-touch honoured:** `modules/runtime/runtime.ts` and `http/routes/*` were NOT edited.

## 0. TL;DR

- `operations.result_ref` and `tasks.result_ref` are now **`ENC09_PAYLOAD_KINDS`** members, so they stop reporting as uncovered scope. The kind string is identical to the METADATA_SLOTS slot name, so `slot === kind` by construction.
- A **PG-backed store** (`ResultRefPgMigrationStore`) + a **codec** (`ResultRefPayloadCodec`) drive the existing inventory → lock/CAS → seal → verify-readback → commit flow against the real `Db` surface. The store also refuses to run once its bounded window closes.
- **14 new tests** (`encmeta-enc09-kind.test.ts`) + the existing suite still green: **23/23, 3× literal exit 0**.
- **Two real bugs were caught while building the fake** (§4) — a wrong-column JOIN in the generated SQL, and a composite `refId` that would have sealed envelopes **no runtime reader could open**.
- **Mutation probe:** composite-refId → 5 RED; window guard disabled → 1 RED. Both reverted; files grep-clean.

## 1. Deliverable

| File | numstat vs HEAD | Notes |
|---|---|---|
| `src/modules/encryption/legacy-payload-migration.ts` | **+328 / -0** | 2 kinds + the new section + the `Db` type import |
| `tests/legacy-payload-migration.test.ts` | **+1 / -1** | **Δ-DEVIATION** — see §6 |
| `tests/encmeta-enc09-kind.test.ts` | new | the packet's new test file |

sha256: migration `EF16354D0988864A663AFF144E2B9972354032D8F7C883AFC55AF9D5A35DD32E`; new test `FD433AF09AC863BE599B684080243FC1D17A8DF1504AF060744707A121D4061F`.

## 2. Registration

`ENC09_PAYLOAD_KINDS` gains `'operations.result_ref'` and `'tasks.result_ref'`. Exported alongside:

- `RESULT_REF_PAYLOAD_KINDS` (the pair, in order) and `isResultRefPayloadKind`.
- The kind string is deliberately the SAME string as the `METADATA_SLOTS` slot, so the AAD a reader opens under and the kind the store seals under cannot drift. That is the whole point of registering them rather than lumping them under `control_metadata`.

## 3. Store + codec

### 3.1 `ResultRefPayloadCodec`

Bridges the byte-oriented `PayloadMigrationCodec` onto the metadata seal seam: the ref string's UTF-8 bytes are sealed, and the resulting `SealedMetadata` object rides in `EncryptedPayloadEnvelope.ciphertext`. The sealer is declared **structurally** (`ResultRefSealer`) so `modules/encryption` does not import `modules/runtime`; the real `MetadataCrypto` satisfies it because `ResultRefPayloadKind` is a subset of `MetadataSlot`.

### 3.2 `ResultRefPgMigrationStore`

Implements `PayloadMigrationStore` over the real `Db`:

- **identity**: `payloadId = "<kind>:<rowId>"`, so `withPayloadLocked` knows which table to lock without a second argument;
- **lock**: `SELECT ... FOR UPDATE` inside one `db.tx`; `tasks` uses `FOR UPDATE OF t` with `JOIN operations`;
- **CAS commit**: `UPDATE ... WHERE id=$1 AND updated_at=$3` — a row that moved under us yields 0 rows → `MIGRATION_COMMIT_CONFLICT`, never a blind overwrite;
- **restore**: `UPDATE ... WHERE id=$1 AND result_ref=$3` — only rewrites a row that still holds the sealed value;
- **window**: an optional `BoundedDualReadWindow`; `withPayloadLocked` refuses to start once it closes, so a resumed run cannot mutate rows after the 14-day ENC-09 window expires.

## 4. Two real bugs caught before shipping

### 4.1 `t.tenant_id` does not exist

`tasks` has **no `tenant_id` column** (0001_platform_v1.sql:66-89). The first cut of the SQL generator substituted `{alias}.tenant_id`, producing `t.tenant_id` for the tasks family — a runtime `column does not exist`. Fixed with a separate `{tenant}` placeholder that always resolves to `o.tenant_id` (the joined operations row).

### 4.2 Composite `refId` would have sealed unreadable envelopes

The framework feeds `LockedLegacyPayload.payloadId` straight into the crypto context as `refId`. The first cut set it to the **composite** address (`"<kind>:<rowId>"`), so a freshly sealed row was bound to `refId = "operations.result_ref:<uuid>"` while the runtime writer and readers bind on the **row id**. Result: the backfill's own `inventory` could not re-open its own output (`unresolvedPayloads` = 2, `state` = `incomplete`), and every reader would have failed on those rows.

Fixed by returning `payloadId: row.id` from `toLockedPayload` while keeping the composite only as the `withPayloadLocked` address. The test `backfill seals BOTH columns under the exact reader context and round-trips` is the guard, and it is exactly what goes RED under mutation 1.

> Note: `inventory()` and `toLockedPayload` open sealed rows to populate `plaintext` / `expectedSizeBytes` / `expectedSha256`. Unlike the S3 families, this column keeps NO separate plaintext copy, so the framework's encrypted-path integrity check and `restoreLegacyPayload` both need that open. The legacy bytes are still retained — encrypted rather than duplicated.

## 5. Literal results

| Run | Tests | Exit Code |
|---|---|---|
| new + existing suite ×1 | 23 passed | **0** |
| ×2 | 23 passed | **0** |
| ×3 | 23 passed | **0** |
| regression (4 suites incl. the result-ref detector) | 39 passed | **0** |
| `npx tsc --noEmit` | 0 errors | **0** |

Regression set = `encmeta-enc09-kind` + `legacy-payload-migration` + `enc-meta-sentinel-runtime-refs` + `encmeta-resultref-offline.functional`.

## 6. Δ-DEVIATION — one line in a test outside the stated lease

Adding kinds to `ENC09_PAYLOAD_KINDS` necessarily changes the inventory's coverage arithmetic, and the existing `tests/legacy-payload-migration.test.ts` asserts `coveredKinds).toEqual(ENC09_PAYLOAD_KINDS)` and `uncoveredKinds).toEqual([])`. Its scanner's `covers` list therefore had to gain the two new kinds or the suite would go RED.

That is a **+1/-1 edit to a file the lease did not name** (`tests/legacy-payload-migration.test.ts`). It is the minimum needed to keep the module's own suite green; without it this packet would ship a red suite. Flagged here for ratify-or-revert, exactly like cc_1's Δ-LEASE in the result-ref packet.

## 7. Mutation probe

| # | Mutation | RED | Proves |
|---|---|---|---|
| 1 | `payloadId` back to the composite address | 5 | the reader-context round-trip guard is load-bearing; reproduces the exact §4.2 failure (`state: incomplete`) |
| 3 | `assertWindowOpen` short-circuited | 1 | the closed-window refusal is load-bearing |

Both reverted. `grep MUTATION` over the migration source and both test files returns no matches. Final state re-verified 23/23 ×3 and tsc 0.

## 8. What this packet does NOT do

- **No live DB.** The store is exercised against a fake pg; the SQL shapes are asserted by the fake's dispatch, not by a real planner.
- **No wiring.** The store/codec are provided but nothing calls them yet — the backfill job entry point (CLI/runbook) is the next packet, per the prep receipt §2.1.
- **The window switch itself is still absent** (the prep receipt's BLOCKER): `openMetadata` still hardcodes `allowPlaintext = true`. The store honours a window if one is supplied; nothing supplies one yet.
- The fake does not model transaction rollback; the zero-partial-write property is demonstrated via the CAS (a refused commit leaves the row byte-identical).

READ-ONLY compliance: `runtime.ts` / `http/routes/*` untouched; no commit/push/tick; the only files written are the three above plus this receipt.
# RFX-MULTIPART — RFX-03 (public multipart plaintext bypass) + RFX-07 (part overwrite)

- **Date:** 2026-10-02. **Mode:** implementation. **No gate ticked. No commit.**
- **File lease honoured.** Three files, all inside it:
  - `services/orchestrator/src/modules/artifacts/multipart-service.ts` — the only production file changed (**+95 / −4**).
  - `services/orchestrator/tests/fixtures/multipart-offline-harness.ts` — the task's own test helper, changed because it had to stop mirroring the old bug (**+13 / −2**).
  - `services/orchestrator/tests/multipart-service-offline.test.ts` (**+170 / −3**).
- **Not touched by me:** `artifacts/integrity-scanner.ts` and `artifacts/storage-migration.ts` show as modified in the shared tree — those are other lanes'. `server.ts`, contracts, gates, `tasks/*.md`, `AGENTS.md` untouched. No message to `nocobase-10`.

## 1. RFX-07 — one declaration per part number

### The finding the ticket asked for: why `lockSessionTenant` did not prevent it

**The lock was there, and it did block.** Both grant paths already take `SELECT ... FOR UPDATE` on the session row inside the same transaction — runtime at `grantPart` via `lockSession`, public at `publicGrantPart` via `lockSessionTenant` (`lockSessionTenant` itself is `… FOR UPDATE` at the top of the function). Two concurrent grants for the same part were therefore **serialised**, not interleaved.

**Blocking is not comparing.** Once the losing grant held the lock it called `insertPartDeclaration`, which was `ON CONFLICT … DO UPDATE SET declared_sha256 = EXCLUDED.declared_sha256` — it overwrote the winner's promise without ever looking at it. The lock decided *order*; nothing decided *whether the two grants agreed*. That is the whole defect.

### The fix

`insertPartDeclaration` now does `ON CONFLICT … DO NOTHING RETURNING part_number`, and on a conflict reads the existing row back and compares:

- **same hash + same size** → the same grant asked twice → **replay, succeeds**;
- **different hash or size** → **409 `PART_CONFLICT`** naming the part;
- **row vanished between the two statements** → also `PART_CONFLICT`, never a silent re-insert (re-inserting would resurrect a declaration nobody agreed to any more).

Applied to **both** branches, because both call the same function.

### The harness had to change too, and why that is not cosmetic

The fake modelled the OLD statement: `INSERT INTO ARTIFACT_MULTIPART_PARTS` overwrote the ledger unconditionally and returned `rowCount: 0`. Against the new code that fake would have made every grant take the conflict path, and the read-back `SELECT` would have hit the harness's `unhandled ledger SQL` guard. So the harness now models `DO NOTHING RETURNING` faithfully — a second grant returns no row and leaves the ledger alone — plus the new read-back `SELECT`.

**This is worth stating plainly: the fake mirrored the bug.** A test double that copies the production statement's behaviour cannot catch a defect in that statement.

## 2. RFX-03 — public multipart is refused while encryption is required

### Direction taken: refuse, not seal

The packet's chosen (conservative, reversible) direction: when this deployment requires encryption, `publicInit` / `publicGrantPart` / `publicComplete` are **refused with `501 PUBLIC_MULTIPART_UNAVAILABLE`** before any side effect. No second write path with different encryption semantics is introduced.

- `publicInit` refuses **before** schema parse, session row and provider upload — the test asserts `artifacts.size === 0` and `storage.createCalls.length === 0`.
- `publicGrantPart` refuses before any presign — the test asserts `presignCalls` did not grow.
- `publicComplete` refuses before publishing — the test asserts the row is still `STAGING`.

### Two design decisions worth flagging

**(a) The predicate is `encryptionIsRequired` — the SAME function boot uses — not a copy.** It is imported from `modules/encryption/boot-options` and called with `process.env`. `boot-options.ts` itself carries the scar that justifies this: *"the two copies drifted once already, which silently dropped the metadata block while validation still demanded its key ref"*. A second copy of that decision inside the multipart service is exactly how that happens again.

This also kept the change **inside the lease** — no wiring in `server.ts` was needed, so no escalation was required.

**(b) A malformed flag is read as REQUIRED.** `readBoolean` throws on anything but `true`/`false`, and `encryptionIsRequired` therefore throws on a typo. The guard catches that and treats it as *encryption required*. A typo in the encryption surface must never be the reason the plaintext path opens. There is a test pinning exactly this (`DU_ENCRYPTION_METADATA_ENABLED=yes` → refused).

**(c) `publicAbort` is deliberately NOT guarded.** Aborting deletes bytes and releases a provider upload; it is cleanup, not a write. Refusing it would strand sessions that were opened before encryption was turned on, leaving orphaned multipart uploads and billable storage. The three methods the packet named are guarded; abort is not, and that asymmetry is deliberate.

## 3. One existing test asserted the bug

`re-granting a part replaces the declared hash` asserted exactly the behaviour RFX-07 calls a defect. It was rewritten, not deleted — the name and intent were replaced with three cases:

| Case | Asserts |
|---|---|
| re-grant with a **different** hash | 409 `PART_CONFLICT`; ledger still holds the first hash; **only one presign** (no URL minted for the loser) |
| re-grant with the **same** hash | both succeed; ledger unchanged; two presigns |
| `complete` after a refused grant | verifies the **winner's** hash and commits (`committed: true, replayed: false`) |

The matching pair was added for the public branch as well (different hash → `PART_CONFLICT`; same hash → replay).

## 4. Verification (literal)

| Command (cwd = `du-rework/services/orchestrator`) | Result |
|---|---|
| `npx jest tests/multipart-service-offline.test.ts` | **61 passed / 61 total**, exit 0 (was 52 total with 1 red) |
| `npx jest tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts tests/encryption-boot-options.test.ts tests/data-02-04-live-s3.test.ts` | **3 suites passed / 1 skipped; 123 passed, 5 skipped, 128 total**, 0 red |
| `npx tsc --noEmit` | **exit 0** |

Test count **52 → 61**: one stale case replaced by three (+2), plus 2 public-branch and 5 RFX-03 cases (+7). Nothing was deleted; no assertion was weakened.

### Live S3 evidence — GAP, stated rather than papered over

**There is none.** `tests/data-02-04-live-s3.test.ts` gates its whole body behind `DU_LIVE_INFRA === '1'` (`liveDescribe`, line 39) and reported **skipped** here. `infra/docker-compose.yml` defines only postgres and redis — there is no MinIO/S3 service, so the pilot bucket is unreachable from this machine.

So the acceptance leg *"S3 byte-scan does not see a plaintext sentinel"* is **unproven and unprovable here**. What IS proven is the property that makes the gap harmless: the plaintext write path is **refused before any presigned URL exists**, so there are no plaintext bytes for a byte-scan to miss. Closing the gap needs the Tester window (`DU_LIVE_INFRA=1` + a MinIO service + a bucket + credentials).

### No regression risk to the live suite from the new guard

Checked rather than assumed: `data-02-04-live-s3.test.ts` builds `createMultipartService` **only** to call `sweepExpiredSessions` (line 594). It never drives `publicInit`/`publicGrantPart`, and it does not set `ARTIFACT_STORAGE_BACKEND`, so `encryptionIsRequired` is false in that process and the guard is open.

## 5. Follow-up decisions (recorded, NOT attempted)

- **RFX-03 variant (b) — server-side seal.** Route public multipart through the encryption gateway so it survives on an encrypted deployment: seal on complete, write manifest + marker, then publish. Not attempted here; the fail-closed refusal is deliberately the reversible step. **This is the coordinator's call.**
- **`publicAbort` asymmetry** — if the owner wants abort refused too, that is a one-line change, but it reintroduces the stranded-session problem described in §2(c).
- **`PART_CONFLICT` as a new wire code.** `conflict()` takes a free-form string and nothing pins the code union, but if a contract owner enumerates admin/multipart problem codes, `PART_CONFLICT` should be added there — that file is outside this lease.

## 6. Not done

- Full `services/orchestrator` suite was **not** run: the shared checkout has several lanes mid-edit (CONV-10 rewrote render tests, another lane owns `integrity-scanner.ts` / `storage-migration.ts`), so an aggregate number would not be attributable. Focused suites plus `tsc` are the claim here.
- No live window, no DB, no S3.
- No gate ticked, no commit.

## RESUME POINT

- **RFX-MULTIPART closed 2026-10-02.** RFX-03 and RFX-07 both landed, offline-verified.
- **RFX-07 finding to carry forward:** the session `FOR UPDATE` lock was present and working in both grant paths — the gap was the absence of a comparison, not the absence of a lock. Any future "why did the lock not help" question in this area should start there.
- **RFX-03 follow-up:** the server-side-seal variant is unstarted and is a real decision (it is the only way public multipart can exist on an encrypted deployment).
- **Reproduce:** `cd du-rework/services/orchestrator && npx jest tests/multipart-service-offline.test.ts` → 61/61, exit 0.

# RCR-RUNTIME — lease release + reconnaissance handoff to native Luna — 2026-10-05

**Packet:** RCR-RUNTIME (RCR-02 + RCR-04 + RCR-05) · lane **dsh_1** (`term_a85c47f2`) · task `task_fa1463127729` · dispatch `ctx_505e2ce3892b`.
**Mode:** **Offline; không tick; không commit/push.**
**Status: RELEASED — 0 product edits.** The user-owned RCR steering (02:56, relayed as `msg_575b3050b416` / `msg_85155f71f712`) supersedes the earlier finish-then-release request: pause **before** product edits and release the runtime/source/migration lease to native `rcr_runtime_luna`.

## 0. Write set — EMPTY

No product source, contract, migration, or test file was created or modified by dsh_1 for this packet. There is **no partial edit and nothing to unwind**: all dsh_1 activity was read-only reconnaissance (the anchors in §2 were verified against the file contents, not applied). `runtime.ts` therefore still carries its pre-packet hash, matching the review snapshot.

**Released scope (dsh_1 no longer writes any of these):**

| Path | Holder after release |
|---|---|
| `services/orchestrator/src/modules/runtime/runtime.ts` | native Luna |
| `services/orchestrator/src/http/routes/runtime.ts` | native Luna |
| `services/orchestrator/src/modules/runtime/metadata-crypto.ts` (new slot) | native Luna |
| `services/orchestrator/migrations/0032_*.sql` (unallocated) | native Luna |
| runtime tests (own additions) | native Luna |

The only artifact dsh_1 wrote for this packet is this receipt.

## 1. Hash pin at release (verify-before-edit)

| File | SHA-256 (24) | Bytes | mtime | Note |
|---|---|---|---|---|
| `src/modules/runtime/runtime.ts` | `01ffff43cfd528e029c5d510` | 92094 | 10-05 01:25:57 | unchanged since the review snapshot; no dsh_1 edit |
| `src/http/routes/runtime.ts` | `ee76d9917eea237ce1168540` | 24263 | 10-03 01:48:37 | no dsh_1 edit |
| `src/modules/runtime/metadata-crypto.ts` | `3e6ee2a76c8d682e40f0d015` | 14464 | 10-05 01:51:11 | **not written by dsh_1** — mtime predates this packet; coordinate the new slot with its owner before adding |
| `tests/rcr-luna-verification.test.ts` | `66c728905192410d53b3678a` | 17009 | 10-05 02:54:30 | native Luna's file, being actively extended; **untouched by dsh_1** (and will stay untouched) |

All four pins re-hashed after the release reply were identical except `tests/rcr-luna-verification.test.ts`, which moved `66c728905192410d53b3678a` → `1705ce88fc9f79012ab3cf95` — that is native Luna extending its own harness, not a dsh_1 write. `migrations/0032_*.sql` is still absent, so the number remains free.
| `tests/runtime-lease-fencing-offline.test.ts` | `5cd40ad6a3a994a6558a90e2` | 25164 | 09-26 11:54:55 | existing offline harness; no dsh_1 edit |

Migration tail at release: `0031_prompt_overrides_ref.sql` ⇒ **`0032` is unallocated** (no concurrent allocation observed at 02:54).

## 2. Reconnaissance preserved (anchors re-verified post-steering)

### RCR-02 — spawn/wait accept an expired lease
- `spawnChildren` `runtime.ts:949-967` locks the task but selects **no** `lease_expires_at`/`lease_active` and no business column. `:968-970` terminal ⇒ `gone`; `:971` epoch ⇒ `LEASE_LOST`; `:987-1010` durable-child replay (**must stay before the live-lease gate** — it is the intentional retry-after-transition path); `:1011-1016` partial overlap ⇒ `STATE_CONFLICT`; `:1017-1019` `state !== 'RUNNING'` ⇒ `STATE_CONFLICT`; `:1058-1102` child + dependency + outbox inserts; `:1110-1113` **unconditional** `UPDATE tasks ... WHERE id=$1` with rowCount ignored — this is the write that must become a DB-clock CAS; `:1114-1118` operations update.
- `waitInput` `runtime.ts:1186-1195` same gap; `:1210-1219` durable replay before the RUNNING gate; `:1220-1222` `state !== 'RUNNING'` ⇒ `STATE_CONFLICT`; `:1235-1242` `human_waits` insert; `:1256` **unconditional** `UPDATE tasks SET state='WAITING_INPUT'` — same CAS requirement; `:1257-1261` operations update.
- Reference pattern to mirror: `saveStep` `:664-674` (SELECT carries `(t.lease_expires_at > clock_timestamp()) AS lease_active`, then `assertTaskBusiness` → `assertLeaseEpoch` → `assertActiveLease`) and its write-side fence `:704-712`. Helpers: `assertActiveLease` `:171-178` (terminal ⇒ 410 `TASK_TERMINAL`; else 409 `LEASE_LOST`), `assertTaskBusiness` `:161-165` (403 `PERMISSION_DENIED`).
- Route plumbing: `http/routes/runtime.ts:451-453` (spawn) and `:471-473` (wait-input) **discard** the `workerBusinessId` returned by `assertTaskRuntimeAuth` `:38-48`; heartbeat `:400-402`, saveStep `:411-412`, complete `:431-432`, fail `:441-442` all pass it. Convention to follow: optional third `workerBusinessId`.
- Round-2 requirement: the read-side gate must fire **before any INSERT** (the expired case in Luna's harness asserts zero attempted writes), while the final task-transition CAS closes expiry *between* read and write, and its zero-row result must throw `LEASE_LOST` inside the same tx so every earlier child/outbox/wait row rolls back.

### RCR-04 — SaveStep contract default bypassed
- `runtime.ts:657-662` is a handwritten body type with no `status` default guarantee; `:663` opens the tx immediately; nothing parses the body. Omission therefore reaches `$6` as `undefined` ⇒ `step_checkpoints.status` NOT NULL violation (500). Contract already declares the default: `packages/contracts/src/runtime.ts:170-176`.
- Required shape per steering: `SaveStepRequestSchema.safeParse` at the **service** boundary *before* `db.tx`, `zodIssuesToProblem` ⇒ 422 `INVALID_SCHEMA` with zero SQL, and only `parsed.data` used downstream. Route `:412` currently passes `ctx.body as never`.

### RCR-05 — `sessionRef` dropped at persistence and readback
- `step_checkpoints` (`migrations/0001_platform_v1.sql:102-111`) has **no** `session_ref` column; PK is `(task_id, step_key, generation)`. Insert `:702-709` names only `output_ref`/`status`; claim select `:1817` omits it; projection `:1824-1840` omits it.
- `metadata-crypto.ts:44-61` `METADATA_SLOTS` has no `step_checkpoints.session_ref`. The existing `output_ref` seal binds AAD `refId = `${taskId}:${stepKey}`` (`:699`) — **generation-free**, so a stronger binding cannot simply be copied: the new slot must bind the full checkpoint identity `${taskId}:${stepKey}:${generation}`, sealing before insert and opening at claim under tenant/slot/row context, null/omitted compatible, fail-closed when an envelope cannot be opened.

### Acceptance harness observed (read-only, not modified)
`tests/rcr-luna-verification.test.ts` expects: expired+current-epoch ⇒ 409 `LEASE_LOST` with `attemptedWrites === []`; stale epoch ⇒ 409 `LEASE_LOST` and foreign business ⇒ 403 `PERMISSION_DENIED`, both writes-free; mid-tx expiry (`expireOnStateTransition`) ⇒ 409 with `attemptedWrites.length > 0`, a SQL containing `lease_expires_at > clock_timestamp()`, `committedWrites === []` and rollback 1; fully durable identical child replay **after** expiry ⇒ success. Both services are invoked with an optional third `workerBusinessId`.

## 3. Residuals — explicitly NOT in this packet

1. Claim select has **no `ORDER BY`** (`:1817`): with several generations per `step_key`, the SDK's `peek` may pick a non-latest row. Contract-dependent (latest-generation ordering) — flagged for Luna/verifier alignment, not an implicit scope expansion.
2. Replacing the `state !== 'RUNNING'` ⇒ `STATE_CONFLICT` branch with the live-lease gate changes the status of that path (`LEASE_LOST`); reconcile with the live-guarded `runtime.test.ts` fan-out/human-wait expectations.
3. `output_ref` AAD omits `generation`; the weaker historical binding is left as-is (no backfill), and must not be copied to `session_ref`.
4. `metadata-crypto.ts` was last written by another writer (10-05 01:51:11, before this packet) — the additive slot needs that owner's confirmation.
5. Route-level `workerBusinessId` plumbing for spawn/wait-input plus the RCR-04 route cast.

## 4. Method and limits

- Offline, read-only: no product/contract/migration/test write, no DB/Redis/S3/Vault, no live run, no tick, no commit/push.
- No test/lint/build was executed for this packet because there is no dsh_1 change to exercise; the pins in §1 are the state Luna inherits.
- dsh_1 stands down from runtime product writes; no further source claim is held. Leases/marks are for the coordinator to reconcile.

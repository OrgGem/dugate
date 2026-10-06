# ENCMETA-WINDOW-DESIGN — allowPlaintext policy, window wiring, flip gate — 2026-10-05

**Packet:** ENCMETA-WINDOW-DESIGN-803 (the A3 blocker; first receipt).
**Mode:** DOC-ONLY. 0 source edits, 0 commits, 0 ticks.
**State reflect = the tree as of this packet** — BA-01, BA-02, BA-04, BA-05 and A17 are all FIXED and VERIFIED; this document does not restate the pre-fix plan.

## 0. Why this document exists

Six readers currently hard-code `allowPlaintext = true`. There is no single switch, no owner of the decision, and no rung between "window forever open" and "flip every call site at once". A3 needs that missing: a policy object built once at boot, injected everywhere, and a user-gated flip to fail-closed.

## 1. Reuse what exists — do not rewrite (item 1)

`modules/encryption/legacy-payload-migration.ts:496-535` already ships the exact primitives. The window design is a consumer of them, not a competitor:

| Symbol | Location | Behaviour to REUSE |
|---|---|---|
| `MAX_DUAL_READ_WINDOW_MS` | `legacy-payload-migration.ts:21` | `14 * 24 * 60 * 60 * 1000` — the hard cap |
| `BoundedDualReadWindow` | `:496` | `startsAtMs` / `expiresAtMs` / `allowsLegacyRead(nowMs?)` |
| `createBoundedDualReadWindow(startsAt, expiresAt)` | `:502` | throws unless positive, `expiresAt > startsAt`, and span `<= 14 days` |
| `readDuringBoundedDualRead({value, isEncrypted, readEncrypted, readLegacy, window, nowMs})` | `:525` | **this is the dispatcher** — encrypted always goes to `readEncrypted`; legacy only inside the window, else throws |
| `canRetireLegacyPayloads(inventory, backupSignedOff)` | `:494` | `backupSignedOff && unresolvedReferences === 0` |

> **Rule:** the new `MetadataReader` is a thin adapter over `readDuringBoundedDualRead` plus the `readStored`/`readStoredText` pair. **Do not add a fourth window primitive.** The window's own 14-day assertion already makes an over-long window impossible to construct.

## 2. The control plane today — six literal `true` (item 2)

Every reader passes a **literal** `allowPlaintext` today. Nothing is shared, nothing is injectable, and the mode is invisible at boot:

| # | Site | Purpose | Current literal |
|---|---|---|---|
| 1 | `runtime.ts:481` `openMetadata` string branch | checkpoint / result_ref TEXT | `true` |
| 2 | `runtime.ts:483` `openMetadata` object branch | jsonb slots | `true` |
| 3 | `runtime.ts:1232` `getChildren` | child `tasks.result_ref` | `true` |
| 4 | `runtime.ts:1844` `reconcileParentJoin` | sibling `tasks.result_ref` | `true` |
| 5 | `http/routes/public.ts:538` | `GET /operations/:id/result` | `true` |
| 6 | `operations/mappers.ts:103` | operation view mapping | `true` |

**Two sites are deliberately `false` and must NOT be governed by the policy** (they are not "windowed legacy reads" at all):

| Site | Why always `false` |
|---|---|
| `runtime.ts:358` prompt-overrides carrier | a fail-closed carrier read with its own no-seam guard (`:356`) |
| `metadata-auth-counter.ts` | the A11 gate — it must fail closed to be a gate at all |

### 2.1 Proposed shape

**One closed enum, one policy built at boot, one reader facade.** New file `modules/encryption/metadata-read-policy.ts`:

```ts
export const METADATA_PLAINTEXT_READ_MODE = ['window', 'forbid'] as const;
export type MetadataPlaintextReadMode = (typeof METADATA_PLAINTEXT_READ_MODE)[number];

export interface MetadataReadPolicy {
  readonly mode: MetadataPlaintextReadMode;
  readonly window: BoundedDualReadWindow | null;   // null when mode === 'forbid'
  readonly startedAtMs: number;
  allowPlaintext(nowMs?: number): boolean;
}

export function createMetadataReadPolicy(
  mode: MetadataPlaintextReadMode,
  window: BoundedDualReadWindow | null,
): MetadataReadPolicy

export interface MetadataReader {
  readStored(value: unknown, context: MetadataContext): Promise<unknown>;
  readStoredText(value: unknown, context: MetadataContext): Promise<string | undefined>;
}
export function createMetadataReader(crypto: MetadataCrypto | undefined, policy: MetadataReadPolicy): MetadataReader
```

- The enum is **closed** (two members). No free-form string, no `allowPlaintext` boolean to typo. An unknown env value is a boot error, not a silent `true`.
- `allowPlaintext()` derives from `mode` + `window`: `forbid` → always `false`; `window` → `window.allowsLegacyRead(nowMs)`.
- `createMetadataReadPolicy` throws if `mode === 'window'` with no window, or a window with mode `forbid` — the pair is incoherent at construction, not at read time.
- `createMetadataReader` composes `readDuringBoundedDualRead`: sealed → the normal decoder; plaintext → allowed only while `policy.allowPlaintext()`; otherwise the read throws `NOT_SEALED`.

### 2.2 Injection

Build it **once** next to `metadataCrypto` in `create-app.ts:302-306`, then thread `policy`/`reader` into:

`createRuntimeService` · `createSubmissionService` · the route context (`http/route-context.ts`) · `operations/mappers.ts` · `operations/ingestion-consumer.ts`.

`metadata-auth-counter.ts` and `runtime.ts:358` are **excluded** — they keep their own `false`.

## 3. Wiring `backfillLegacyPayloads` into production (item 3)

ENCMETA-ENC09-KIND already delivered `ResultRefPgMigrationStore` (implements `PayloadMigrationStore` over the real `Db`, lock/CAS on `updated_at`, window-aware) and `ResultRefPayloadCodec` (byte ⇄ metadata seam). What is missing is the entry point.

**Plan:** a dedicated CLI, `src/backfill-metadata-cli.ts`, invoked as `npm run backfill:metadata`:

1. `createDb(DATABASE_URL)`; build the same seam as `create-app.ts:302-306`.
2. Build `new ResultRefPgMigrationStore({ db, sealer, window })` and `new ResultRefPayloadCodec(sealer)`.
3. `const before = await inventoryPlaintextPayloads([...])` — baseline counts, count-only, never the value.
4. `const result = await backfillLegacyPayloads(store, codec)`.
5. Re-inventory → `after`.
6. Exit non-zero unless `after.unresolvedReferences === 0` **and** `canRetireLegacyPayloads(after, backupSignedOff === true)`.

Guard rails, mirroring `migrate-cli.ts`: explicit operator opt-in (no boot-time auto-run), `DATABASE_URL` required, `ON_ERROR_STOP`-equivalent semantics — a failed row is reported in `result.issues` and keeps `state === 'incomplete'` rather than aborting the batch (so the run is resumable and idempotent).

> **Scope note:** `ResultRefPgMigrationStore` currently serves the two `result_ref` slots. The other six `METADATA_SLOTS` are `jsonb`-backed and follow the same interface; extending `slotSql` is a follow-on, not part of the first production run.

## 4. Zero unresolved + fail-closed flip (item 4)

Two independent conditions, both mandatory:

**(a) Inventory zero.** `canRetireLegacyPayloads(inventory, backupSignedOff)` — `unresolvedReferences === 0` AND backup signed off. This is the ENC-09 retirement gate and it already exists.

**(b) Authenticated zero.** `countUnsealedWithAuth({ db, crypto })` — `blockers === 0` and `gate === 'PASS'` across **all eight** `METADATA_SLOTS` (BA-05's `assertFullCoverage` rejects a subset, so a PASS is meaningful). `blockers = plaintext + sealedBrokenAuth + sealedBrokenContext + sealedBrokenOther`. This is the A11 gate: it distinguishes a sealed envelope from a broken one, which the shape predicate could not.

**Fail-closed on flip:** set `METADATA_PLAINTEXT_READ_MODE=forbid` and restart. From that boot the six readers pass `allowPlaintext: false`, so any residual plaintext raises `NOT_SEALED` instead of being served. **Sealed rows are unaffected** — they take the normal decoder in both modes.

> The flip is a **boot config change**, not a runtime toggle. That is deliberate: there is no half-flipped state across six call sites, and a restart makes the new mode visible in logs and metrics.

## 5. Metrics and the window-closing condition, user-gated (item 5)

**Metrics emitted by `MetadataReader`:**

| Metric | Signals |
|---|---|
| `metadata_read.sealed_total` | work proceeding as intended |
| `metadata_read.plaintext_total` | how much legacy still surfaces (should trend to 0) |
| `metadata_read.blocked_total` | `NOT_SEALED` after the flip — **page on non-zero** |
| `metadata_read.mode` (gauge) | current mode + window start/expiry |
| `backfill.migrated` / `.verified` / `.failed` / `.unresolved` | per-slot progress |
| `backfill.state` | `complete` / `incomplete` |

**Window-closing condition — two ways:**

1. **Expiry.** `createBoundedDualReadWindow` caps any window at 14 days, so the window cannot silently outlive its purpose. After `expiresAtMs`, `allowsLegacyRead` is `false` and the reader fails closed **without a config change** — expiry is the automatic backstop.
2. **The flip.** `METADATA_PLAINTEXT_READ_MODE=forbid` closes it on demand.

**User-gated (required):** neither path is automatic. **Both** require an explicit operator action — an env change plus a restart, recorded in the deployment log and tied to the agreed window. The system must never self-flip to `forbid` on a schedule or a signal: a premature flip converts a working deployment into one where every legacy read throws, and only a human can weigh that against backfill progress.

**Abort conditions for the window:** backfill not complete, `unresolvedReferences > 0`, `blockers > 0`, no signed backup, or the operator has not approved the window. Any of these keeps the mode at `window`.

## 6. Implement-ready checklist (item 6)

| # | Work | Files to change | Lease |
|---|---|---|---|
| 1 | Add `METADATA_PLAINTEXT_READ_MODE`, `MetadataReadPolicy`, `createMetadataReadPolicy`, `MetadataReader`, `createMetadataReader` | **new** `src/modules/encryption/metadata-read-policy.ts` | own |
| 2 | Read the env, build the policy once, fail on an unknown mode | `src/modules/encryption/boot-options.ts` (add the mode const), `src/app/bootstrap/create-app.ts` | needs a grant |
| 3 | Inject `reader` into the runtime + submission services | `src/modules/runtime/runtime.ts`, `src/modules/operations/submission.ts` | needs a grant |
| 4 | Replace the 4 literal `true` sites with the injected reader | `runtime.ts:481,483,1232,1844` | needs a grant |
| 5 | Replace the 2 literal `true` sites in HTTP | `http/routes/public.ts:538`, `operations/mappers.ts:103` | needs a grant |
| 6 | Thread `reader` through the route context | `src/http/route-context.ts` | needs a grant |
| 7 | Production backfill CLI | **new** `src/backfill-metadata-cli.ts` + `package.json` script | own |
| 8 | Wire the remaining 6 jsonb slots into `ResultRefPgMigrationStore` | `src/modules/encryption/metadata-auth-counter.ts`? **no** — `legacy-payload-migration.ts` store module | needs a grant |
| 9 | Unit tests: enum closed, policy construction rejects incoherent pairs, `allowPlaintext()` truth table for `window`/`forbid`/expired, reader follows `readDuringBoundedDualRead` | **new** `tests/metadata-read-policy.test.ts` | own |
| 10 | Existing suites stay green | — | — |

**Deliberately untouched by any of the above:** `metadata-auth-counter.ts` (A11), `runtime.ts:358` (prompt-overrides carrier), `legacy-payload-migration.ts` window primitives (item 1 says reuse), all migrations.

## 7. Where things stand (verified now, not planned earlier)

- **BA-01** (TEXT envelope bypassed AEAD) — fixed; `openMetadata` dispatches strings through `readStoredText`.
- **BA-02** (silent `String()` + no-seam raw return) — fixed; `readStoredText` fails closed, and the no-seam rule lives in one shared function.
- **BA-04** (`openDispatchSourceUrl` string bypass) — fixed; plaintext lane vs protected lane split.
- **BA-05** (gate could run on a subset) — fixed; `assertFullCoverage` requires exactly the eight `METADATA_SLOTS`.
- **A17** — fixed and verified.

The window design therefore starts from a *verified* control plane, not the pre-fix one: `allowPlaintext` is now the **only** per-site decision left, which is exactly what §2 turns into one policy.

## 8. Open questions for the coordinator

1. Which of the 10 checklist rows get a grant first — 1, 7, 9 are own-lease and can start immediately.
2. Whether the backfill CLI also runs the other six `METADATA_SLOTS` on first launch (checklist 8) or ships for `result_ref` only.
3. Who signs off the backup for `canRetireLegacyPayloads` — the gate needs `backupSignedOff === true`, and the contract for who sets it is not yet written.

DOC-ONLY compliance: no source file edited; nothing committed; nothing ticked.
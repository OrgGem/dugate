# D5C — doc-compare fan-out concurrency honours the caller's `maxConcurrency`

- **Date:** 2026-10-02. **Mode:** implementation. **No gate ticked. No commit.**
- **Closes** the D5b §4 open item (`runChunkChildren` ignored `SpawnChunkChildren.maxConcurrency`).
- **Scope:** `pipelines/workflows/doc-compare/**` + tests only. `server.ts`, contracts, gates untouched. 31 variants unchanged. No wire change. No message to `nocobase-10`.

## 1. What changed

| File | What |
|---|---|
| `src/pipelines/workflows/doc-compare/doc-compare.ts` | New exported `resolveFanoutConcurrency`; `runChunkChildren` takes an optional 4th param `maxConcurrency` and schedules with it; the old dead expression is gone |
| `src/pipelines/workflows/doc-compare/index.ts` | Re-export `resolveFanoutConcurrency` |
| `tests/p9-03-doc-compare.test.ts` | 2 new tests; 3 existing call sites now pass the fan-out's own ceiling |
| `tests/p9-03-doc-compare-runner.test.ts` | 1 call site threads the ceiling |

The removed expression was `Math.max(1, Math.min(runtime ? MAX_CHUNK_FANOUT_CONCURRENCY : 1, MAX_CHUNK_FANOUT_CONCURRENCY))`, which simplifies to the module cap for every input — including the `runtime` guard, since `runtime.runChunk` is called unconditionally a few lines later. So a caller asking for 1 still had 8 chunks in flight against the provider.

## 2. The ruling, as implemented

- **Caller value is honoured**, clamped into `[1, MAX_CHUNK_FANOUT_CONCURRENCY]` (`MAX_CHUNK_FANOUT_CONCURRENCY = 8`, unchanged, still the hard ceiling). Above the cap is capped, not honoured.
- **Malformed values fail closed toward serial execution:** anything that is not a safe integer at or above 1 resolves to `1`. This mirrors `clampConcurrency` in `normalizeDocCompareInput`, which is the module's existing precedent, so the two clampers cannot disagree.

**Default when the argument is missing — recorded, with the source of truth:**

| Level | Default | Where it is decided |
|---|---|---|
| Workflow input (`maxConcurrency` absent from the task input) | **2** | `normalizeDocCompareInput`: `clampConcurrency(record.maxConcurrency ?? 2)` |
| Manifest contract | optional, `integer`, `minimum: 1`, `maximum: 8` | `document-core.manifest.ts` → `doc-compare` action `inputSchema` (not in `required`) |
| `SpawnChunkChildren.maxConcurrency` | always present | `stageChunkFanout` copies `state.maxConcurrency`, which came from the normalised input |
| Executor helper (`maxConcurrency` argument omitted) | **8** (the hard ceiling) | `resolveFanoutConcurrency(undefined)` |

So the helper's fallback only governs callers that drive the executor directly; every fan-out issued by `advanceDocCompare` already carries an explicit ceiling. This is stated in the function's doc comment so the two defaults are not mistaken for a contradiction.

## 3. Tests

Two new tests, both in the `fan-out executor` block of `p9-03-doc-compare.test.ts`:

1. **`clamps the caller ceiling into [1, the module cap]`** — a table over `resolveFanoutConcurrency` directly: `undefined → 8`, `1 → 1`, `3 → 3`, `8 → 8`, `9 → 8`, `9999 → 8`, and `0 / -1 / -999 / 1.5 / NaN / Infinity → 1`.
2. **`runs no more children at once than the caller asked for`** — this is the one that matters, because it measures **peak concurrent children** rather than a return value. A probe runtime counts in-flight `runChunk` calls against 12 specs: asking 1 gives peak 1, asking 2 gives peak 2, asking 9999 gives peak 8, omitting gives peak 8. A test that only asserted the clamp function would have passed while the scheduler kept ignoring the value.

Existing rules kept intact and still green: the Δ2 `joinToken` requirement (including rejection of `''` and `'   '`), and the handler's chunk-set/token provenance checks.

**Negative control:** I temporarily restored the old `Math.min(runtime ? CAP : 1, CAP)` expression and re-ran the peak-concurrency test — **it went red** (1 failed / 36 skipped). Restored the fix and re-verified `tsc --noEmit` exit 0 before the final runs. The test genuinely witnesses the defect.

## 4. Verification (literal)

| Check | Result |
|---|---|
| 4 doc-compare suites | **72 tests, all green** (D5b was 70 — +2 new) |
| Full document-core | **58 suites / 925 tests: 924 passed + 1 skipped, exit 0** |
| D5b reference point | 923 tests / 922 pass + 1 skip → **+2, exactly the two new tests; no new red** |
| `tsc --noEmit` document-core | **exit 0** |
| `tsc --noEmit` services/orchestrator | **exit 0** |

The single skip is the `p8-03` live-DB test gated on `DU_LIVE_INFRA` by another lane — see D5b §6. Measured there: `DU_LIVE_INFRA=0` → 1 skipped / 6 passed / exit 0; `DU_LIVE_INFRA=1` → 1 failed / 6 passed / exit 1. If that lane's guard is absent when this packet is read, expect `p8-03` to run its live query and go red without Postgres on `:5433`.

## 5. Open / not done

- **Δ1 (still OPEN, connector lane):** `doc_compare_structure` / `doc_compare_references` remain overridable defaults; nothing in `services/connector` registers them.
- **Δ6 (still OPEN):** no live leg. `runChunkChildren` has never executed inside a real queue/worker delivery; the concurrency evidence is a probe runtime under jest.
- **Not done, deliberately:** `handleDocCompare` in `worker.ts` does **not** call `runChunkChildren` — the registered handler delegates each chunk to a spawned child task and reassembles the join itself, so this fix does not change what the registered handler does. It changes the executor used by tests and by any future in-process caller. Flagging so the coordinator does not read this as a production fan-out behaviour change.

## RESUME POINT

- Packet **D5C** closed 2026-10-02. The D5b §4 fan-out-concurrency open item is closed; the `doc-compare/**` lease is released.
- Remaining from the D5 chain: **Δ1** (connector task names, connector lane) and **Δ6** (live leg).
- **Reproduce:** `cd du-rework/businesses/document-core && npx jest` → 58 suites / 925 tests, 924 green + 1 skipped.

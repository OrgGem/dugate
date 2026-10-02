# PERF-01B - bounded ingress concat micro-change

## Change

Applied the proposed one-line change in `services/orchestrator/src/http/ingress.ts:88`:

```diff
- const rawBuffer = Buffer.concat(chunks);
+ const rawBuffer = Buffer.concat(chunks, total);
```

`total` is the streamed byte count maintained at `ingress.ts:64,76-84`; it is supplied to concat only after the request reaches `end` (`:85-88`). Each accepted chunk increments `total` before being retained, and the existing overflow check rejects when `total > limit` (`:76-84`). Thus an empty stream reaches concat with `chunks=[]` and `total=0`, a single chunk gets its exact size, and a body exactly at the configured cap remains accepted; an over-cap body still takes the existing 413 path before the end handler (`:36-38,76-84`). The resulting bytes and downstream binary/JSON handling are unchanged (`:89-102`). No tests or other source files were changed.

## Offline concat benchmark

Ran `node --expose-gc opt-perf-01b-ingress-concat-bench.cjs` three times. Each process takes nine alternating samples per call shape, with 1,500 concatenations per sample and explicit GC between timed groups. The table reports the median of the three process-level medians; ranges show the minimum and maximum of those three medians. `gain` is positive when supplying `total` was faster.

| 64 KiB body shape | Chunks | No-total median (range), ms | With-total median (range), ms | Gain |
|---|---:|---:|---:|---:|
| One 64 KiB chunk | 1 | 40.660 (38.462-48.977) | 38.758 (37.197-43.358) | +4.68% |
| 64 x 1 KiB | 64 | 33.668 (32.060-38.099) | 37.187 (33.481-40.709) | -10.45% |
| Mixed: 32 + 16 + 8 + 8 x 1 KiB | 11 | 33.098 (29.521-37.166) | 33.874 (29.957-37.660) | -2.34% |
| 256 x 256 B | 256 | 34.268 (31.753-37.819) | 33.409 (32.735-38.029) | +2.51% |

The measurement isolates `Buffer.concat` and covers 64 KiB payloads, not the full HTTP request path. Results move in both directions and ranges overlap; this run does not demonstrate a stable performance gain. The benchmark also checks equality for zero chunks, one chunk, split chunks, and an exact 1 MiB body (the default JSON cap) before timing.

## Test and typecheck evidence

- Manually invoked the FUNCTEST-B deny-listed suite with the live-infrastructure opt-in unset: `pnpm exec jest --runInBand --runTestsByPath tests/ingress-bounded.test.ts` - **exit 0**. Jest reported `Test Suites: 1 skipped, 0 of 1 total` and `Tests: 8 skipped, 8 total`; the suite printed `SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.` Its source confirms that without `DU_LIVE_INFRA=1`, no app/listener or PG/Redis connection is started (`tests/ingress-bounded.test.ts:89-98`). The live suite therefore remains skipped under the FUNCTEST-B deny-list; no infrastructure was accessed.
- Searched `tests/` for ingress/body-named suites; `tests/ingress-bounded.test.ts` is the only match, so there were no other ingress suites to run.
- `pnpm exec tsc --noEmit -p tsconfig.json` from `services/orchestrator` - **exit 0**, no diagnostics.

## Files

- Modified: `services/orchestrator/src/http/ingress.ts`.
- Added: `services/orchestrator/opt-perf-01b-ingress-concat-bench.cjs`.
- Added: this receipt.
- No commit or gate change was made.

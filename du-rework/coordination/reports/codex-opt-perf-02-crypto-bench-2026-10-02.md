# OPT-PERF-02 — crypto chunk geometry benchmark

Date: 2026-10-02. Status: complete. This is an offline measurement receipt; it makes no runtime or gate change.

## Progress / method

1. Read `coordination/dispatch-specs/2026-10-02-0350-OPT-PERF-02-crypto-bench.md` and the OPT-PERF-01 receipt. Confirmed the live baseline is 4 MiB chunks with an 8 MiB stream high-water mark, and that chunk geometry is persisted and validated in the manifest (`services/orchestrator/src/modules/encryption/crypto-storage-facade.ts:13-14,86,281-297,368,649-655`).
2. Added `services/orchestrator/opt-perf-02-crypto-chunk-bench.cjs`, a standalone harness with the required `opt-perf-` filename prefix. It loads the production facade after in-memory TypeScript transpilation and substitutes only the chunk-size constant in memory; it does not write or modify production files. Each isolated child uses local AES-256-GCM, production hashes/tags/AAD/manifest code, an immediate mock DEK provider, and a bounded mock `Writable` storage sink with asynchronous acknowledgements. The benchmarked source is deterministic 256 KiB blocks and the measured payload is 128 MiB + 123 bytes. Each geometry also passes an encryption/decryption round-trip and manifest integrity checks before its timed run.
3. Ran a 16 MiB one-repetition smoke check across 1/2/4/8 MiB geometries; all four round-trip checks passed. The initial 128 MiB × 3 run was noisy (2 MiB median appeared 22.44% faster than 4 MiB), so I increased the confirmation run to seven isolated repetitions per geometry before reaching a verdict.
4. Final measurement: `node services/orchestrator/opt-perf-02-crypto-chunk-bench.cjs --runs=7`; exit code 0, all 28 timed runs and round-trip checks passed. No database, Redis, S3, cloud key provider, or other infrastructure was used.

## Final results

Windows / Node v22.16.0, local process, one child process per run. Throughput is input MiB divided by facade encryption wall time; peak RSS is sampled process RSS. The 4 MiB row is the current production geometry and is the comparison baseline.

| Chunk | High-water mark | Median MiB/s | Min–max MiB/s | Median peak RSS | Median peak RSS increase over warmed baseline | Versus 4 MiB |
|---:|---:|---:|---:|---:|---:|---:|
| 1 MiB | 2 MiB | 349.29 | 330.49–389.54 | 135.56 MiB | 0 MiB | -10.93% |
| 2 MiB | 4 MiB | 380.90 | 318.49–457.83 | 153.35 MiB | 0 MiB | -2.87% |
| **4 MiB (current)** | **8 MiB** | **392.14** | **307.70–435.84** | **153.09 MiB** | **0 MiB** | **0%** |
| 8 MiB | 16 MiB | 390.08 | 361.98–428.90 | 171.26 MiB | 43.80 MiB | -0.53% |

The three-repetition exploratory run is retained as a progress observation, not as the final result: its 2 MiB median was 436.67 MiB/s versus 356.64 MiB/s for 4 MiB (+22.44%), with broad overlapping ranges. The seven-repetition confirmation reversed that apparent advantage. This confirms that the short run was not a stable basis for an optimization claim.

## Verdict

No measured geometry demonstrates a repeatable throughput gain over the current 4 MiB setting in this local harness. The 2 MiB result is 2.87% slower by median; 8 MiB is 0.53% slower and has a median peak RSS about 18.17 MiB above the current geometry, with measured peak increases of 34.08–70.55 MiB across its seven runs. The lower 1 MiB setting is 10.93% slower by median. Therefore there is no evidence-based runtime patch proposal or lease request from this benchmark.

Compatibility remains a material constraint independent of these results: the manifest stores `chunkSizeBytes` and its validator requires the current constant (`crypto-storage-facade.ts:86,292-297,368`). This receipt does not test mixed-geometry persisted artifacts or claim storage/provider performance. The mock storage, local machine, sample pattern, and seven-run sample limit external validity; production throughput and RSS are not inferred from these numbers.

## Files and gates

- Added: `services/orchestrator/opt-perf-02-crypto-chunk-bench.cjs`.
- Added: this receipt.
- Existing files changed: none. Runtime source, tests, config, wire/contracts, and persisted manifest rules are unchanged.
- Gate/COMP rows: unchanged; no commit made.

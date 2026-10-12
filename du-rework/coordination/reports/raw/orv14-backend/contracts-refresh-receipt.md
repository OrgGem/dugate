# Interim contracts build receipt

This receipt relocates the build metadata into the scoped Orchestrator rework evidence tree. The original metadata/manifests under `/workspace/dugate/coordination/reports/raw/orv14-backend/` are preserved; the in-rework copies below are byte-for-byte equal.

- Command: `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node services/orchestrator/node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json`
- Working directory: `/workspace/dugate/du-rework/orchestrator`
- Toolchain: Node `v24.21.0`; TypeScript `5.9.3`
- Recorded build window: approximately `2026-10-12T00:53:50Z`–`2026-10-12T00:53:55Z`
- Exit status: `0`
- Scope: interim `@du/contracts` refresh only; not the final shared build or whole-application verification.

The scoped source manifest is [contracts-src-manifest.txt](contracts-src-manifest.txt), SHA-256 `f0e787f91a33859fac834a810c88fbc2be7232a67a599d4fa24a22f022cb45d8`. The scoped emitted-output manifest is [contracts-dist-manifest.txt](contracts-dist-manifest.txt), SHA-256 `5766c18aa3234c1e1215dc7188f28b06bde7aa0d5b105b3c8932033db5464f87`.

The corresponding original manifests remain at `/workspace/dugate/coordination/reports/raw/orv14-backend/contracts-src-manifest.txt` and `/workspace/dugate/coordination/reports/raw/orv14-backend/contracts-dist-manifest.txt`. `cmp` returned 0 for each original/scoped pair; SHA-256 values match exactly.

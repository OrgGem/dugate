# Interim contracts refresh: Orchestrator restore observation

- Repository: `/workspace/dugate/du-rework/orchestrator`
- Package cwd: `/workspace/dugate/du-rework/orchestrator/packages/contracts`
- Runtime/compiler: Node `v24.21.0`; TypeScript `5.9.3`
- Command: `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node ../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json --pretty false`
- Exit: `0`; direct command wall time reported by exec: `4.916s`
- Timing bound: source manifest captured at `2026-10-12T04:14:57Z`; post-build output manifest captured at `2026-10-12T04:15:17Z`. The exec wrapper did not record an exact UTC start/end for the compile itself.
- Source manifest: 46 entries, unchanged across compile, aggregate SHA-256 `a6b228bb45d9f3d321190ccbfdf25a7c9e16dc060967bbbf0ab81ac2a4e26fa2`.
- Dist manifest: 184 entries, before aggregate SHA-256 `0be5b7af2197e6601390ab06e428c5345536a08a05fd0a65bc2360f6c4dca1fc`; after aggregate SHA-256 `67b57485869e739bb7aadbf12843fb771f41587b716151e16b68586efaa0ed40`.
- Exact source manifest before/after: `contracts-source-before-restore-observation.txt` and `contracts-source-post-restore-observation-rooted.txt`.
- Exact dist manifest before/after: `contracts-dist-before-restore-observation.txt` and `contracts-dist-post-restore-observation-rooted.txt`.
- Only generated dist files changed: `service-runtime.{js,d.ts}` and their source maps.
- Added strict `OrchestratorIsolatedRestoreObservationSchema` and `OrchestratorExternalEffects` exports. Orchestrator no-emit and the focused isolated-runtime owner test were run after this build; both passed. No Worker E2E or host integration is claimed by this receipt.

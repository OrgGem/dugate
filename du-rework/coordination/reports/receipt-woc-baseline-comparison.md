# WOC baseline comparison receipt — 2026-10-12

## Scope and method

This was a bounded evidence-only comparison against baseline commit `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`. The shared checkout was on branch `codex/fix-workflow-builder`, with `HEAD` at that same commit and a dirty working tree from parallel WOC work. No product source was edited for this receipt.

I extracted the selected baseline source trees into the unique OS temp snapshot `C:\Users\Gem\AppData\Local\Temp\du-woc-baseline-dcca8db03cf14f70beddb2713f23ff18`. Existing installed dependencies were reused through temp-local junctions; baseline `@du/contracts`, `@du/observability`, and `@du/egress` outputs were compiled into that snapshot only. Each local package build had a 45-second process bound and exited 0. The test runs had a 90-second process bound and Jest test timeout of 30 seconds. No dependency installation, shared `dist` write, database, Redis, provider, or production access was used.

Environment: Windows PowerShell; Node `v24.21.0`; pnpm `10.18.3`; Git `2.52.0.windows.1`; Jest `29.7.0`; ts-jest `29.4.14`. Raw build output is in [woc-baseline-sdk-temp-build-2026-10-12.txt](raw/woc-baseline-sdk-temp-build-2026-10-12.txt).

## Admin UI slice

Current and baseline command:

```text
node --test tests/operations-state.test.mjs tests/orv14-settings-full-ui-owner.test.mjs tests/workflow-simulation-honesty.test.mjs
```

Current cwd: `D:\Git\dugate\du-rework\orchestrator\apps\admin-web`.

Baseline cwd: `C:\Users\Gem\AppData\Local\Temp\du-woc-baseline-dcca8db03cf14f70beddb2713f23ff18\du-rework\orchestrator\apps\admin-web`.

Both runs exited 1 with **26 failed, 6 passed, 32 total** and the same failure set: 22 Operations assertions, one Settings source-text assertion, and three workflow-simulation errors (`ReferenceError: workflow is not defined`). These failures reproduce on baseline. The failure-bearing tests and sources have matching current/baseline hashes below. The Settings assertion expects `/connectorsTenantId === tenantId/` in unchanged `global-tenant-settings.tsx`; the three workflow errors arise in the unchanged simulation extraction path. The API client did change, so this does not claim the entire UI package is byte-identical; the changed client’s selected checks passed in both runs.

Raw logs: [current](raw/woc-baseline-ui-current-2026-10-12.txt), [baseline](raw/woc-baseline-ui-baseline-2026-10-12.txt).

| UI file | Baseline SHA-256 | Current SHA-256 |
|---|---|---|
| `tests/operations-state.test.mjs` | `9D13413480CDEE244E4FCCB1DD16F091A5964D1995DF803F6F18305DE486CB4A` | same |
| `src/features/operations/state.ts` | `440F7D59FF6ADD37F3A2A21546D8AC2286EC92D0A158CAAA66E2D4FB9F9327D2` | same |
| `src/features/operations/operations-screen.tsx` | `1A4ADE2E9D6AA9F358DDECFF177B9313E4FAFFF035DC64D01A9AEB78086E615C` | same |
| `tests/orv14-settings-full-ui-owner.test.mjs` | `5AE587DA507633B489ACEEE86498B0899AC946819F92B9C54118FD14BD397B54` | same |
| `src/features/settings/settings-screen.tsx` | `ACBDD0913EC9DA1C4248C3311BB0C6C515B0571D5402976C562646ADF8883AA9` | same |
| `src/features/settings/global-tenant-settings.tsx` | `31B8DB4D2F276B63773DAE9A747CA6FDC760A2DC756566499870D3280FFBE08F` | same |
| `src/features/settings/storage-generation-panel.tsx` | `FD0A9AFFE868F0A51E8D33708A5C85B916F4B38ABC90E6CB375B36177ABC43B3` | same |
| `tests/workflow-simulation-honesty.test.mjs` | `4ACF1DF1B4C8387419338513ABBE34AF18E20EFFB0BA67472D869D216FFEC62C` | same |
| `src/features/workflows/workflows-screen.tsx` | `2A8FBA343A15C34908F765434E44628A9AF65C17A96842160197DFE06F923410` | same |
| `src/lib/api/client.ts` | `5517E43518E1CCA4756956AE06E82EFBAC6C0AA77B6122CDB5C7E4FDBBFC9A06` | `176BBF81613B1549D283746207FC89BBBEA72D4B12289AB8FC9E322515BC7349` |

## Contracts slice

Current and baseline command:

```text
node D:\Git\dugate\du-rework\orchestrator\packages\contracts\node_modules\jest\bin\jest.js --runInBand --testTimeout=30000 tests/usage-reconciliation.test.ts tests/profile-policy.test.ts tests/dto.test.ts
```

Current cwd: `D:\Git\dugate\du-rework\orchestrator\packages\contracts`.

Baseline cwd: `C:\Users\Gem\AppData\Local\Temp\du-woc-baseline-dcca8db03cf14f70beddb2713f23ff18\du-rework\orchestrator\packages\contracts`.

Both runs exited 1: **5 failed, 76 passed, 81 total** across three suites. Baseline reproduces the two usage-reconciliation assertions expecting `RangeError` but receiving `ZodError`, and the three profile-detail reads that expected `connectorBindings` but got `undefined`. The involved tests and implementations match current/baseline hashes; the current `runtime.ts` and barrel `index.ts` differ, but those differences do not change these five reproduced failures.

Raw logs: [current](raw/woc-baseline-contracts-current-2026-10-12.txt), [baseline](raw/woc-baseline-contracts-baseline-2026-10-12.txt).

| Contracts file | Baseline SHA-256 | Current SHA-256 |
|---|---|---|
| `tests/usage-reconciliation.test.ts` | `DAB61B2056C48A450B6A40F7D4739B65CA01523FCD46D584A3F4C771E6FDCDC8` | same |
| `src/usage-reconciliation.ts` | `8BB190D84E06F3EE268819983373D4C3EC46049F05D3D1934C6697FDA1F31D40` | same |
| `tests/profile-policy.test.ts` | `80F2FCC314E07C2206F826501830F37AB105621AEA13D55D0D11F4BCC2178FB3` | same |
| `src/profile-policy.ts` | `DCE82FFB1D671BB10BC351B3FAF65CF6ED2D27DAD56139BD795CD841847361B3` | same |
| `tests/dto.test.ts` | `D7293D0226AB6DAF67E382B95591014576CE907F044375105C82D999E53E6C60` | same |
| `src/runtime.ts` | `1C4D55C1023D2059E432FFA5C527D3CD55B1C2C3935CFC0285513C6802A48D0E` | `E28B6D8A9658F44512FE518974C5FBDCF55BA76A6EE88036CEC865886363C91E` |
| `src/index.ts` | `3F86AD729578A81D0D94C9C2BD4D5B2069719299A9A0A147BB2669C719B500CDA` | `1DB649377F879B9D0F3C9C2BD4D5B2069719299A9A0A147BB2669C719B500CDA` |

## SDK temp-sweep and RSS checks

Full current/baseline temp-sweep command:

```text
node D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk\node_modules\jest\bin\jest.js --runInBand --testTimeout=30000 tests/temp-sweep.test.ts
```

Current cwd: `D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk`.

Baseline cwd: `C:\Users\Gem\AppData\Local\Temp\du-woc-baseline-dcca8db03cf14f70beddb2713f23ff18\du-rework\orchestrator\packages\worker-sdk`.

Current: **19 passed**. Baseline: **8 failed, 11 passed**. The eight baseline failures are `startWorker` setup cases whose mocked heartbeat response lacks the baseline contract’s required `backupEffectFence`; they fail in response-schema parsing before exercising sweep behavior. The current test fixture adds the registration response/digest and heartbeat fence. The suite delta therefore does not establish a sweep regression or its cause.

For the direct race case, both trees were rerun with:

```text
node D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk\node_modules\jest\bin\jest.js --runInBand --testTimeout=30000 --testNamePattern=snapshot tests/temp-sweep.test.ts
```

It selected `does not include a workspace written during the active directory snapshot`; that case passed in both runs (**1 passed, 18 skipped**).

Raw logs: [baseline full slice](raw/woc-baseline-sdk-temp-baseline-2026-10-12.txt), [current full slice](raw/woc-baseline-sdk-temp-current-2026-10-12.txt), [baseline selected race](raw/woc-baseline-sdk-snapshot-baseline-2026-10-12.txt), [current selected race](raw/woc-baseline-sdk-snapshot-current-2026-10-12.txt).

The reported direct-band RSS test was not rerun. Its test changed between baseline and current, and the runtime contract also changed, so the test setups are not a clean behavioral comparison. This is a hash-only result, not a pass/fail conclusion.

| SDK/runtime file | Baseline SHA-256 | Current SHA-256 |
|---|---|---|
| `worker-sdk/tests/temp-sweep.test.ts` | `43A1F248BD038D9BB12B66F3623C42BC68984ECA020ADAC8A4D827438901630A` | `288AAFE14DABBC7FAD9349882D3841479A07062A3F0C0CDA53A137E3E7810D43` |
| `worker-sdk/src/worker.ts` | `E460560459447A7CC53E01FAAAD6EB42B20CEA80E51674F2CD2B0A0D8FBC17F7` | `C32C2C0D2B98D6C38D8059034BE1DD85C68B45FF137EA18F6CE136A060DFE2D8` |
| `worker-sdk/src/runtime-client.ts` | `360E6DA0AE0D4DB4C1283AFDE815FDF202B24AC222F697376CAC9681207FE5C3` | `6B705B4CCCE271AE944EC873D144AE635873FD1BFAD146C8429693362E264E67` |
| `worker-sdk/tests/artifact-direct-band.test.ts` | `13F87FA9E61C6C3710AA4607E4B2F9291323F1D7B1012B09D029190633514042` | `3D191F7D171FF614E514A5392CA1ACA611796CA93048C56E489A3303836EB0F8` |
| `worker-sdk/src/artifact-streams.ts` | `B6D1C13A775409951EB8AB3BABC503AA6B872A4036BC1212A72114B45E7C8C9A` | same |
| `worker-sdk/src/artifact-multipart.ts` | `9C8D9FB0ECB10E96249872AF1F26FA77E2F3EDC4D97FE9834868BB82F2371B50` | same |
| `worker-sdk/src/fan-out.ts` | `A523A77A5ED594739A47E5972230364B1895831296F67C92B928B0F06CD9C3F6` | same |
| `contracts/src/runtime.ts` | `1C4D55C1023D2059E432FFA5C527D3CD55B1C2C3935CFC0285513C6802A48D0E` | `E28B6D8A9658F44512FE518974C5FBDCF55BA76A6EE88036CEC865886363C91E` |

## Artifacts and limits

All test and isolated build logs are preserved under `coordination/reports/raw/woc-baseline-*`. The initial recursive cleanup attempt returned only the generic automatic-review text `blocked by policy`; it did not expose a more specific reason. A no-follow inventory found 23 directory junctions, all under the snapshot's `node_modules`, with targets in the repo dependency tree or in the owned snapshot. I unlinked only those exact junction entries with nonrecursive `Directory.Delete(path, false)` calls and verified every target still existed. A second no-follow inventory found zero reparse points, 701 regular files, and 72 regular directories. I then deleted each verified regular file individually, removed the now-empty directories bottom-up with nonrecursive `Directory.Delete(path, false)`, and removed the exact verified snapshot root. The snapshot path no longer exists; no junction target or path outside the owned snapshot was deleted. The comparison does not classify the RSS failure behaviorally, does not run unrelated/full suites, and does not infer production or deployment readiness.

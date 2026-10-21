# Receipt — PC-06 Execute (manifest and worker opt-in)

| Field | Value |
|---|---|
| Packet | `PC-06-EXECUTE` — *Manifest and Worker Opt-in* |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — worker-sdk 38/39 suites (791 passed), tsc 0, three business manifest suites green |
| Prerequisites | PC-01 (contracts V2) and PC-05 (admission & resolution) accepted |
| Lease respected | worker-sdk `src/**` + `tests/**`, and `businesses/**` manifest-opt-in registration only |

**Tóm tắt (VI).** PC-06 không cần thêm trường wire nào: orchestrator (PC-05) đã resolve parameters ở admission và đặt `parameters` vào `input` của Runtime API v1, còn `profileSettings` nằm trong profile snapshot sẵn có. Vì vậy phần SDK là một seam đọc thuần (additive, không đổi interface công khai) cộng 17 test khoá hai quy tắc dễ trôi: thứ tự ưu tiên model và việc `input.model` **không bao giờ** tự thành provider model. Phần manifest đăng ký **version mới** cho 3 business (1.1.0/1.0.0/1.1.0 giữ nguyên bất biến). Phát hiện quan trọng nhất: bản `vendor/contracts` trong mỗi business là snapshot cũ, thiếu `parameterResolution` — Zod sẽ **strip** capability này và digest của business sẽ lệch với orchestrator; đã đồng bộ `manifest.ts` + rebuild dist cho cả 3 vendor và template.

---

## 1. Files delivered

| File | Δ | Content |
| :--- | :--- | :--- |
| `orchestrator/packages/worker-sdk/src/task-context.ts` | +~110 | `ResolvedTaskParameterView`, `describeResolvedParameters`, `DefaultTaskContext.resolvedParameters()` |
| `orchestrator/packages/worker-sdk/src/index.ts` | +6 | barrel exports (`applyPinnedModelDefault`, `describeResolvedParameters`, type) |
| `orchestrator/packages/worker-sdk/tests/task-context-model-resolution.test.ts` | **new** | 17 offline tests: model precedence, parameter view, mixed-rollout compatibility |
| `businesses/document-core/src/manifest/document-core.manifest.ts` | +33 | `documentCoreManifestV120` (1.2.0) — `extract.outputFormat: requestDefaults` |
| `businesses/example-review/src/manifest.ts` | +39 | `exampleReviewManifestV3` (3.0.0) — `enableReasoning: requestDefaults`, two profile-only knobs |
| `businesses/lc-checker/src/manifest.ts` | +34 | `lcCheckerManifestV120` (1.2.0) — `maxConcurrency: requestDefaults`, three slot keys |
| `businesses/{document-core,example-review,lc-checker}/vendor/contracts/src/manifest.ts` + `document-core/template/vendor/contracts/src/manifest.ts` | replaced | synced to the current `@du/contracts` manifest schema (the vendored snapshot predated PC-01) |
| `businesses/{document-core,example-review}/tests/manifest.test.ts`, `lc-checker/tests/worker-manifest.test.ts` | +~40 each | registration assertions for the new immutable versions |

## 2. Acceptance criteria, one by one

| # | Criterion | Evidence |
|---|---|---|
| 1 | Pinned defaults and parameters resolved at admission flow into `TaskContext` | `describeResolvedParameters` returns exactly `task.input`; `ctx.input` equality asserted; `requestDefaults`-filled values visible verbatim |
| 2 | Older SDKs parse payloads without failure | **No wire change at all** (no claim field added); a claim with an unknown top-level field (`parameterResolution`) is tolerated and not projected into input — asserted; `profilePolicy` `undefined`/`null`/populated all resolve |
| 3 | Existing manifests immutable; new versions register cleanly | 1.1.0 / 1.0.0 / 1.1.0 asserted capability-free; each new version validates, keeps the capability through `validateManifest`, and produces a **different** digest and queue |
| 4 | All worker-sdk tests pass | 38/39 suites, **791 passed**; the only failure is `tests/crypto-seam.test.ts` (pre-existing byte-identical source-comparison test, out of scope per the coordinator) |
| 5 | Receipt with logs and exit codes | This file, §4 |
| 6 | Completion line | printed |

## 3. The finding that actually gated opt-in

Each business depended on `@du/contracts` through a **vendored snapshot**
(`businesses/<biz>/node_modules/@du/contracts` is a junction to
`businesses/<biz>/vendor/contracts`). That snapshot predated PC-01: its
`ActionManifestSchema` had no `parameterResolution` key.

Zod `.object()` **strips** unknown keys by default, so a business declaring the
capability through the stale snapshot would have produced a parsed manifest with
the capability silently removed — and therefore a `hashManifest` digest that
excludes it, while the Orchestrator (PC-01 schema) computes a digest that
includes it. Registration would then fail with a digest mismatch, or worse,
succeed against a different shape than what was reviewed.

Fix applied (inside the granted `businesses/**` manifest-opt-in scope): sync
`vendor/contracts/src/manifest.ts` from the real package in all three businesses
plus the `document-core/template` scaffold, and rebuild the three vendored
`dist` trees. The vendored `manifest-validator.ts` was **not** changed — it
lags PC-05's semantic checks, and the authoritative validation runs in the
Orchestrator at registration. That asymmetry is recorded as a follow-up (§5).

The tests prove the fix: `result.manifest.actions[…].parameterResolution` equals
the declared capability (it survives parsing), and the digest differs from the
pre-capability version.

## 4. Verification log (actually run)

| # | Command (cwd) | Result |
| :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (worker-sdk) | **exit 0** |
| 2 | `node --expose-gc ./node_modules/jest/bin/jest.js --runInBand` (worker-sdk) | **exit 1** — `Test Suites: 1 failed, 1 skipped, 38 passed, 39 of 40`; `Tests: 1 failed, 2 skipped, 1 todo, 791 passed, 795` |
| 3 | same, `tests/task-context-model-resolution.test.ts` alone | **exit 0** — `Tests: 17 passed, 17 total` |
| 4 | same, `tests/crypto-seam.test.ts` alone | **exit 1** — sole failure `W-ENC-04 port fidelity … the implementation body is byte-identical to the orchestrator source` (pre-existing, excluded by the coordinator) |
| 5 | `node ./node_modules/jest/bin/jest.js --runInBand tests/manifest.test.ts` (document-core) | **exit 0** — `17 passed, 17 total` (15 pre-existing + 2 new) |
| 6 | same (example-review) | **exit 0** — `6 passed, 6 total` (4 pre-existing + 2 new) |
| 7 | `node ./node_modules/jest/bin/jest.js --runInBand tests/worker-manifest.test.ts` (lc-checker) | **exit 0** — `26 passed, 26 total` (24 pre-existing + 2 new) |
| 8 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (document-core) | **exit 0** |
| 9 | `node node_modules/typescript/bin/tsc -p tsconfig.json` (worker-sdk build) | **exit 0** — `dist/task-context.d.ts` exports `describeResolvedParameters` / `resolvedParameters` |

Regression arithmetic: worker-sdk baseline 774 passed → **791**; the delta is
exactly the 17 new tests, and no existing case changed status.

## 5. Deviations and known limitations (explicit)

| # | Item | Impact / follow-up |
|---|---|---|
| 1 | Vendored `manifest-validator.ts` was not synced. | A business validating its own manifest locally gets structural checks but not PC-05's eight `parameterResolution` semantics. The Orchestrator rejects a bad mapping at registration, so this is a developer-experience gap, not a correctness hole. Fix: sync `manifest-validator.ts` **and** its `profile-policy` dependency in one change. |
| 2 | `applyPinnedModelDefault` is now exported from the barrel. | It was module-internal. Exporting it makes the precedence testable by handlers and non-SDK ports; it is additive and changes no behaviour. |
| 3 | `ResolvedTaskParameterView` is a method on `DefaultTaskContext`, not a member of the public `TaskContext` interface. | Deliberate: adding an interface member would break every other implementer (`document-core` ships its own `MockTaskContext`, outside this lease). Same precedent as `cryptoSeam()`. |
| 4 | `example-review` and `lc-checker` were verified via their manifest suites, not a full `tsc -b` project build. | `tsc -b` would rebuild referenced workspace projects and produce unrelated noise; the manifest suites type-check the changed sources under ts-jest. Document-core additionally got a clean `tsc --noEmit`. |
| 5 | The new versions are **registered code, not activated state**. | Bumping a manifest does not change any running deployment; activation is an admin action, and 1.1.0/1.0.0 stay byte-identical and digest-pinned. |

## 6. Why no wire field was added

The plan is explicit: *"The resulting request `parameters` object is carried in
the existing Runtime API v1 task input; `profileSettings` remains in the
existing profile snapshot. The existing SDK and SDK-free workers therefore
receive the values through existing fields, with no new required Runtime wire
field or SDK dependency."*

PC-06 honours that literally. A `parameterResolution` marker on the claim would
have been a new Runtime field, a reason for old SDKs to reject a payload, and a
second source of truth next to the manifest. Instead the capability lives only
in the manifest, the resolved values live only in the task input, and the SDK
derives its view from fields a v1 claim already carries.

## 7. Suggested next packets

1. **PC-07** — retry must re-authorize the original key/grant and reseal carriers; it should consume `resolvedParameters` instead of re-deriving policy.
2. **PC-08** — the Workbench must show which source filled each parameter; `ResolvedTaskParameterView` is the shape to project from once the preview exposes `appliedRequestDefaults`.
3. **PC-09** — sync the vendored `manifest-validator.ts` for the three businesses and run the mixed-rollout harness (old SDK image + new orchestrator) against a real container.

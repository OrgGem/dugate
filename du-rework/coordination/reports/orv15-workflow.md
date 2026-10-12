# ORV15-WORKFLOW unit-first handoff

Recorded at 2026-10-12T05:47:14Z. This closes the scoped offline unit checkpoint only; it does not close ORV15 workflow acceptance.

The Worker SDK wire test passed 2/2. It preserves the complete root and parallel-branch checkpoint keys and the signed typed-recipe override payload through `TaskContext` grant construction and strict Connector request parsing. Its captured Jest output is [worker-sdk-jest.txt](raw/orv15-workflow/worker-sdk-jest.txt).

The Connector boundary regression passed 2/2 using the real Document Core workflow executors and `DurableConnectorRuntime.invoke` path. The root and branch cases traverse grant verification, request hash binding, typed-revision lookup, cost-control admission and transition, the recipe adapter, invocation ledger, and usage outbox. Only external Runtime/Connector HTTP, cost-control, provider transport, grant authority, and typed-recipe repository ports are mocked. Both cases assert the full checkpoint key, signed override data, provider header/body projection, successful ledger state, and one outbox event. This is an in-memory boundary result, not live service acceptance.

The targeted Connector TypeScript no-emit check passed with no diagnostics. No production source was changed in this checkpoint. The added regression is [orv15-workflow-admitted-recipe-dispatch.test.ts](../../orchestrator/services/connector/tests/orv15-workflow-admitted-recipe-dispatch.test.ts); the SDK wire regression is [orv15-workflow-connector-wire.test.ts](../../orchestrator/packages/worker-sdk/tests/orv15-workflow-connector-wire.test.ts).

The earlier live attempt 29 remains unresolved. Its retained evidence shows a valid grant signature and matching workflow-override digest for the root request, followed by `LEGACY_WORKFLOW_CONNECTOR_FAILED`, no Connector invocation rows, no cost reservation group or holds, and zero provider-call delta. The parallel branch likewise had no Connector rows or provider calls. The attempt did not retain the SDK rejection envelope or a Connector error code, so these unit tests establish that the current in-memory request path can dispatch root and branch recipes, but do not identify the historical live failure. Preserve that RED at [old-pin-worker-failure-diagnostics.json](raw/orv14-worker-e2e-verification/attempt-29/workflow-overrides/old-pin-worker-failure-diagnostics.json).

Remaining acceptance requires a later authorized live run that captures the bounded Connector response/error code at the point the workflow wrapper maps it to `LEGACY_WORKFLOW_CONNECTOR_FAILED`, along with the resulting invocation/cost/provider evidence. No image build, external service, live database, network request, or deployment was used for this checkpoint.

## Verification

From `/workspace/dugate/du-rework/orchestrator`, the Connector unit command was:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node node_modules/.pnpm/jest@29.7.0_@types+node@24.19.2/node_modules/jest/bin/jest.js --config services/connector/jest.config.cjs --runInBand --runTestsByPath services/connector/tests/orv15-workflow-admitted-recipe-dispatch.test.ts
```

Result: 1 suite passed, 2 tests passed.

The Connector no-emit command was:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p services/connector/tsconfig.json
```

Result: exit 0, no diagnostics. The SDK wire test result is 1 suite and 2 tests passed; its captured output is linked above. Its original command line was not retained in the raw output file.

## Source pins

SHA-256 pins recorded with this handoff:

| File | SHA-256 |
| --- | --- |
| `orchestrator/services/connector/tests/orv15-workflow-admitted-recipe-dispatch.test.ts` | `d07835a6ce384af7e78f2ede472732fca6b81a2df61cb06473d174c665189153` |
| `orchestrator/packages/worker-sdk/tests/orv15-workflow-connector-wire.test.ts` | `82aef5ff7f0b14dd4e3e14d8f2de865912311628e479f5f4e118f6446d8111b4` |
| `orchestrator/businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts` | `4583cb04a3b80894112fceee3da1367bcf16b9d956ad0d15d468190514af4e58` |
| `orchestrator/packages/worker-sdk/src/task-context.ts` | `65a063046829b400846ae387ac8a3347281bbab749a103f63b8c33e0dcf8efd4` |
| `orchestrator/packages/worker-sdk/src/runtime-client.ts` | `360e6da0ae0d4db4c1283afde815fdf202b24ac222f697376cac9681207fe5c3` |
| `orchestrator/packages/worker-sdk/src/connector-invoker.ts` | `cc8aca7e54d4b8a00c4625822107d41f2d4564289a4321c04b8f12334b7bc221` |
| `orchestrator/services/connector/src/services.ts` | `4445514a0c14d4f4bc061fd6a4f0e69dae8555c0d39edfe8beb1ec9a2b5a2c3a` |
| `orchestrator/services/connector/src/grants.ts` | `84178ed3d2ac91c6d0ec818e16d63d52b3e7a2e1acc19e033ddd6b1eae37e7d9` |
| `orchestrator/services/connector/src/hash.ts` | `d752f7d81a0d77a14be6cbb6dd84120c491224c4676101c7a020d96dcccf32b9` |
| `orchestrator/services/connector/src/adapters/recipe.ts` | `afeab8fd970ea3eb518d9a08cce0011be6c432be1b76a522c9c45f0da989487a` |
| `orchestrator/services/connector/src/contracts.ts` | `ec7d399e01746a0418504cb276b2888196606469450b6f964777fd9e58069a73` |
| `orchestrator/packages/contracts/src/connector.ts` | `582df049a558c9ea5492f9676817bc60a3b65f716ce7123377f30855b59bef81` |
| `orchestrator/packages/contracts/src/legacy-workflow.ts` | `5824e39d02a81d731745b1dcf8a124003f9d53ec666745bc1be3849830880660` |
| `orchestrator/packages/contracts/src/hashing.ts` | `4697d36b1672082904ef448fa63ddc37d9b6c08cff5a3bd1c05e7d1e114c2bb6` |

The full machine-readable result and complete relevant source pins are in [unit-dispatch-receipt.json](raw/orv15-workflow/unit-dispatch-receipt.json).

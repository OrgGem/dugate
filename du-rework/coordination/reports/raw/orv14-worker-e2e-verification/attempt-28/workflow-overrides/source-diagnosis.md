# Attempt 28 typed-workflow grant lookup diagnosis

Captured 2026-10-12 03:52 UTC after attempt 28. This is a source-derived diagnosis of the retained failure, not an additional live run or a persisted trace of the invocation request. Attempt 28's only runtime error evidence remains the task row `root / FAILED / LEGACY_WORKFLOW_CONNECTOR_FAILED`; the harness did not persist the grant request body or a structured Connector error trace. No grant token, secret, header/form value, prompt, or provider response is included here.

The selected fixture's schema node ID is `recipe_request` (`tests/workflow-api/orv14-vfy-core31.test.ts`, `workflowRecipeSchema`; attempt-28 test SHA-256 `742c455238ffff44d4ea9d23c6c686e2700db7a3016a4651c64a89ebb1c9f2da`). The frozen Document Core runtime creates its checkpoint key with `nodeCheckpointKey(state.pin.digest, node.id, expectedTaskKind, parallelNodeId, parallelBranchIndex)`. For this root task the structured key is:

`legacy-workflow:node:sha256:<64-hex-admitted-pin-digest>:root:root:recipe_request`

`executeLegacyWorkflow` calls `context.step.run(checkpointKey, ...)`; the callback calls `executeLeaf`, which calls `context.connector.invoke`. Worker SDK `StepFacade.run` wraps that callback with `runWithStepKey(stepKey, fn)`, and `connector.invoke` reads `currentStepKey()` into the signed-grant request. This proves the normal runtime supplies the checkpoint key above as `stepKey`; it does not depend on a test adapter or a fabricated request.

At the attempt-28 source checkpoint, Orchestrator `grants.ts` `visitWorkflowNodes` compared `node.id === stepKey`, then passed the request step key to that lookup. Since `recipe_request` cannot equal the namespaced checkpoint string, `authorizeWorkflowOverride` rejects the invocation before it signs a grant. The durable worker error wrapper surfaces only `LEGACY_WORKFLOW_CONNECTOR_FAILED`. Relevant attempt-28 hashes: Document Core runtime `4583cb04a3b80894112fceee3da1367bcf16b9d956ad0d15d468190514af4e58`; Worker SDK task-context `65a063046829b400846ae387ac8a3347281bbab749a103f63b8c33e0dcf8efd4`; Orchestrator ordinary grant producer `7214893e48115e0068dfedb17877b4816ef83987ff82bcc4f63f1d65fdee450e`.

The correction belongs to the grant lookup producer/consumer boundary. The next affected live run should retain immutable schema and recipe-pin authentication, node-to-slot mapping, exact Connector revision checks, and exercise a valid admitted key plus forged-digest and branch cases. Attempt 28 itself remains a red result and is not upgraded by this analysis.

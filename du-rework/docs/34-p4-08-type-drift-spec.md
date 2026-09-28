# 34. P4-08 type-drift spec (blocked: SDK owner stopped; spec only, no source fix)

Testing-lane live batch: p4-08 0 total, TS2345 at
tests/integration/p4-08-sdk-consumer.integration.test.ts:334:44, argument
`invokeConnector (redis:{ur...})`.

## Exact signatures today

- `ConnectorInvokeFunction` (worker-sdk/src/types.ts:248): `(grant:
  InvocationGrant, payload: ConnectorInvocationPayloadShape) =>
  Promise<InvocationResponse>`. Config field `WorkerConfig.invokeConnector?`
  (types.ts:242) accepts exactly this; `StartWorkerInternalOptions extends
  WorkerConfig` (worker.ts:115) adds consumer/logger/tempSweep only.
- `SdkConnectorInvoker` (connector-client/src/sdk-invoker.ts:60):
  `(grant: SdkInvocationGrant, payload: SdkInvocationPayload) =>
  Promise<InvocationResponse>` where SdkInvocationGrant is `{grant,
  invocationId}` (structural mirror, lines 45-48).
- Test 334:44 passes `invokeConnector: createSdkConnectorInvoker(...)` plus
  sibling key `redis: { url: REDIS_URL }` (test:305) inside workerConfig fed
  to `startWorker(definition, workerConfig)` (test:334). `redis?: { url:
  string }` IS a legal WorkerConfig field (types.ts:226), so the TS2345
  argument is the `invokeConnector` function shape, not the redis key: the
  mirror pair (SdkInvocationGrant vs InvocationGrant,
  SdkInvocationPayload vs ConnectorInvocationPayloadShape) has drifted, or
  the test file resolves mismatched @du/contracts vs worker-sdk type
  revisions.

## What test 334:44 wants

Start a worker with queue transport (redis url) + injected connector
invoker (HTTP transport to real P3), no DB credential, for the full
submit->...->SUCCEEDED proof.

## Fix options (USER routes execution; SDK lane stopped)

- A (prefer): fix TEST to the signature. Realign the SdkInvocation*
  mirrors to the frozen contract types (import, not mirror) or adapt the
  call site; impact: test-only, P4-05/P4-07 untouched, API unchanged.
- B: fix SIGNATURE to the contract. Change ConnectorInvokeFunction or the
  invoker return/param shape; impact: touches frozen P4-02/P4-07 surface +
  connector-client API + every consumer (P4-05/P4-07 regressions, security
  review of grant/payload shape). Heavier; needs SDK owner.

Recommend A unless USER accepts B with a security pass. NO DB USED.
Nothing ticked.

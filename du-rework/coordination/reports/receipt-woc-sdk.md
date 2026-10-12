# WOC SDK receipt

Date: 2026-10-12 15:19 ICT  
Owner: `/root/woc_sdk`  
Workspace: `D:\Git\dugate\du-rework`  
Orchestrator cwd for commands: `D:\Git\dugate\du-rework\orchestrator`

## Delivered

- Claim handling now uses `RUNTIME_CLAIM_ERROR_DISPOSITION`: only backend-declared terminal/stale outcomes are ACK-safe. Admission/readiness/version/manifest/transient/shutdown and unknown outcomes remain recoverable. Retries are bounded and jittered. The BullMQ adapter moves an active job to delayed with its lock token and raises `DelayedError`; injected consumers without a delay hook wait locally and reject on shutdown rather than falsely completing.
- Execution dispatch uses the authoritative claim snapshot kind. Business ID, exact version, and manifest digest must match the local validated manifest before the handler runs. Incompatibilities and missing handlers defer to lease recovery rather than terminal-failing pinned work.
- Task processing has a local watchdog tied to the last confirmed `leaseExpiresAt`, bounded safety margin, and valid heartbeat acknowledgements only. Failed network heartbeats do not extend the lease; late acknowledgements cannot revive an expired task. Lease loss, shutdown, and compatibility aborts do not issue a terminal Connector cancel. Late claims after shutdown skip user code and remain recoverable.
- Missing `backupEffectFence` in a v1 worker heartbeat is treated as UNKNOWN/fail-closed. Startup refuses to consume claims; a later missing fence closes admission and aborts active contexts. Existing intentional shared authentication keys and invocation IDs remain unchanged.
- Fixtures now use the validated manifest digest and current heartbeat ACK fields. The independent missing-fence legacy case remains and asserts fail-closed behavior.

## Files changed

- `du-rework/orchestrator/packages/worker-sdk/src/worker.ts`
- `du-rework/orchestrator/packages/worker-sdk/src/task-context.ts`
- `du-rework/orchestrator/packages/worker-sdk/src/types.ts`
- `du-rework/orchestrator/packages/worker-sdk/tests/worker.test.ts`
- `du-rework/orchestrator/packages/worker-sdk/tests/connector-session.test.ts`
- `du-rework/orchestrator/packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts`
- `du-rework/orchestrator/packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts`
- `du-rework/orchestrator/packages/worker-sdk/tests/temp-sweep.test.ts`
- `du-rework/orchestrator/packages/worker-sdk/tests/woc-sdk-worker.test.ts` (new)

No edits were made to runtime-client, contract source/dist, backend, templates, auth configuration, or shared coordination plans. Backend supplied the optional v1 fence and disposition contract; transport supplied the retryability flag used by worker failure classification.

## Verification

Passed:

- `pnpm --filter @du/worker-sdk lint` — orchestrator cwd; TypeScript `tsc --noEmit -p tsconfig.json`; exit 0.
- `pnpm --filter @du/worker-sdk exec jest tests/worker.test.ts tests/woc-sdk-worker.test.ts tests/worker-service-auth.test.ts tests/wfa-t26-lease-loss-abort.test.ts tests/connector-session.test.ts tests/p730-sdk-consume-pin-passthrough.test.ts tests/p745-carrier-sdk-forward.test.ts tests/temp-sweep.test.ts --runInBand` — orchestrator cwd; 8 suites passed, 168 tests passed, 0 failed. Raw log: `%TEMP%\woc-sdk-focused-jest-final-2026-10-12.log`.
- `pnpm --filter @du/worker-sdk exec jest tests/woc-sdk-worker.test.ts --runInBand` — orchestrator cwd; 1 suite passed, 13 tests passed, 0 failed.

Full package Jest was not completed in the final bounded run. `pnpm --filter @du/worker-sdk test -- --runInBand` was interrupted after about 60 seconds at the parent’s request to avoid a long broad run delaying the next packet. Six suites had reported failures by then; Jest had not emitted final counts. Partial raw log: `%TEMP%\woc-sdk-full-jest-final-2026-10-12.log`.

An earlier full-package run, before the final short-renewal and post-claim-shutdown regressions, completed with 36 suites (28 passed, 8 failed), 717 tests passed, 34 failed, 1 todo (752 total). Its surfaced failures were:

- `artifact-direct-band.test.ts`: resident external-memory value 14.87 MiB exceeded the 8 MiB assertion.
- `connector-invoker.test.ts`: assertions expected `INVOCATION_UNKNOWN` to be non-retryable, conflicting with canonical same-logical-invocation retry behavior. The worker-specific expectation was corrected and is covered by the passing `worker.test.ts`; connector-invoker assertions remain for a separate owner/verification decision.
- `artifact-read-metadata.test.ts` and `artifact-stat.test.ts`: malformed access-grant response assertions expected `ZodError`; with transport’s ambiguous-write handling they received `AmbiguousReportError`.
- `p730-pinned-policy.test.ts`: malformed successful claim payload assertions expected `ZodError`; transport now classifies the ambiguous claim ACK as `RuntimeError`.
- `crypto-seam.test.ts`: existing worker/vendor source parity assertion reports implementation-body drift.
- `temp-workspace.test.ts`: concurrent sweep assertion expected both results to include the same removed path.

The final bounded run also observed `artifact-direct-band.test.ts`, `connector-invoker.test.ts`, `artifact-read-metadata.test.ts`, `artifact-stat.test.ts`, `crypto-seam.test.ts`, and `p730-pinned-policy.test.ts` as failing before interruption. Schema-error expectation failures are related to the transport ambiguity contract; RSS and concurrent sweep failures require baseline comparison; crypto parity requires source/vendor reconciliation. These are not claimed as passing or resolved here.

No production build, Redis/PostgreSQL E2E, deployment, or live worker run was performed.

## Queue/auth note

The SDK queue name remains business plus exact version (`businessQueueName(businessId, version)`), allowing separately preconfigured v1/v2 workers to use distinct queues. Registration still requires the existing preconfigured `runtimeToken`; self-registration cannot provision that identity. Parent has assigned backend ownership of the WOC09 registration route/registry/gates and a follow-up SDK startup packet. This receipt does not add startup registration or change auth keys.

## SHA-256 source hashes

Hashes below identify the final SDK and fixture files at handoff:

```text
22302E165E60649226E6F1D7382BE49B523E20DBD27A1F44B6614D90B0000CA6  packages/worker-sdk/src/worker.ts
A52ACA41E3883B9573402C54A32556699B836357CB14A2B731F46445391BE02D  packages/worker-sdk/src/task-context.ts
1480525876B3A4398D755A2469B15843A0124B84FDC5764BB779D561F4AC25FC  packages/worker-sdk/src/types.ts
0AC4EDA5A135CB1DA63C935C349149EAC40434F273377E566470792A0CFE0A11  packages/worker-sdk/tests/worker.test.ts
A25F4A4D83A69711AF2DFBC01589A3356584095E69E82CC7499E5204400A1C70  packages/worker-sdk/tests/connector-session.test.ts
FACD314A656792376240F962D77DC733B299BD25CC3802DF322966D514A1BC90  packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts
26B739853E34B76525E19D93B2031E35237ACE6AA8E77206462940072218690C  packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts
3DDCBB9C00A20171D279C703913B3BEDAE895907F2A402C0F438428034DD04D8  packages/worker-sdk/tests/temp-sweep.test.ts
ACE05DE28D6787A3290BE2C093D1FB682BF5006A1150450C51E9D858C49C0237  packages/worker-sdk/tests/woc-sdk-worker.test.ts
```

No commit, push, deployment, or environment change was made.

# W2 Phase A: PLAN04-01/02 fixture and harness

Fixture data: [`tests/fixtures/w2-profile-policy-prompt-override.json`](../fixtures/w2-profile-policy-prompt-override.json)

## Secret snapshot and sink scan

The fixture has separate bearer-token, header-value, and query-value canaries. They are synthetic scanner probes, not credentials. The `credentialCases` are write-only auth-config inputs; build the operation snapshot from `expectedNonSecretSnapshot`. The snapshot must retain the immutable `(tenantId, profileId, profileRevision)` reference and configured state while excluding every canary.

For the offline object captures, reuse `scanForSentinels` from `tests/harness/network-boundaries/sink-scan.ts` or adapt the objects to `assertSinksClean` in `tests/harness/sentinel-scan/index.ts`. Assign the fixture's `noSecretSinkIds` to profile read, operation snapshot, task snapshot, outbox, claim response, checkpoints, queue payload, and captured logs. Positive-control each sink adapter with one canary before treating a clean scan as evidence. This Phase A harness uses in-memory objects only; it does not connect to PostgreSQL, Redis, S3, or Vault.

## Policy and consumer matrix

- Assert F-PP1's exact BullMQ priorities from `priorityCases`: LOW 20, MEDIUM 10, HIGH 1.
- Resolve prompts by source precedence `Code > Profile > Connector default`. Inside the Profile layer, prefer the step-specific prompt, then use `_default` when the step has no override. `promptOverrideKey` carries the key-4 tuple `(connectionId, apiKeyId, endpointSlug, stepId)`.
- Compare each authored `connectionsOverride` step to its pinned `(connectionId, connectionRevision)` binding. A missing, unknown, stale, or wrong-tenant binding must be rejected before any provider request. The two valid steps exercise `captureSession` then `injectSession`.
- Apply every extension case to its named admission/acquisition path. Include a mismatch between `submittedFilename` and `sourceMetadataFilename`; the client-supplied name alone must not make a disallowed source pass. Keep the exact CSV value and legacy case/duplicate behavior in scope when adding more vectors.
- Keep the submitted revision pinned across parent, child, retry, restart, and HITL resume after a newer revision is published; a new operation should see the new active revision.
- The credential failure cases require wrong-tenant, wrong-key, tampered-tag, and key-unavailable paths to fail before source fetch and before provider invocation.

## Mock-provider request observation design

Reuse `MockProviderServer` from `tests/stubs/provider/mock-provider.ts`. Start it on `127.0.0.1` with port `0`, point the test connector at its `baseUrl`, and call `reset()` before each case. Execute one invocation at a time and keep `{profileRef, operationId, stepId, expectedPromptSource}` as test-side correlation metadata; the wire body need not contain an operation key or step id. Read only the resulting call's `method`, `url`, and parsed `body` to assert the effective prompt/model for that step. For a two-step session case, inspect the second recorded invocation for the first step's captured session.

`callHistory` also contains raw request headers. Keep it in process memory, use it only for assertions, and never print or persist the full entry. A denial case passes only when the expected typed rejection happens before the mock receives a call (`callCount === 0`). Receipt evidence should contain case ids, step ids, request counts, outcomes, and the exit code, with no raw headers, bodies, or canary values.

This is a fixture and observation design only. PLAN04-01/02 acceptance, live sink coverage, revision continuity, and provider behavior remain unverified until the W1 checkpoint opens Phase B.

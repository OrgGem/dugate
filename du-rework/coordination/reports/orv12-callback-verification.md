# VFY-ORV12-CB independent verification

2026-10-11 16:30 UTC. Worker `/root/migration` independently verified callback/retry product code owned by UI/SET/API. This receipt does not accept this worker's DATA/STORAGE implementation.

**VERIFIED: 11 passed, 0 failed, 0 skipped, exit 0.** Required review/acceptance remains coordinator-owned.

Changed files in this packet: `tests/workflow-api/orv12-vfy-callback-controls.test.ts`, this receipt, and `coordination/reports/raw/orv12-callback-vfy/*`. No product source edited. Tested source/test hashes: [source-sha256.txt](raw/orv12-callback-vfy/source-sha256.txt). Raw final run: [final.log](raw/orv12-callback-vfy/final.log).

CWD `/workspace/dugate/du-rework`. Node 24.21.0, real PostgreSQL16 on isolated synthetic fixture database localhost55498, migrations applied into random schema from workflow isolation utility. Redis localhost56398 with isolated namespace; no flush or shared cleanup. Real public/internal/admin-shell HTTP listeners, memory session repository, synthetic bearer/key material. Schema dropped by teardown.

```sh
export PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:$PATH
NODE_PATH=$PWD/node_modules/.pnpm/node_modules node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand tests/workflow-api/orv12-vfy-callback-controls.test.ts
```

| Independent acceptance | Evidence |
|---|---|
| Platform and tenant operator retry FAILED delivery through BFF/session/CSRF/upstream/PG | Two positive tests, each two concurrent requests with same idempotency key, both200 and exactly one audit row |
| Preserve delivery identity, immutable payload/policy and consumed attempts | Same delivery ID and JSON values; attempts5 preserved on queue, max budget5→6 |
| Actual successful callback | Production `deliverWebhooks` and pinned egress perform real HTTP to fixture receiver;204 recorded, original exact payload JSON received, statusDELIVERED/attempts6 |
| No execution side effects | Exact full original operation row unchanged, global operation/task counts unchanged, tasks/outbox/usage events/invocation grants unchanged before/after retry and dispatch |
| Bounded extra attempts, stale and concurrent compare-and-set | Stale4 vs actual5→409; two different idempotency keys yield200+409; attempt10→409 |
| Nonfailed statuses forbidden | PENDING, DISPATCHING, DELIVERED each409 |
| Authorization and deletion | Cross-tenant404; viewer403; missingCSRF403; deleted operation read/retry404 |
| Fresh execution retry uncertain provider outcome | Nested task INVOCATION_UNKNOWN→409, no new rows or state mutation |
| Fresh execution retry spend gate | Exhausted key→402, no new rows or state mutation |
| Active retry replay | Existing ACCEPTED child returned twice with replayedtrue, even exhausted budget, single child/no new tasks/outbox/usage/grants |

Transport is explicit test-only egress: `callback.fixture.example` resolves through injected resolver to127.0.0.1, exact allow-host and allow-private-network options. The normal dispatcher/pinned HTTP fetch sends actual bytes; transport is not mocked to a canned2xx. No external network destination used. Auto dispatch/business workers disabled; dispatcher invoked explicitly with the fixture egress capability. Unchanged durable task/outbox/usage/grant evidence establishes no new execution admission; this test does not claim to run an external provider or customer workflow.

Finding history: [run4.log](raw/orv12-callback-vfy/run4.log) exposed BFF's admin-only action gate blocking tenant operators. SET owner corrected exact callback-action permission and tenant credential routing. Final run verifies the fix including cross-tenant/viewer/CSRF negatives. Earlier run1–3 were fixture preparation errors (rollout flag/tenant credential and terminal seeding); run5 used a literal private callback rejected by pinned policy, corrected to explicit resolver-controlled fixture hostname. These are preserved as debugging history, not counted as additional tests.

Limitations: no production customer data, public TLS endpoint, provider execution, or browser-click claim. Authenticated callback secret resolution and encryption modes remain separate owner/VFY coverage. This packet validates actual HTTP BFF actions and delivery bytes for the immutable no-auth callback policy.

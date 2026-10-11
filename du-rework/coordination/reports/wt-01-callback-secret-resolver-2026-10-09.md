# WT-01 callback secret resolver

## Branch selected

Selected branch (b): terminal fail-closed handling when a credential-bearing callback has no resolver. The resolver is still absent from the production entrypoint, and implementing the SC-01/Vault backend is outside this WT-01 lease. A terminal configuration failure prevents repeated sweeps from consuming the retry budget or presenting the failure as a transient upstream fault. The dispatch objective has a wording inconsistency (`a` or `c`); section 1 and the acceptance criteria identify the alternative as branch (b).

## Source and test evidence

The branch (b) implementation and regression tests were already present in the current tree; this WT-01 turn made no source or test edits.

- `orchestrator/services/orchestrator/src/server.ts:302-303` declares the optional `resolveCallbackSecret` and OAuth2 options.
- `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:1104` forwards a configured resolver to the webhook sweep. The current `main.ts` boot configuration does not provide one, so the no-resolver path remains active until the resolver backend is separately wired.
- `orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts:388-402` keeps `WEBHOOK_AUTH_UNAVAILABLE` distinct from `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`.
- `orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts:674-684` marks a credential-bearing row terminal when no resolver exists; it does not send the callback.
- `orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts:798-811` sets the delivery to `FAILED`, preserves `attempts`, and records the fixed terminal code without scheduling backoff.
- `orchestrator/services/orchestrator/tests/cb03-composition-resolver.test.ts:136-190` checks no send, terminal failure, unchanged attempts across later sweeps, distinction from the transient code, and normal authenticated delivery when a resolver is supplied.
- `orchestrator/services/orchestrator/tests/cb-02-webhook-result-delivery.test.ts:566` also pins the terminal code in the result-delivery suite.

The WT-01 product and test paths above had no diff when checked. `create-app.ts` and `main.ts` remain modified from the preceding MDB-01 lease; those hunks were preserved and not changed for WT-01.

## Offline verification

Working directory for commands: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.

`node -v` returned `v24.21.0`, exit code `0`.

Command:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/cb03-composition-resolver.test.ts tests/cb-02-webhook-result-delivery.test.ts
```

Exit code: `0`.

Literal summary:

```text
Test Suites: 2 passed, 2 total
Tests:       30 passed, 30 total
Snapshots:   0 total
```

Typecheck command:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Exit code: `0`; no output.

These are offline tests using scripted database behavior. No PostgreSQL or Redis was started, and no DB window is claimed.

## Remaining boundary

This verifies branch (b), not a working managed-secret resolver. Credential-bearing callbacks remain undelivered and enter terminal `FAILED` until a separate task supplies and wires the approved resolver. No gate was ticked. No commit, `git add`, or push was performed.

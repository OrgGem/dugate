# Connector-local protocol matrix

This document describes the pre-freeze adapter boundary. It deliberately does
not publish `@du/contracts` DTOs; the exact wire types will be adopted after
`contracts-v1.md` is ready.

| Concern | Local invariant | Contract handoff |
| --- | --- | --- |
| Invocation identity | `invocationId` is stable for replay; input hash mismatch is a conflict | Map to the frozen invocation request |
| Grant | Signed payload binds tenant, operation, task, step, invocation, input hash, audience, revision and expiry | Replace local claim shape with the contract grant claims |
| Provider request | Declarative JSON or multipart mapping only; endpoint and headers are revision-owned | Map adapter capability/config schemas |
| Provider result | Normalize content/data/artifacts/session/usage without retaining raw bodies | Map normalized result/error envelope |
| Unknown outcome | A transport failure after dispatch is `UNKNOWN`, never an automatic retry | Preserve runtime reconciliation classification |
| Usage | One immutable event id per actual provider attempt; delivery is at-least-once | Map usage event to platform outbox |
| Quota | Acquire a bounded lease before dispatch and release/reconcile after completion | Replace local store with shared Redis implementation |

Supported local adapter modes are `json` and `multipart`. Provider-specific SDKs
and business prompts are intentionally out of scope.

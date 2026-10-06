# READSTORED-CALLSITE-INVENTORY — 2026-10-05

**Task:** `task_56210c092a53` / dispatch `ctx_05a4198f6e3f`
**Scope:** source-only grep/read inventory for the callsite portion of ENCMETA-WINDOW-DESIGN-803. This receipt does not define A2 or the plaintext-window policy. No source or tests were changed or run.

## Finding

Every production `true` for `allowPlaintext` found in `services/orchestrator/src` is a literal; none is supplied by a runtime setting or boot option. Three text readers are read-only projections and can remain compatible only under the approved window control. Other `true` paths feed worker execution, idempotency, continuation writes, or source acquisition and should reject plaintext immediately. A further issue is that some helpers return raw values before consulting `allowPlaintext`, so a boolean-only flip cannot close the window end-to-end.

## 1. Complete call inventory

The grep covered all TypeScript source under `services/orchestrator/src`. It found four external `readStoredText` callers and four external `readStored` callers, plus the text helper's internal `readStored(..., false)` delegation. Interface and implementation declarations are not counted as callers.

| Callsite | Purpose / context | `allowPlaintext` value and source | Classification |
|---|---|---|---|
| `services/orchestrator/src/http/routes/public.ts:538-543` | GET `/api/v1/operations/:id/result`; API-key auth and tenant check precede the projection (`public.ts:478-488`). Opens the opaque operation `result_ref` for the response. | `true`, literal at `:542`; no config/boot source. | Read-only response. May retain compatibility only during the centrally approved window. |
| `services/orchestrator/src/modules/runtime/runtime.ts:1202-1207` | `getChildren`, child status/result refs for join visibility (`runtime.ts:1165-1168`). The route is GET and calls `assertTaskRuntimeAuth` first (`http/routes/runtime.ts:457-463`). | `true`, literal at `:1206`; no config/boot source. | Read-only result projection after runtime-token/resource auth. May retain compatibility only during the approved window. |
| `services/orchestrator/src/modules/operations/mappers.ts:103-108` | Admin operation detail's succeeded-result projection. Route resolves the admin principal and tenant-fences tenant operators before calling the mapper (`http/routes/public.ts:449-455`). | `true`, literal at `mappers.ts:107`; no config/boot source. | Read-only response after admin/resource auth. May retain compatibility only during the approved window. |
| `services/orchestrator/src/modules/runtime/runtime.ts:1814-1819` | Opens sibling `tasks.result_ref` values, merges them into the parent's `joinSummary`, then seals/writes the parent payload and queues continuation (`runtime.ts:1822-1847`). | `true`, literal at `:1818`; no config/boot source. | **Fail closed immediately.** This is read-modify-write and feeds persisted continuation work; plaintext acceptance can make an unauthenticated legacy value part of new executable state. |
| `services/orchestrator/src/modules/runtime/runtime.ts:453` (`openMetadata`) | Generic `crypto.readStored(value, context, true)` helper. Its callers are `runtime.ts:1025` (spawn-child idempotency payload/hash comparison), `:1828` (join parent payload before rewrite), and `:1892, :1903, :1933, :1973` (`buildClaimResult`: session/output checkpoints, operation input ref, and task payload returned on worker claim). | `true`, literal in the shared helper at `:453`; there is no per-call policy argument and no config/boot source. | **Fail closed immediately for all these callers.** They participate in replay integrity, continuation writes, or execution data delivered after claim/tenant checks; they are not passive display reads. |
| `services/orchestrator/src/modules/runtime/runtime.ts:357-361` (`openPromptCarrier`) | Opens the pinned prompt-override carrier, then validates its shape, caps and revision markers before returning a worker claim. | `false`, literal at `:360`; no config/boot source. | Already fail closed for plaintext. Keep false. |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts:325-329` (`openDispatchSourceUrl`) | Opens a sealed outbox `sourceUrl` under tenant/task AAD before acquisition (`:626-644`). | `false`, literal at `:329`; no config/boot source. | Envelope branch is fail closed. **Adjacent bypass:** raw strings return before this call at `:318`; that path is source acquisition, so reject legacy plaintext there immediately. |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts:660-665` | Opens root `tasks.payload_ref` before processing its action input and source URL; subsequent failure/acquisition/materialization paths start at `:674` onward. | `true`, literal at `:664`; no config/boot source. | **Fail closed immediately.** This payload controls processing and external acquisition/storage side effects. |
| `services/orchestrator/src/modules/runtime/metadata-crypto.ts:371-372` | Internal call from `readStoredText` after JSON parsing confirms that the value is one of our sealed envelopes (`:359-372`). | `false`, literal at `:371`; no config/boot source. | Already fail closed for unsealed parsed values; valid sealed envelopes still open with AAD checks. Keep false. |

The lower-level `MetadataCrypto.readStored` contract is declared at `metadata-crypto.ts:192-199`; the implementation at `:322-336` returns plaintext only when its boolean is true. The `readStoredText` wrapper is declared at `:350-372`.

## 2. Read-only versus security-sensitive paths

Only these three callsites are observational reads and are eligible for a time-bounded plaintext allowance: the public result GET (`public.ts:538`), runtime child-visibility GET (`runtime.ts:1202`), and admin operation-detail projection (`mappers.ts:103`). Their existing endpoint authentication and tenant/resource fences remain required during any compatibility window.

The `true` in `runtime.ts:453` is the most consequential hidden allowance: it is inherited by six generic opens across child replay, parent continuation and worker claim. It must be disabled for those execution paths at the A2 transition, regardless of whether read-only result projections retain a compatibility allowance. The explicit `true` at `runtime.ts:1814` is also on the parent continuation write path. `ingestion-consumer.ts:660` opens an input used before source acquisition and artifact materialization. These three source areas are integrity/security boundaries; treating their plaintext behavior as tolerated read downtime is incorrect.

No direct read helper call was found in an audit writer. That does not make claim or ingestion compatibility safe: these values feed actions and records that are subsequently authorized, executed, or persisted.

## 3. Central-control gap and bypasses

`rg -n "allowPlaintext" services/orchestrator/src -g "*.ts"` finds only the parameter/type, comments, and the literal callsites above; no environment variable or boot/config option controls it. Current composition only creates `metadataCrypto` when `config.metadataEncryption` exists (`app/bootstrap/create-app.ts:295-307`, boot input from `main.ts:148,181-186`). The seam carries key provider/key ref, not migration-window permission. The route context explicitly documents `metadataCrypto === undefined` as returning historical plaintext (`http/route-context.ts:79-84`).

There are three concrete cases where a future `allowPlaintext=false` at the caller would still not suffice:

1. `metadata-crypto.ts:358` returns a text value verbatim when `crypto` is absent, before checking `allowPlaintext`; `:357` also stringifies non-string values before checking the flag.
2. `runtime.ts:452` returns the stored value when `metadataCrypto` is absent, before the helper reaches `readStored(..., true)`.
3. `ingestion-consumer.ts:318` returns a string `sourceUrl` verbatim before the false-flag envelope path; separately, `:658` skips `readStored` entirely if `metadataCrypto` is absent and leaves `parsedEnvelope` in use.

So the accidental uncontrolled `true` values are specifically `runtime.ts:453`, `runtime.ts:1206`, `runtime.ts:1818`, `public.ts:542`, `mappers.ts:107`, and `ingestion-consumer.ts:664`. The three read-only literals may be allowed only by a central decision; the `runtime.ts:453,1818` and `ingestion-consumer.ts:664` values must not be allowed on their current security-sensitive paths. The current code has no shared switch that distinguishes those classes.

## 4. Exact source-file impact at the two transitions

This is an impact list, not a definition of A2 or of the window.

### At the A2 flip

The callsite/core files that need an explicit policy decision are:

1. `services/orchestrator/src/modules/runtime/runtime.ts` — make generic `openMetadata` fail closed for the six execution/mutation callers listed above; make the join-summary reader at `:1814` fail closed; route `getChildren` at `:1202` through the approved read-only allowance if that endpoint remains in-window.
2. `services/orchestrator/src/modules/operations/ingestion-consumer.ts` — make the `:660` payload open fail closed and reject the raw-string `sourceUrl` path at `:318`; retain the existing false envelope open at `:325-329`.
3. `services/orchestrator/src/http/routes/public.ts` — route the read-only result GET at `:538-543` through the approved allowance rather than a literal.
4. `services/orchestrator/src/modules/operations/mappers.ts` — route the authenticated admin-detail projection at `:103-108` through the approved allowance rather than a literal.
5. `services/orchestrator/src/modules/runtime/metadata-crypto.ts` — ensure the central text/read helpers enforce the selected policy even when the crypto seam is absent or the stored type is invalid; keep valid envelope opens fail-closed.

If A2 is implemented as a separate boot-config value rather than a policy carried by the crypto seam, the existing composition chain also has no such field and will need wiring: `services/orchestrator/src/modules/encryption/boot-options.ts`, `services/orchestrator/src/main.ts`, `services/orchestrator/src/server.ts`, `services/orchestrator/src/app/bootstrap/create-app.ts`, and `services/orchestrator/src/http/route-context.ts`. Whether all five are required depends on the control shape dsh_3 defines; none currently supplies a plaintext-window value.

### When the window closes

The guaranteed direct-call closure set is the same five files above: remove every literal `true` from `public.ts:542`, `runtime.ts:1206,1818,453`, `mappers.ts:107`, and `ingestion-consumer.ts:664`; ensure the shared check defaults/requires false; and close the no-seam/raw-string bypasses at `metadata-crypto.ts:357-358`, `runtime.ts:452`, and `ingestion-consumer.ts:318,658`. The already-false calls at `runtime.ts:357-361`, `ingestion-consumer.ts:325-329`, and `metadata-crypto.ts:371` remain false. If the central permission was boot-configured, also remove/force it off through the same five boot/context files listed above; a config flip alone does not correct the hard-coded caller values or bypasses.

## 5. Source-only check record

- Grepped every `readStoredText`, `readStored`, and `allowPlaintext` occurrence under `services/orchestrator/src` and read the caller functions, route guards, and composition path.
- Counted all production source invocations, including the two calls in `ingestion-consumer.ts` that a narrow grep of only `runtime.ts`/result readers would miss.
- No tests or live services were run. This inventory is independent source evidence and leaves A2/window semantics to the separate design owner.

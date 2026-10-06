# ALLOWPLAINTEXT-CONTROL-PLANE — 2026-10-05

**Task:** `task_dc32a1d9b5a3` / dispatch `ctx_2e0186a56569`
**Scope:** source-only control-plane design for the third ENCMETA-WINDOW-DESIGN-803 workstream. This recommends a centralized policy shape; it does not define the other lane's window dates or run a migration. No source or tests were changed or run.

## Finding

All plaintext decisions are currently local boolean arguments. No boot/config value controls them. Several paths return or continue with raw values before any boolean check, so changing literals alone would not close the behavior end-to-end. Recommended design: one immutable, boot-composed `MetadataReadPolicy`, default deny, with a narrowly scoped result-projection compatibility mode; all plaintext decisions go through one reader façade that exists even when encryption is not configured.

## 1. Current literal inventory

`rg -n 'allowPlaintext|readStoredText|readStored\\(' services/orchestrator/src -g '*.ts'` found these production literal decisions. `readStoredText`'s final argument is `allowPlaintext`; direct `readStored` callers supply the third argument.

| File:line | Current value | Purpose | Current source |
|---|---:|---|---|
| `modules/runtime/runtime.ts:360` | `false` | Opens the pinned prompt-override carrier before worker claim; rejects a plaintext carrier. | Hard-coded. |
| `modules/runtime/runtime.ts:453` | `true` | Generic `openMetadata` helper used for worker claim material, child-spawn idempotency/replay, and parent continuation data (`runtime.ts:1025, 1828, 1892, 1903, 1933, 1973`). | Hard-coded in helper; callers cannot narrow it. |
| `modules/runtime/runtime.ts:1206` | `true` | `getChildren` result projection for the authenticated runtime GET (`runtime.ts:1202-1207`; route auth `http/routes/runtime.ts:457-463`). | Hard-coded. |
| `modules/runtime/runtime.ts:1818` | `true` | Opens sibling result refs before merging `joinSummary` and persisting/queuing parent continuation (`runtime.ts:1814-1847`). | Hard-coded. |
| `http/routes/public.ts:542` | `true` | Public operation-result GET projection after API-key and tenant checks (`public.ts:478-488, 538-543`). | Hard-coded. |
| `modules/operations/mappers.ts:107` | `true` | Admin operation-detail result projection after principal/resource checks (`public.ts:449-455`; mapper `mappers.ts:103-108`). | Hard-coded. |
| `modules/operations/ingestion-consumer.ts:329` | `false` | Opens a sealed dispatch source URL before acquisition (`:325-332`). | Hard-coded; raw strings return before this at `:318`. |
| `modules/operations/ingestion-consumer.ts:664` | `true` | Opens task payload before processing action/source and starting acquisition/materialization (`:657-680`). | Hard-coded. |
| `modules/encryption/metadata-auth-counter.ts:191` | `false` | Authenticates non-null text-column envelopes during the metadata plaintext/broken-envelope counter (`:181-205`). | Hard-coded strict check. |
| `modules/encryption/metadata-auth-counter.ts:197` | `false` | Same counter for parsed/json values. | Hard-coded strict check. |
| `modules/runtime/metadata-crypto.ts:371` | `false` | Internal `readStoredText` delegation after recognizing a sealed JSON envelope (`:350-372`). | Hard-coded strict envelope open. |

The API itself encodes the decision: `MetadataCrypto.readStored(..., allowPlaintext)` at `modules/runtime/metadata-crypto.ts:192-199`, implementation at `:322-334`; `readStoredText(..., allowPlaintext)` at `:350-372`. There is no environment variable or `ServerConfig` field for this flag. `boot-options.ts:49-56,243-276` currently resolves crypto/key options only; `main.ts:148,181-186` passes those options to `createApp`; `server.ts:242-256` has only the `metadataEncryption` block.

## 2. Recommended central control

Use a process-boot, immutable `MetadataReadPolicy`, created once and injected everywhere. Do not use a DB/UI toggle or a caller-provided boolean: the policy affects worker execution and result disclosure, and should have one deployment-controlled value for the entire process lifetime.

Proposed boot value (new; no such setting exists today): `METADATA_PLAINTEXT_READ_MODE` with a closed enum:

- `deny` — default when unset; legacy plaintext is rejected everywhere.
- `read-only-results` — explicit, temporary compatibility allowance for the three authenticated result projections only: public operation result, admin operation detail, and runtime child-list result.

There is deliberately no `allow-all` mode. The central resolver permits plaintext only when **both** the mode is `read-only-results` and the caller supplies one of three typed projection purposes; it additionally checks the compatible result-ref slot (`operations.result_ref` or `tasks.result_ref`). Every other purpose—worker claim, replay/idempotency, continuation, ingestion/source acquisition, audit/authentication, unknown purpose, or unknown slot—denies plaintext in either mode. A call site names a typed purpose, never `true`/`false`; changing the environment cannot turn an execution read into a compatibility read.

Recommended shape:

```ts
type MetadataReadPurpose =
  | 'public-operation-result'
  | 'admin-operation-detail-result'
  | 'runtime-child-result-list'
  | 'execution'; // all claim/replay/continuation/ingestion/auth reads

type MetadataPlaintextReadMode = 'deny' | 'read-only-results';
```

`MetadataReadPolicy` owns the purpose/slot allowlist and mode evaluation. A single `MetadataReader` façade owns `readStored` and `readStoredText`, taking the immutable policy and an optional decryptor internally. The façade is always composed, even when `metadataEncryption` is absent; the underlying crypto capability may be optional, the plaintext policy may not. Keep `MetadataCrypto.readStored` as strict envelope-only decryption (remove its boolean), and route mixed legacy/envelope values through the façade. The boot layer validates the enum and emits one startup warning when `read-only-results` is open; request data cannot alter the mode.

Why this control: it is one auditable source of decision, cannot be bypassed by a `true` in a caller, can distinguish read-only projection from execution even when both use `tasks.result_ref`, defaults closed, and can retain only the compatibility that has an explicit product need. It also fits the existing one-instance composition point at `app/bootstrap/create-app.ts:295-325`.

## 3. End-to-end enforcement (close the early-return gaps)

The central façade must decide before any raw-value return or coercion:

1. For text values, allow `null`/`undefined` as absence; reject other non-string values instead of `String(value)` (`metadata-crypto.ts:356-357`). Parse string JSON. A recognized sealed envelope must go through the decryptor and fail with a typed crypto error if crypto/key material is absent. Any non-envelope string/value must pass `MetadataReadPolicy` before it is returned.
2. Remove `readStoredText`'s `if (!crypto) return value` at `metadata-crypto.ts:358`. With no decryptor, plaintext can be returned only for an approved projection under the central mode; an envelope must fail closed.
3. Replace `runtime.ts:452-453`'s `if (!crypto) return value` plus `readStored(..., true)` with the always-present reader and `execution` purpose. The six generic callers remain strict, independent of result-view compatibility.
4. Route both ingestion branches through the same façade: the raw string shortcut at `ingestion-consumer.ts:318` must not reach URL acquisition without a policy decision; the `if (metadataCrypto)` branch at `:658-665` must not skip the open when crypto is absent and leave `parsedEnvelope` in use. Both are execution-purpose reads and reject legacy plaintext before network/storage side effects.
5. `metadata-auth-counter.ts:169-178` may continue reporting non-null rows as plaintext when there is no decryptor; its actual open attempts remain strict. Remove its boolean arguments when the crypto API is narrowed, and keep the counter observational (not a runtime plaintext grant).

This closes the wrapper bypasses as well as the literals. A grep showing no `true` is insufficient unless the no-decryptor, wrong-type, raw-string and envelope-without-key cases are also tested.

## 4. File impact and rollout

### A2 enablement / first policy deployment

The minimum wiring and enforcement file set is:

1. **New** `services/orchestrator/src/modules/runtime/metadata-read-policy.ts` — typed purpose, mode enum, centralized purpose/slot decision, and always-present reader façade.
2. `services/orchestrator/src/modules/encryption/boot-options.ts` — parse and validate the new deployment mode; default to `deny`.
3. `services/orchestrator/src/main.ts` and `services/orchestrator/src/server.ts` — pass the value through typed boot/config, with a one-time warning for `read-only-results`.
4. `services/orchestrator/src/app/bootstrap/create-app.ts` and `services/orchestrator/src/http/route-context.ts` — construct one policy/reader regardless of `metadataEncryption`, then inject it into runtime, HTTP routes, and ingestion.
5. `services/orchestrator/src/modules/runtime/metadata-crypto.ts` — strict decryptor API plus policy-aware façade/helper; no early raw return.
6. Callers to migrate off literals/bypasses: `services/orchestrator/src/http/routes/public.ts`, `services/orchestrator/src/modules/operations/mappers.ts`, `services/orchestrator/src/modules/runtime/runtime.ts`, `services/orchestrator/src/modules/operations/ingestion-consumer.ts`, and `services/orchestrator/src/modules/encryption/metadata-auth-counter.ts`.

These files must ship as one behavior-complete release; do not deploy the boot setting before every production reader uses it. Before that release, authenticate/count stored refs and backfill or drain all plaintext execution inputs (`operations.input_ref`, `tasks.payload_ref`, checkpoints, prompt carriers, and pending ingestion/outbox payloads). Leave only the approved result refs plaintext if using `read-only-results`. If the execution-input preflight is not clean, defer this fail-closed release rather than add an execution-purpose exception.

Deploy with `deny` if the result-ref gate is clean. Otherwise, an authorized deployment owner may explicitly select `read-only-results` for the bounded compatibility period. Verify startup mode, typed denial metrics, and worker/API health. Re-run the authentication counter/backfill gate for allowed result slots; when those rows are sealed or absent, change the single boot value to `deny` and restart/canary. A closed mode requires no call-site edit because every reader already consults the policy.

Rollback is policy-limited: if only result projections regress because legacy refs remain, an authorized operator can restore `read-only-results` and restart; this still cannot admit plaintext into execution/ingestion. If the release itself must be reverted, revert only to a crypto-capable, policy-aware build while retaining key configuration. Do not send ciphertext written by the new build to a pre-ENCMETA binary, and do not add an unrestricted plaintext fallback as an emergency rollback. Keep the schema/data intact; fix or re-run backfill forward.

### Window closure

No call-site source edits should be needed to close the window: set `METADATA_PLAINTEXT_READ_MODE=deny`, restart the same policy-aware release, then verify result reads do not encounter plaintext and the authenticated counter reports no eligible legacy result refs. Once the data is fully sealed and rollback period ends, a later cleanup may remove the `read-only-results` enum branch from `metadata-read-policy.ts` and its boot parser in `boot-options.ts`; that cleanup is not required for closure.

## 5. Small implementation-ready packets

Packets are implementation work units, not independent deployment stages; release together after the data preflight.

| Order | Packet and lease | Offline acceptance | User-gated part |
|---|---|---|---|
| 1 | **Policy + boot wiring** — new `modules/runtime/metadata-read-policy.ts`; `modules/encryption/boot-options.ts`; `main.ts`; `server.ts`; `app/bootstrap/create-app.ts`; `http/route-context.ts`. | Mode parser accepts only `deny`/`read-only-results`; unset is `deny`; invalid value fails boot; exactly one warning for open mode; same reader injected with and without `metadataEncryption`. | Deployment owner approves selecting `read-only-results` and the expiry/closure point. |
| 2 | **Reader boundary/API** — `modules/runtime/metadata-crypto.ts`. | Policy matrix for purpose × mode × slot; absent crypto cannot bypass; sealed-without-key denies; wrong text type denies; no boolean API remains. | None for offline tests. |
| 3 | **Projection callsites** — `http/routes/public.ts`; `modules/operations/mappers.ts`; `modules/runtime/runtime.ts` (`getChildren` path). | Each uses its typed projection purpose; compatibility mode admits only result refs; `deny` rejects plaintext; authentication/resource tests remain intact. | Enabling the mode for real legacy refs is user/deployment-owner gated. |
| 4 | **Execution and ingestion callsites** — `modules/runtime/runtime.ts` (`openMetadata` and join path); `modules/operations/ingestion-consumer.ts`. | Plaintext claim/replay/continuation/source/task payload fails before queue, network or storage side effect, with or without crypto configured; sealed values still decrypt. | Live activation is gated on backfill/drain proof for execution slots and queued work. |
| 5 | **Counter/API cleanup** — `modules/encryption/metadata-auth-counter.ts` plus focused existing tests. | Counter still classifies/authenticates all refs; false arguments removed; counts do not change policy. | Running the gate against production DB / authorizing live data backfill is operator-gated; tests stay offline. |

Suggested focused tests: policy matrix; `readStoredText` with crypto absent, plaintext, malformed JSON/envelope, wrong type and sealed value; generic runtime reads with both modes; ingestion's raw string and absent-crypto branches fail before side effects; route result projection behavior; boot default/invalid/open warning; authentication counter still distinguishes valid, plaintext and broken envelopes. No test should use a real DB, Vault, network fetch or provider.

## Source check record

- Re-grepped every `readStoredText`, `.readStored(`, and `allowPlaintext` occurrence under `services/orchestrator/src` and read the helper, all callsites, boot options, `main.ts`, `ServerConfig`, app composition and route context.
- Confirmed no current config/boot option centrally controls plaintext acceptance; current `true`/`false` values are callsite literals.
- No source/tests were modified; no tests, services, DBs, Vault, or live deployment were run.

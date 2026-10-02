# Webhook URL wire contract — legacy vs rework (2026-10-01)

**Scope:** read-only characterization of request acceptance, outbound JSON, status handling, timeout/retry behavior, and delivery encryption. No source changes or gate updates were made.

## 1. Legacy receiver payload: the actual JSON sent

Legacy `webhook_url` notifications are JSON `POST`s with `Content-Type: application/json`; no HMAC/signature or delivery-id header is added (`lib/pipelines/engine.ts:72-80`; workflow `lib/pipelines/workflow-engine.ts:295-311`). The payload is not the operation result, extracted content, usage, or full operation row. The exact common fields and engine-specific branches are:

| Legacy path | Exact body shape | Source |
|---|---|---|
| Normal pipeline succeeds | `{"operation_id":"<operation UUID>","state":"SUCCEEDED","done":true}` | `lib/pipelines/engine.ts:427-437` |
| Normal pipeline fails | `{"operation_id":"<operation UUID>","state":"FAILED","error":"<error message>"}`; this engine branch does **not** include `done` | `lib/pipelines/engine.ts:450-478` |
| Workflow succeeds | `{"operation_id":"<operation UUID>","state":"SUCCEEDED","done":true}` | `lib/pipelines/workflow-engine.ts:216-244,295-315` |
| Workflow fails | `{"operation_id":"<operation UUID>","state":"FAILED","done":true,"error":"<error message>"}` | `lib/pipelines/workflow-engine.ts:274-292,295-315` |
| Workflow pauses for user input | `{"operation_id":"<operation UUID>","state":"PAUSED","done":false,"error":"<pause message>"}`; `PAUSED` is passed through an `as any` cast despite the helper's narrower state type | `lib/pipelines/workflow-engine.ts:246-272,295-315` |

Thus clients may see different failure JSON from a normal pipeline and a workflow. `webhookSentAt` is the only legacy delivery marker on the operation row (`lib/db/schema.ts:35-36`); the row also stores `webhookUrl` as text (`schema.ts:35`).

## 2. Legacy response status, retry, timeout, and failure behavior

### Normal pipeline engine

- Each attempt is a `POST`; only `res.ok` (HTTP 2xx) counts as delivered. Non-2xx statuses and thrown network errors are logged and retried (`lib/pipelines/engine.ts:72-90`).
- There are at most **3 attempts**, each with `AbortSignal.timeout(10_000)`. Backoff sleeps are `1s` after attempt 1 and `2s` after attempt 2. A timeout is caught like a network error and consumes that attempt; worst-case elapsed time is about 33 seconds plus overhead.
- On success, `webhookSentAt` is set. After all attempts fail, it logs an error and leaves `webhookSentAt` unset. Webhook failure does not reverse the already-written `SUCCEEDED`/`FAILED` operation state (`engine.ts:397-440,450-480`). Delivery is awaited inline by the pipeline worker; it is not a durable independent retry queue.

### Workflow engine

- It performs one `await fetch(...)`, with no abort signal/timeout, no response-status check, and no retry (`lib/pipelines/workflow-engine.ts:295-318`).
- Any returned HTTP response, including 4xx/5xx, is treated as “sent” and sets `webhookSentAt`; only a rejected fetch is caught and logged. With no configured timeout, a request that never returns headers can hold the workflow worker indefinitely.
- Workflow send errors do not change the terminal operation state. The notification is awaited by the workflow path. The pause branch also sends a notification, as shown above.

## 3. Rework contract and encryption delta

### Plaintext logical payload

For a terminal operation with a callback URL, `maybeScheduleWebhook` builds this strict logical payload and stores it in `webhook_deliveries.payload`:

```json
{
  "deliveryId": "<generated delivery UUID>",
  "eventType": "operation.succeeded | operation.failed | operation.cancelled | operation.timed-out",
  "operationId": "<operation UUID>",
  "state": "SUCCEEDED | FAILED | CANCELLED | TIMED_OUT",
  "stateVersion": 1,
  "occurredAt": "<operation updated_at as ISO-8601>"
}
```

The code constructs these fields from terminal state and the operation row; it does not add legacy `done`, `error`, result, output, or usage fields (`services/orchestrator/src/modules/webhooks/webhooks.ts:33-47,59-100`). `WebhookPayloadSchema` is strict and defines exactly the six fields shown (`packages/contracts/src/public-api.ts:646-664`). Migration `0007` stores `payload jsonb` in `webhook_deliveries`, with delivery status, attempts, `max_attempts`, and `next_at` (`services/orchestrator/migrations/0007_webhook_deliveries.sql:7-32`); that DB payload is plaintext JSON even when the later wire body is encrypted.

### Actual body and authentication on the wire

When tenant delivery encryption is enabled, the dispatcher serializes the logical JSON, encrypts it, and sends the following outer JSON instead:

```json
{
  "schemaVersion": "1",
  "encrypted": true,
  "delivery": {
    "version": 1,
    "suite": "hpke-rfc9180 | rsa-oaep-sha256",
    "recipientKeyId": "<recipient key id>",
    "recipientKeyVersion": 1,
    "enc": "<base64 wrapped/encapsulated DEK>",
    "nonce": "<base64 GCM nonce>",
    "tag": "<base64 GCM tag>",
    "ciphertext": "<base64 encrypted WebhookPayload>"
  }
}
```

The contract permits optional `aad`, but the current delivery encryptor does not emit it (`packages/contracts/src/encryption.ts:168-209`; `services/orchestrator/src/modules/public-api/delivery-encryption.ts:230-258`). `buildWebhookBody` implements the wrapper at `webhooks.ts:197-223`.

The POST still uses `Content-Type: application/json`; it also carries `x-du-signature`, `x-du-timestamp`, and `x-du-delivery-id` (`webhooks.ts:446-459`; header constants `packages/contracts/src/public-api.ts:666-673`). The signature is HMAC-SHA256 over `timestamp + "." + exact serialized body`, so under enabled encryption it authenticates the encrypted outer body the receiver actually receives (`webhooks.ts:106-109,435-459`).

**Receiver compatibility:** an unmodified legacy receiver cannot consume the encrypted delivery contract. It can parse the outer JSON syntactically, but the expected `operation_id`, `state`, `done`, and possibly `error` fields are not at the top level; it has no decrypt step. After decryption, the logical payload still differs from legacy: camelCase fields plus `deliveryId`, `eventType`, `stateVersion`, and `occurredAt`, with no `done` or `error`. Thus there is a wire-shape mismatch even with encryption disabled, and enabled encryption adds a second, decisive incompatibility. This states compatibility behavior; it does not propose plaintext downgrade or a bypass.

When the tenant policy is enabled but key resolution/encryption fails, `buildWebhookBody` throws, the dispatcher records `WEBHOOK_ENCRYPTION_FAILED`, and sends **no HTTP request**; that failure consumes the normal delivery retry budget (`webhooks.ts:205-223,236-243,435-445,521-536`). There is no plaintext fallback on an enabled-but-failing encryption path. The current implementation sends the rework logical payload as plaintext JSON when no delivery-encryption service is wired or the tenant policy is absent/disabled (`webhooks.ts:173-179,210-222`; server passes the configured service at `server.ts:507-509,913-923`). That is existing server-side policy behavior, not an encryption-failure fallback, and the plaintext shape is still not the legacy shape above.

### Rework status, attempts, timeout, and operation state

- Only 2xx is success; all other HTTP statuses are failures (`webhooks.ts:460-461`). Success marks the delivery `DELIVERED`; transport, destination, HTTP, or encryption failure retries and eventually marks the delivery `FAILED` (`webhooks.ts:515-538`). The operation is already terminal and delivery failure does not alter its operation outcome (`webhooks.ts:18-25,304-311`; server wiring comment `server.ts:905-907`).
- Migration defaults are `attempts=0`, `max_attempts=5`, `status=PENDING`, and `next_at=now()` (`0007_webhook_deliveries.sql:18-25`). The default backoff base is 1,000 ms; a failed attempt schedules `base * 2^attempts`, yielding nominal 1s, 2s, 4s, and 8s waits before attempts 2–5. The fifth failed attempt marks the delivery `FAILED` (`webhooks.ts:343-345,521-536`). The production dispatcher sweeps every 5 seconds by default when auto-dispatch and a webhook signing secret are configured (`services/orchestrator/src/server.ts:693-695,905-929`), so actual retry time is also gated by the next sweep.
- A dispatch has a 10-second default timeout (`webhooks.ts:317-342`); timeout/network failure consumes an attempt. Graceful shutdown may return an in-flight claim to `PENDING` without consuming an attempt if dispatch was not completed (`webhooks.ts:420-424,504-513`).
- Durable rows are scheduled in the same transaction as a terminal transition and deduplicated by operation/state version/destination (`webhooks.ts:49-100`; migration `0007:27-32`). The background sender is at-least-once; receivers deduplicate by `deliveryId` (`webhooks.ts:18-25`).

## 4. Where `webhook_url` enters and how it is validated

| Surface | Accepted field | Validation and destination policy |
|---|---|---|
| Legacy API | Multipart form field `webhook_url`; `lib/endpoints/runner.ts:225-248` reads `form.get('webhook_url') as string \| null`, then passes it as `webhookUrl` into `submitPipeline`. `lib/pipelines/submit.ts:37-49,73-88,299-315` stores it in `operations.webhookUrl`; schema is a nullable text column (`lib/db/schema.ts:35`). | The runner cast and submit path do not parse it as a URL or adjudicate its destination. Legacy engines pass it directly to `fetch` (`engine.ts:75`, `workflow-engine.ts:307`). |
| Rework canonical submission | JSON field `callback: { "url": "..." }`; `SubmissionSchema` is strict and has `callback`, not top-level `webhook_url` (`packages/contracts/src/operations.ts:264-293`). | `CallbackConfigSchema` requires Zod `.url()` syntax and runs `adjudicateUrlDestination`, rejecting statically denied schemes/userinfo/literal destinations. A public hostname remains `NEEDS_RESOLUTION`; the dispatcher resolves/re-adjudicates it before delivery (`operations.ts:258-278`; `webhooks.ts:267-295,426-434`). |
| Rework compatibility decoder | `webhook_url` and `webhookUrl` aliases are read from legacy raw fields; canonical `callback` is also accepted by `decodeLegacyWire` (`services/orchestrator/src/compat/legacy-wire-decoders.ts:183-193,202-215`). `decodeCallback` maps `webhook_url` to `{url: ...}` and checks only that its value is a string (`:427-439`). If an alias and `callback` are both present, the legacy alias wins; conflicting `webhook_url` vs `webhookUrl` aliases are rejected by alias selection (`:191-193,427-438`). | The decoder itself does not URL-parse or apply destination policy. If its output reaches `createSubmissionService`, `SubmissionSchema.safeParse` adds canonical URL and static destination validation (`modules/operations/submission.ts:143-154`). DNS/private-destination policy is checked again at actual delivery. `createLegacyActionRouter` calls this decoder (`compat/legacy-action-router.ts:391-429`), but no instantiation/mount of `createLegacyActionRouter` was found in `services/orchestrator/src/server.ts`; treat this as implemented compatibility code, not proof that `/api/v1/docs/*` is currently mounted in the production server. |

## Contract mismatch summary

1. Legacy normal pipeline bodies are snake_case status notifications and omit result/output; workflow failure and pause add different fields. Rework's logical body is a strict six-field event payload in camelCase.
2. Encryption enabled wraps that event payload in `{schemaVersion, encrypted, delivery}`; a legacy receiver cannot consume it and there is no request header/parameter to bypass encryption.
3. Rework authenticates the exact wire body with HMAC headers; legacy sends no signature metadata.
4. Legacy runner accepts `webhook_url` as an unvalidated multipart string. Rework's canonical contract is `callback.url` with both URL syntax and static destination validation; its compatibility decoder only type-checks before delegating to canonical submission validation.
5. Legacy normal pipelines retry three times synchronously with 10-second per-attempt timeout; workflow deliveries have no status check, retry, or timeout. Rework uses durable five-attempt delivery rows, exponential backoff, and a 10-second dispatch timeout.

No compatibility or encryption policy decision is made by this characterization.

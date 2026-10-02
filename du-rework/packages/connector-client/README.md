# Connector Client

`@du/connector-client` là typed client cho Connector internal API: invoke, replay,
poll, cancel và wait. Nó nói chuyện với **Connector**, không phải với provider —
không có adapter provider nào nằm trong package này.

## Purpose

Typed invocation, replay, pending/poll, error classification và cancellation facade.

## Boundary

Chỉ phụ thuộc `@du/contracts`. Không import source của Connector, không đụng
platform DB, không implement provider adapter, và không retry vượt policy runtime.

## Structure

| File | Vai trò |
|---|---|
| `src/types.ts` | Public types: request/result, `ConnectorTransport`, access options |
| `src/errors.ts` | `ConnectorClientError` và error classification |
| `src/transport.ts` | `createHttpTransport()` — HTTP transport, bearer + `x-invocation-grant`, bounded timeout (mặc định 120s) |
| `src/client.ts` | `ConnectorClient`: `invoke`, `replay`, `poll`, `cancel`, `wait` |
| `src/contracts.ts` | Wire mapping sang shape của Connector |
| `src/sdk-invoker.ts` | `createSdkConnectorInvoker()`, cầu nối SDK ↔ client cho worker |

## Behaviour worth knowing

- **Transport không bịa outcome.** Fetch bị reject lên `INVOCATION_UNKNOWN`
  (status 0, retryable) để caller reconcile qua `invocationId` ổn định, thay vì retry
  mù vào provider. Phân loại dựa trên HTTP status (429/5xx/status 0 tách khỏi
  permanent) chứ không sniff message text.
- `Client.unwrap()` throw `ConnectorClientError` khi state là `failed` hoặc
  `unknown`; `pending` trả về bình thường.
- `wait()` poll tới khi state khác `pending`, ném `PROVIDER_TIMEOUT` khi vượt
  `deadlineAt`.
- Grant theo invocation được cache process-local; `resolveInvocationGrant` cho phép
  làm mới sau khi grant hết hạn.

## Build & Test

```bash
pnpm --filter @du/connector-client build
pnpm --filter @du/connector-client lint
pnpm --filter @du/connector-client test
```

## Read first

- [08-connector-api](../../docs/08-connector-api.md)
- [09-queue-sdk](../../docs/09-queue-sdk.md)

## Task packets

- [P3-connector](../../tasks/P3-connector.md)

## Handoff requirements

Business/use-case doc → interfaces → function design → test cases → implementation → evidence. Source chỉ ở subproject này; shared contract/root lockfile qua integration owner.


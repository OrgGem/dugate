# ADR-001: Async provider polling contract

- **Status:** Accepted for the current Connector adapter surface
- **Date:** 2026-09-24
- **Owner:** `services/connector`

## Context

An HTTP `202 Accepted` response means a provider accepted work; it does not
define how the caller retrieves its eventual result. Providers may return the
current state when the same request is replayed with an idempotency key, or
they may require a distinct status endpoint and provider request ID. Treating
these protocols as interchangeable can create duplicate jobs, lose results,
or send credentials to an untrusted URL.

## Decision

The generic `json-http` adapter supports one asynchronous mode:
`idempotency-key-replay`. Both the adapter and connector revision must declare
that mode before a `202` is accepted. The connector replays the original POST
with the same `invocationId` as its `Idempotency-Key`; the provider contract
must deduplicate that key and return the current state or terminal result.
The response must include a valid `nextPollAt`; an optional
`providerRequestId` is persisted for audit/reconciliation. Poll attempts are
bounded by the invocation deadline and the connector's configured attempt
budget.

The generic adapter does **not** follow a provider-supplied URL and does not
issue `GET status/{providerRequestId}`. A provider that requires a separate
status endpoint is unsupported by this adapter. A `202` without the explicit
replay declaration fails closed with `CAPABILITY_UNSUPPORTED`.

## Consequences

- The P4-08 mock provider proves only the declared POST-replay mode; it is not
  evidence that GET-status providers are supported.
- Provider-specific status polling requires a separately reviewed adapter
  contract covering status URL construction, host allowlisting, credential
  handling, response validation/mapping, retry and deadline behavior, and
  durable storage of the provider handle before dispatch can be considered.
- Until that contract and implementation exist, configuration for a provider
  requiring a distinct status endpoint must not opt into
  `idempotency-key-replay`.

## Revisit trigger

Reopen this decision when an in-scope provider requires a distinct status
endpoint and its API contract, authentication model, and result schema are
available for implementation and live acceptance.

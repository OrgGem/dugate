# COMP-03b D2 — Strict input decoder hardening

## Changes

- `services/orchestrator/src/compat/legacy-input-decoders.ts:157-180` expands the forbidden identity-header names to include `authorization` and body-style identity spellings. Header matching lowercases both the incoming name and each deny-list entry (`:358-367`), then throws `IDENTITY_FIELD_FORBIDDEN` with the message that identity resolves from `x-api-key` (`:368-372`). This also handles a native `Headers` bag (`:359-364`).
- The request decoder now checks query keys before collecting body/form fields (`:263-266`). Only `sync` is accepted; unknown query keys fail with `UNKNOWN_FIELD` (`:377-400`). Both plain query objects and `URLSearchParams` are checked; `sync` remains read by the existing execution path (`:336-339`, `:575-586`).
- `services/orchestrator/tests/compat-decoders.test.ts:239-282` adds tests for `type` as an extra field on `generate`, unknown query rejection, and the exact `sync` allow-list. The existing six orphan-field names were left unchanged (`:226-237`). Header tests now cover authorization, body-style identity spellings, case variants, and a native `Headers` instance (`:358-380`).

## Query allow-list evidence

I searched `lib/endpoints/registry.ts`, `lib/endpoints/runner.ts`, and the legacy ingest/extract route handlers. The core runner reads only `sync` from the request URL (`lib/endpoints/runner.ts:70,229`); the registry parameter declarations are attached to action variants as request/body parameters, with no query parameter declared (`lib/endpoints/registry.ts:39-383`). Other query consumers found by the repository search belong to distinct routes, including operations listing, billing usage, internal analytics, and settings; they are not the core action decoder's request contract. Therefore the decoder allow-list remains exactly `{ sync }`.

## Hard checks retained

- `x-api-key-id` is still rejected (`compat-decoders.test.ts:347-356`); the legitimate `x-api-key` remains accepted and is not copied into decoded output (`:382-393`). No API-key selection, ADMIN fallback, or bearer fallback was added.
- Unknown body fields still fail closed (`:218-224`). The new non-extract `type` test confirms it is rejected as `UNKNOWN_FIELD` (`:239-246`).
- The serializer was not edited. Tests continue to map supplied canonical `CANCELLED` and `TIMED_OUT` values to the legacy vocabulary (`:445-463`) and cover that no terminal state is fabricated (`:466-493`).
- No route was mounted and no COMP row or release gate was changed.

## Verification

Run from `services/orchestrator`:

```text
npx jest --runInBand tests/compat-decoders.test.ts
Test Suites: 1 passed, 1 total
Tests:       46 passed, 46 total
ExitCode: 0
```

The starting receipt recorded 43/43 tests; this run adds three test cases and reaches 46/46.

Run from `du-rework`:

```text
npx tsc --noEmit -p services/orchestrator/tsconfig.json
ExitCode: 0
```

## Diff summary

Only the leased decoder and its test file were changed: `services/orchestrator/src/compat/legacy-input-decoders.ts` and `services/orchestrator/tests/compat-decoders.test.ts`. This receipt is the only additional file created for this packet.

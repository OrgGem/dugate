# CB-01 — Profile callback contracts & schema freeze — receipt

Task: `CB-01` under `tasks/PROFILE-CALLBACK-2026-10-06.md`. Owner: OpenCode 1 (`oc_1`), profile/contracts owner.
Date: 2026-10-06. No commit, no push.
Status: **contract freeze IMPLEMENTED + offline tests green; CB-02/03/04/05 and VFY-CB-01 stay OPEN.** This packet
freezes the interface only — no dispatcher, token-cache, Portal, migration or wire behavior was changed.

## 1. What was frozen

`packages/contracts/src/profile-callback.ts` (exported via `packages/contracts/src/index.ts`):

| Area | Frozen artifact |
|---|---|
| Modes | `CallbackModeSchema`: `notification_only` \| `notification_with_result`; absent policy preserves the legacy notification-only delivery (`CALLBACK_DEFAULT_MODE`) |
| Auth | `CallbackAuthSchema` union: `none`, `configured_headers` (managed-secret refs + optional literal prefix), `oauth2_client_credentials` (`grant_type` literal, HTTPS token URL, client id, client-secret ref, `client_secret_basic`/`client_secret_post`, scope, audience/resource, bounded extensions, optional `tokenLifetimeSeconds`; lifetime omitted ⇒ per-delivery, never indefinite caching) |
| Secrets | `CallbackSecretRefSchema`: opaque `managed-secret` path only — no value, no URL, write-only; resolved by the secrets owner with rotation/revocation |
| Destination restriction | `CallbackDestinationAuthorizationSchema` (exact approved `https://host[:port]` origins + optional path prefixes) and `authorizeCallbackDestination(url, auth, authorization)`: credential-bearing delivery requires an approved origin; HTTPS enforced; loopback/private/metadata denied via the shared `adjudicateUrlDestination`; `CALLBACK_REDIRECTS_ALLOWED = false` |
| Header safety | Reserved/sensitive header table (`authorization`, `host`, `content-length`, `content-type`, hop-by-hop, `x-du-signature/timestamp/delivery-id`), case-insensitive duplicate rejection, CRLF/NUL rejection, bounded name/value lengths (`isReservedCallbackHeader`) |
| Result projection | `CallbackResultEnvelopeSchema` (`projectionVersion '1'`, event type incl. failed/cancelled/timed-out, result or explicit `resultOmitted` reason OVERSIZED/EXPIRED/UNAVAILABLE/ENCRYPTED_ONLY) + `CallbackArtifactDescriptorSchema` (authenticated relative `/api/v1/...` download path + `expiresAt`, no bytes, no raw storage URLs); bounds `CALLBACK_MAX_INLINE_RESULT_BYTES` 256 KiB, `CALLBACK_MAX_DELIVERY_BODY_BYTES` 512 KiB, max 32 descriptors, `callbackInlineResultWithinBound` |
| Precedence | `resolveEffectiveCallbackPolicy({profileDefault, endpointPolicy})`: endpoint overrides profile default; both absent ⇒ `null` (legacy behavior) |
| Snapshot / versioning | `ProfileCallbackPolicySnapshotSchema` pins tenant/profile/endpoint (`endpointKey` = canonical action or endpointSlug)/`profileRevision`/policy; policy carries `version: CALLBACK_POLICY_VERSION` for CAS/versioning |

## 2. Changed paths and hashes

| File | SHA-256 |
|---|---|
| `packages/contracts/src/profile-callback.ts` (new) | `0373F3E8BBE5D4650B144786D2F6F5BED4CF04E64BBB91A490FF8B0EFB923F98` |
| `packages/contracts/src/index.ts` (export line) | `41F1A54101C0618B1C9CBE5C33FA655AE3E4110D4A3CBBBCF16814B068F4A88D` |
| `packages/contracts/tests/profile-callback.test.ts` (new) | `7177829AEECE602861E9C5780E60302E4AD3CADDCCCEF47FC52D6AF95719F64F` |

No runtime file under `services/orchestrator/src/modules/profiles/**` was changed: CB-01 is the freeze, and adoption
belongs to CB-02 (delivery), CB-03 (auth/egress) and CB-04 (Portal). No migration is needed for a pure contract
freeze. `docs/21-openapi.json` untouched.

## 3. Test evidence (real runs, cwd `du-rework`)

| Command | Exit | Result | Log |
|---|---|---|---|
| `pnpm --filter @du/contracts exec jest --runTestsByPath tests/profile-callback.test.ts --verbose` | **0** | **16 passed / 16** | `coordination/reports/raw/cb-01/profile-callback-new-test.log` |
| `pnpm --filter @du/contracts build` | 0 | `tsc` clean | `.../contracts-build.log` |
| `pnpm --filter @du/contracts test` (full suite) | **0** | **29 suites / 553 tests passed** | `.../contracts-full-suite.log` |

Negative coverage (each maps to a parent-task test requirement): foreign/unapproved destination theft and private
IP/metadata denial; credential-bearing auth without approval; approved-origin path loophole; HTTP downgrade;
header injection (CRLF), reserved/signing header override, case-insensitive duplicates; OAuth2 reserved-form-field
override, non-snake extension names, >8 extensions, non-HTTPS/loopback token URLs, wrong grant or auth method;
secret value/URL masquerading as a ref; result envelope with `result=null` but no omission reason, `TRUNCATED`
reason (never truncate), oversized descriptor list, raw storage URL, embedded bytes, missing `expiresAt`; snapshot
with non-uuid tenant, revision 0 or policy missing auth; precedence endpoint-over-profile and legacy-null fallback.

## 4. Acceptance mapping (CB-01 row)

| Acceptance item | Status |
|---|---|
| Endpoint identity + precedence | `endpointKey` in the snapshot; `resolveEffectiveCallbackPolicy` (endpoint > profile > legacy null) with tests |
| Schema + CAS/versioning | `version` literal + discriminated policy; snapshot pins `profileRevision`; strict objects reject unknown keys |
| Snapshots | `ProfileCallbackPolicySnapshotSchema` (tenant uuid, business, profile, endpoint, revision, policy) |
| Secret refs | `CallbackSecretRefSchema` opaque managed refs; values never accepted |
| Destination restrictions | approved exact origins + optional path prefixes; credential auth requires approval; SSRF adjudication reused |
| Compatibility | absent policy ⇒ legacy notification-only (submission callback + HMAC unchanged); modes are opt-in per endpoint |
| Result size/expiry semantics | inline bound + explicit omission reasons + reference-only descriptors with `expiresAt`; no truncation, no raw URL, no embedded bytes |
| Tenant and override negatives | covered by the 16 focused cases above |

## 5. Limitations / handoff

- Runtime owners still must implement: dispatcher scheduling/encryption/at-least-once retry and result projection
  capture (CB-02); token fetch/cache/reacquire, redirect denial, destination pinning at connect time (CB-03);
  Portal editor and delivery view (CB-04); docs/OpenAPI regeneration (CB-05). `CALLBACK_REDIRECTS_ALLOWED = false`
  and `authorizeCallbackDestination` are contract decisions those owners must enforce on the wire.
- Provider-extension allowlisting beyond the reserved-field rejection is deployment/provider-specific; CB-03 owns
  it. `tokenLifetimeSeconds` omitted means acquire-per-delivery (bounded, no indefinite cache) — CB-03 implements.
- No live PG/HTTPS token/receiver flow is claimed; VFY-CB-01 owns that independent verification.
- Evidence hashes: `profile-callback-new-test.log`
  `B18881ACB919A33EB30DA739801FD8CBFD5C7110E13D3EA70CA002366399F44B`,
  `contracts-full-suite.log` `89C5FBF0EFF9DB0FD436AB1F8A4C6D742C8D549832DE65133D1A0E5E0DA4DF8C`,
  `contracts-build.log` `F7E1113A0CAF22697C7C28FFC2D2E8283A2D197285AFC2F906FCEB36CEC06C78`.
- Next: CB-02/03/04 build on separate leases against this frozen module; independent verify + Claude review before
  any acceptance. No commit/tick/push performed.

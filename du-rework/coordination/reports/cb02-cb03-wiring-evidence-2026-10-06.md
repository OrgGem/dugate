# CB-02 / CB-03 wiring & VFY-CB-01 evidence — B3/B4/C3 (2026-10-06)

- Task: B3/B4/C3 per Claude audit r4 (`coordination/reports/claude-audit-review-r4-2026-10-06.md`, §4/§6.1.3)
- Owner: OpenCode (oc_2) — Outbound Auth & Dispatch Integrator
- Constraints honored: no commit, no push. Product edits limited to the CB-02 admission path, the CB-03 composition seams and focused tests/migration listed below.
- Status: **B3 IMPLEMENTED; B4 dispatcher wiring VERIFIED + production composition seams ADDED; C3 dispatch evidence RECORDED (offline recorded IdP/receiver). Live VFY + SC-01 catalog value supply remain OPEN. No acceptance claim.**

## 1. B3 (CB-02) — production resolver + admission writer

The audit's gap: `operations.callback_policy` was read by the dispatcher but **nothing wrote it**, and the profile schema/read wire did not carry `callbackPolicy`.

| Step | Change |
|---|---|
| Profile policy write/read contracts | `packages/contracts/src/profile-policy.ts`: `ProfileEndpointPolicySchema.callbackPolicy` (nullable optional; absent = leave unchanged, null = clear) and `ProfileEndpointPolicyReadSchema.callbackPolicy` (nullable optional). Shape is the frozen CB-01 `ProfileCallbackPolicy`. |
| Persistence | New migration `0036_profile_callback_policy.sql`: `profile_bindings.callback_policy jsonb` (additive, `IF NOT EXISTS`, nullable). |
| Publish/read service | `modules/profiles/profiles.ts`: carry-forward semantics (explicit null clears, absent carries previous, client value validated 422), UPSERT column, active-row SELECT, `decodePolicy` exposes `callbackPolicy`; malformed stored value fails admission closed. `EffectiveProfile.pinned.profileName` added from the `profile_names` registry. |
| Admission writer | `modules/operations/submission.ts`: new `buildCallbackPolicySnapshot(profile, {tenantId,businessId,businessVersion,endpointKey})` → CB-01 `ProfileCallbackPolicySnapshot` (identity + revision + endpointKey = canonical action); written to `operations.callback_policy` in the submit transaction (NULL keeps legacy notification-only byte-identical). |
| Retry clone | `modules/operations/retry.ts`: the operations clone now copies `callback_policy` so a retried operation keeps its pinned callback. |
| Admin read wire | `modules/admin-read/profile-detail.ts`: SELECT + projection incl. `callbackPolicy`; `EMPTY_PROFILE_POLICY_READ.callbackPolicy = null`; malformed stored value reads as null and fails at the dispatcher's invalid-pin gate. |

Honest note: the snapshot's `profileName` falls back to the stable `profileId` when the `profile_names` registry has no row (legacy rows); the identity is still immutable and handler-validated.

## 2. B4 (CB-03) — dispatcher wiring, both modes × 3 auth types

Already materialized in `modules/webhooks/webhooks.ts` (hash matches CB-02 receipt prefix `19226078…`): pinned policy parse (absent/invalid/valid tri-state), destination authorization before credentials, `createOutboundAuthSession` + `dispatchWithAuth` (single 401 reacquire), HMAC headers preserved, `redirect: 'error'`, mode-specific payload. This pass **verified** that wiring and added the missing production composition:

- `src/server.ts`: `ServerConfig.resolveCallbackSecret` (`OutboundSecretResolver`) + `callbackOAuth2Options` (`OAuth2TokenClientOptions`).
- `src/app/bootstrap/create-app.ts`: both are forwarded to `deliverWebhooks(...)`; absent resolver keeps the fail-closed `WEBHOOK_AUTH_UNAVAILABLE` behavior for credential-bearing pins (`none`/legacy unaffected).

Remaining dependency (OPEN): the SC-01 secret catalog / SC-02 Vault resolver must supply the actual `resolveCallbackSecret` implementation at deployment; until then authenticated callbacks are correctly disabled, not silently unauthenticated.

## 3. C3 (VFY-CB-01) — recorded dispatch evidence

Raw evidence bundle: `coordination/reports/raw/cb02-cb03-wiring-2026-10-06/` (logs include literal exit codes in `exit-codes.txt`; hashes in `SHA256SUMS.txt`).

| Evidence | Result | Exit |
|---|---|---|
| `vfy-cb01-dispatch-matrix.log` — real dispatcher, scripted SQL, mock IdP + receiver: `notification_only` / `notification_with_result` × `none` / `configured_headers` / `oauth2_client_credentials`; signed body + delivery id; durable DELIVERED receipt; immutable payload; 401→reacquire; missing resolver fails closed before send | **8/8 passed** | **0** |
| `cb02-cb03-focused.log` — `cb02-admission-writer` (7) + `cb-02-webhook-result-delivery` (23) + `cb-03-outbound-auth` (20) | **50/50 passed** | **0** |
| `bff-sc04-m02.log` — BFF suite (admin-shell-server, aweb08, aweb02, aweb05, aweb07, admin-shell-router) | **130/130 passed** | **0** |
| Contracts focused (`packages/contracts`): `profile-callback.test.ts` + `profile-policy.test.ts` | **44/44 passed** | **0** |
| Orchestrator regression (cb02-admission-writer, vfy matrix, cb-02, cb-03, p730-profile-snapshot, w1-sub02-snapshot-secret, p745-prompt-carrier-producer, url-ingestion-backend-failclosed, admin-base-routes) | **92 passed / 7 skipped** (1 live-gated suite skipped) | **0** |
| `tsc --noEmit` — `packages/contracts` and `services/orchestrator` (after building contracts `dist` for the workspace consumer) | clean | **0** |

Migration 0035/0036 note: both are additive `ADD COLUMN IF NOT EXISTS` JSONB columns with no backfill and no constraint change; rollback is "stop writing the column" (the dispatcher treats absent/NULL as legacy notification-only), or drop the columns only with an explicit operator decision since prior deliveries' pins would be lost.

## 4. Changed/audited hashes (SHA-256)

Full table in `raw/cb02-cb03-wiring-2026-10-06/SHA256SUMS.txt`; keys:

- `profile-policy.ts` `145425A6…`, `submission.ts` `04EC1433…`, `retry.ts` `A0E63828…`, `profiles.ts` `376D0C7A…`, `profile-detail.ts` `3A78270C…`, `server.ts` `4FC40290…`, `create-app.ts` `AA04F120…`, migration 0036 `5AD75BFF…`, new test `E34E1A22…`
- `webhooks.ts` `19226078D1FE1BD4A9210ED1655F6415338CC6E5F236504FE57F2C0B573D361C` (matches CB-02 receipt), `outbound-auth.ts` `44435E1E…`, `oauth2-client.ts` `EBF7F1EB…`
- raw logs: `vfy-cb01-dispatch-matrix.log` `B75F2F29…`, `cb02-cb03-focused.log` `4201E898…`, `bff-sc04-m02.log` `F2C29975…`

## 5. Open items / limits

- Live (non-scripted) HTTPS token endpoint + receiver against a deployed candidate remains VFY-CB-01's independent scope; this evidence is recorded/offline by rule (no real credentials, no external calls).
- SC-01 catalog storage + operator wiring of `resolveCallbackSecret` (and optional `callbackOAuth2Options`) is required before authenticated callbacks function in production; fail-closed is proven meanwhile.
- UI roundtrip (Portal callback editor → publish → detail read) is CB-04's scope; the read wire now carries `callbackPolicy`.
- No commit/push; no task/gate tick.

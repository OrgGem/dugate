# Admin identity, API-key and Connector parity

This guide covers the ORV14 Identity and Connector administration paths. It describes the server-side behavior and the operator sequence; a visible button is not proof that a mutation succeeded. Read back the resource after each write and retain the returned version for the next compare-and-swap (CAS) operation.

## Who can do what

| Session | Identity, API-key and Connector writes | Tenant-scoped reads | Provider test |
| --- | --- | --- | --- |
| Validated platform Admin, including a validated local `ADMIN` | Create/reset/role/enable local users, replace assignments, issue/note/rotate/revoke non-Global API keys, create/edit/activate/rollback Connector revisions | Yes | Any admitted tenant Profile; `PENDING` candidate revisions are platform-Admin only |
| Tenant operator | No parity mutation | Only the authenticated tenant | Only if another workflow grants a separate provider-test capability; parity itself does not infer this from tenant-operator role |
| Local `USER` (`du-local` operator) | No Identity, key, or Connector administration | Assigned operations only; Identity/key/Connector management is read-only-denied | Exact `ACTIVE` revision already bound to the assigned active Profile and assigned active non-Global key |
| Viewer | No | No parity read or write | No |

Local `USER` operation visibility and lifecycle access require the exact currently assigned active non-Global API key. If the operation has a Profile pin, the same user must also have that exact Profile assignment. A Profile grant alone never exposes operations submitted using another key. Historical operations without a Profile pin are accessible only through their exact assigned key.

All cookie-authenticated writes use the Admin session, CSRF proof and shared BFF client epoch/401 behavior. Internal handlers derive the actor from the validated server session. They ignore browser-supplied identity, role, issuer and version claims. A local role or assignment/password version change increments the database version checked across replicas, so old local sessions stop authorizing requests.

## Identity and imported accounts

Open **Administration → Identity**, select the exact tenant and search by username. Search and cursor paging run on the server across the full directory. The safe user projection contains role, enabled/locked state, version and the boolean `legacyPasswordResetRequired`; it never contains a password, verifier, API key or session token.

An imported identity marked `password reset required` is disabled and has no usable local password. A platform Admin selects **Activate imported account**, supplies a new password (12 characters or more), and submits against the displayed user version. The server hashes the new password and locks the exact tenant/user row. Only `legacy_password_reset_required=true`, `is_enabled=false`, and `is_locked=false` permits that reset to enable the local account and consume the marker. It increments `version` and writes an activation audit event in the same transaction. The existing local credential reader then admits the user; the retired source database and its password are not needed.

The reset endpoint is `POST /admin/api/identity/users/:id/password`, with `{ "password": "…", "expectedVersion": 12 }`. A stale version returns a conflict and requires a fresh read. Locked imports are never enabled by reset; resolve the lock through the authorized identity-security process first. A normal disabled account reset only changes its password and version; it remains disabled. OIDC identities do not acquire local credentials from this endpoint. Readiness must count unresolved reset-required users and must remain incomplete until the required users have been reset and the source-off local-login plus scoped-BFF journey has been evidenced.

Role changes, enable/disable and complete assignment replacement are versioned. The assignment form replaces the full Profile and API-key sets atomically; it does not append. Foreign-tenant resources and the protected Global key are rejected. Disabling, demoting, or removing the last enabled unlocked Admin is rejected when it would lock out administration.

## API-key lifecycle

Open **API Keys** from Administration. Use server search, status filters and cursor navigation; do not fetch a first-page snapshot and filter it in the browser. A key can carry a bounded note and an explicit complete Profile membership set.

Issue and rotate return the raw key once in the mutation response. Copy it before navigating away; list, detail, notes, audit and replay responses contain only its identifier, prefix and safe metadata. Replaying the same idempotency key returns the stored redacted result and does not reveal the raw key a second time. Note edits, rotation and revocation use the current key version. The Global key cannot be renamed, rotated, revoked or assigned through this surface.

## Connector recipe and credential lifecycle

Use the structured Connector editor for provider, base URL, path, HTTP method, timeout, model, session capture/injection, request and response mapping, and safe static headers. The advanced JSON panel is for full-schema import/export and retains supported unknown-to-form mappings; validation errors stay visible instead of silently dropping fields. Credential-bearing headers and recipe values are rejected by the contract.

Saving an edit creates a new immutable `PENDING` recipe revision with `expectedHeadRevision` CAS and a stable idempotency key. `Keep`, write-only `Replace`, explicit `Clear`, and `Secret Catalog reference` are distinct actions. A reference value is only an opaque Secret Catalog UUID. The server verifies its tenant, active state, `connector.credential` purpose and Connector service permission, then stages it into a new Connector-owned KV-v2 version. The immutable revision stores the exact version pin; browser responses never return the value or underlying Vault path. The source reference and import provenance belong in the server-side idempotency/import journal.

Test the exact revision shown in the editor with an actual prompt, selected action/parameters, and up to four uploaded tenant-owned READY files. The server repeats key, Profile revision, business/action, locked-parameter, artifact ownership/extension and spend admission; it does not accept a caller-supplied secret or provider URL. Connector resolves the credential and invokes the provider after its signed test grant and cost preflight. A successful test result may show only Connector-sanitized bounded content, status, latency and usage. Unmarked legacy content is withheld.

A `PENDING` candidate is testable only by platform Admin and only through a temporary binding-slot overlay checked against the selected action manifest. It does not mutate the Profile or authorize normal execution. A local `USER` can test only the exact `ACTIVE` revision bound in the selected assigned Profile. `UNKNOWN` means the provider outcome is unresolved: it consumes concurrency capacity and cannot be retried under a new key to bypass the limit. Use **Check Connector evidence**; only a matching persisted successful Connector row and its delivered usage event can reconcile to success. No operator-supplied outcome or amount is accepted.

After a successful exact-revision test, activate using the expected current ACTIVE revision. Activation CAS loss means refresh and review before retrying. Activation does not silently publish a Profile binding. Rollback first creates a new PENDING clone of the exact source revision and then follows the same test and activation steps. Retain old credential versions while any active revision, operation pin or unresolved invocation refers to them.

## Routes and wire summaries

The Identity BFF keeps its existing `/admin/api/identity/...` routes. The reset body is `{password,expectedVersion}`; the response is `{user}` including the safe marker, enabled state and new CAS version. Assignment replacement is a complete `{expectedVersion,profileIds,apiKeyIds}` set.

The parity BFF uses `/admin/api/parity/api-keys/...`, `/admin/api/parity/connectors/:id/...` and `/admin/api/parity/provider-tests`. Its internal consumer is `/api/internal/parity/...`. Connector draft writes accept `{tenantId,expectedHeadRevision,recipe,credentialChange,idempotencyKey}`. Provider test accepts tenant/key/Profile/revision/action/parameters/prompt/artifact IDs, optional candidate binding slot/model, timeout and an idempotency key; server-side admission decides whether the selected exact binding is permitted.

## Recovery and evidence

For any timeout or lost response, reread the resource or retry with the same idempotency key. Do not create a new key while the prior action may still be in flight. A CAS conflict requires a fresh read and operator review. For an unresolved provider invocation, preserve `UNKNOWN` and its usage hold until Connector source evidence proves the outcome. Audit rows identify the trusted actor, scope, action and resource without secret values.

Unit and owner smoke receipts are implementation evidence only. Before marking a path independently verified or accepted, run the source-independent identity/key/Connector matrix against the final built bundle, including cross-tenant, stale-version, disabled/locked, Global-key, pending-candidate, two-replica session-revocation and lost-ACK recovery cases. Do not use paid providers or production credentials for the synthetic verification run.

# Runbook: Vault and OIDC operations (SEC-INT-02)

**Status: Draft / deployment preparation.** SEC-00 trust and IdP decisions are
still required, and the real Vault/IdP deployment fixture and end-to-end
service wiring have not been rehearsed. This document describes the approved
operating target and current gaps; it is not a receipt that production OIDC or
Vault is enabled. Do not enable a production cutover until the applicable
SEC-INT-01/02 evidence and security approval exist.

The Vault policy defaults below match `infra/vault/policies/`:

- KV v2 mount: `secret`
- credential prefix inside the mount: `du/connector`
- Orchestrator machine identity: `orchestrator-writer`
- Connector machine identity: `connector-reader`
- browser and business worker: no Vault identity

SEC-00 may approve a different mount or prefix. If so, update the contract
source, regenerate policies, review the diff, and rerun policy checks before
deploying. Never widen access to work around an outage.

## 1. Bootstrap policies and machine identities

Run bootstrap only through the approved Vault administrative path, with a
change record, TLS verification, the correct Vault namespace, and an audited
operator identity. Root/unseal credentials are break-glass material; do not
put them in service configuration, CI, shell history, tickets, or this file.

1. Check the cluster and current mounts/auth methods using the secured operator
session. These are read-only checks:

   ```sh
   vault status -format=json
   vault secrets list -detailed
   vault auth list
   vault audit list
   ```

   Confirm the target mount is KV version 2. If `secret/` is absent, enable
   KV v2 there only under the approved change. If a mount already exists with
   the wrong engine/version or contains data, stop and request a migration
   plan; do not disable, replace, or remount it in place.

   ```sh
   # Run only after the read-only check confirms secret/ is absent.
   vault secrets enable -path=secret kv-v2
   ```

2. Install the reviewed policy files from the repository root:

   ```sh
   vault policy write orchestrator-writer infra/vault/policies/orchestrator-writer.hcl
   vault policy write connector-reader infra/vault/policies/connector-reader.hcl
   vault policy read orchestrator-writer
   vault policy read connector-reader
   ```

   `orchestrator-writer` can create/update data below
   `secret/data/du/connector/*` and read/list metadata below
   `secret/metadata/du/connector/*`; it cannot read secret values.
   `connector-reader` can read values and metadata under that prefix; it
   cannot create, update, delete, or destroy secrets. Review the rendered
   policy against `packages/contracts/src/vault-policies.ts` before applying.
   `worker-browser.hcl` is a no-access marker, not a policy to bind to a
   browser/worker identity. Do not issue Vault credentials to those actors.

3. Use only the SEC-00-approved machine auth method (AppRole or Kubernetes).
   Bind separate Orchestrator and Connector identities to only their matching
   policy. Set renewable-token lifetime, SecretID/service-account lifetime,
   audience, namespace and renewal margin to the values approved in SEC-00;
   the plan has not fixed those budgets yet. Do not share the writer identity
   with Connector or reuse one token across replicas/services.
4. Deliver each role credential using the approved secret manager or workload
   identity integration. Prefer short-lived, renewable service tokens and
   rotate bootstrap credentials after provisioning. Never print a SecretID,
   token, unseal share, or client secret to verify delivery.
5. Enable and verify the approved Vault audit device before writing provider
   credentials. Restrict audit output access and retention. Do not disable
   audit to recover service. Use a non-production fixture and the policy
   positive/negative matrix to prove writer-write/reader-read and the denied
   reverse actions. Policy-file installation alone is not runtime identity
   evidence.

Do not use `vault kv get` on provider credential values during bootstrap.
Metadata and policy checks must not display secret data. The current repository
has generated policy HCL and an in-memory policy fixture; `infra/vault/README.md`
records real Vault compose/identity rehearsal as outstanding.

## 2. OIDC identity-provider configuration

SEC-00 must approve the issuer, client, callback/public Admin origin, trusted
proxy boundary, role/group mapping, tenant mapping, and break-glass policy
before production login is enabled. The OIDC client building block validates
an exact `allowedIssuers` list, requires HTTPS outside loopback development,
uses RS256, and verifies issuer/audience/time/nonce. It does not by itself
prove that production login routes, session storage, RBAC, and Admin actions
are integrated. Keep the current production auth mode unchanged until the
OIDC/session/RBAC implementation and SEC acceptance are complete.

Configure the IdP confidential client with:

- Authorization Code flow with PKCE `S256`; disable implicit and password
  grants. Require one-time `state` and `nonce` validation at callback.
- Exact HTTPS redirect URI matching the deployed public Admin origin and
  registered callback. Do not derive callback or return URLs from an untrusted
  `Host`/forwarded header or arbitrary query parameter.
- Exact issuer URL and an explicit issuer allowlist; TLS-verified discovery and
  JWKS from that issuer only. Configure client authentication and signing
  algorithm to the approved RS256 contract.
- Minimum scopes (`openid` plus only approved profile/group claims). Map
  IdP-managed groups to `admin`/`operator`/`viewer` and tenant scope by the
  server-side SEC-00 matrix. Do not infer role from email domain or accept a
  browser-supplied identity/role header.
- A client secret held in the deployment secret manager or mounted secret
  file, with a named rotation owner and overlap procedure. It must never be a
  checked-in literal. Tenant Public API `x-api-key` and Connector/provider
  credentials are separate trust paths; OIDC does not replace them.

### Zero-secret environment template

The names below are **reference placeholders only**; they are not a claim that
the current application reads these variables. Replace non-secret example
values per approved deployment. Secret files must be provisioned outside the
repository with least-privilege access. Do not commit `.env` files.

```dotenv
# Reference template only; do not copy into a production deployment unchanged.
DU_ADMIN_OIDC_ISSUER=https://idp.example.invalid/realms/du
DU_ADMIN_OIDC_ALLOWED_ISSUERS=https://idp.example.invalid/realms/du
DU_ADMIN_OIDC_CLIENT_ID=du-admin-example
DU_ADMIN_OIDC_CLIENT_SECRET_FILE=/run/secrets/du-admin-oidc-client-secret
DU_ADMIN_OIDC_REDIRECT_URI=https://admin.example.invalid/oidc/callback
DU_ADMIN_OIDC_PKCE_METHOD=S256
DU_ADMIN_OIDC_ROLE_CLAIM=groups
DU_ADMIN_OIDC_TENANT_CLAIM=tenant_id

DU_VAULT_ADDR=https://vault.example.invalid
DU_VAULT_AUTH_METHOD=approle
DU_VAULT_KV_MOUNT=secret
DU_VAULT_PATH_PREFIX=du/connector
DU_VAULT_ORCHESTRATOR_ROLE_ID_FILE=/run/secrets/vault-orchestrator-role-id
DU_VAULT_ORCHESTRATOR_SECRET_ID_FILE=/run/secrets/vault-orchestrator-secret-id
DU_VAULT_CONNECTOR_ROLE_ID_FILE=/run/secrets/vault-connector-role-id
DU_VAULT_CONNECTOR_SECRET_ID_FILE=/run/secrets/vault-connector-secret-id
DU_VAULT_RENEWAL_MARGIN=__SEC00_APPROVED_DURATION__
```

Every `example.invalid` host and `/run/secrets/...` value is a non-secret
placeholder. The template intentionally contains no sample client secret,
role credential, Vault token, unseal key, provider key, cookie, or signing key.
If Kubernetes auth is approved, replace AppRole file references with the
approved service-account/audience configuration; do not enable both methods
for convenience.

## 3. Vault sealed state and outage triage

### Unseal procedure

1. Check `vault status -format=json` from the secured operator network. Record
   only cluster state, node/HA state, and time in the incident; do not record
   recovery shares, root tokens, or credential payloads.
2. If auto-unseal is configured, check the approved KMS/HSM status, identity,
   permissions, and connectivity. Recover that dependency through its normal
   change path; do not switch to manual shares unless the Vault recovery plan
   explicitly authorizes it.
3. For Shamir unseal, follow the Vault cluster's sealed-node runbook with the
   required independent custodians. Each custodian enters only their own share
   through the secured interactive `vault operator unseal` prompt, without
   passing a key argument. Never combine shares in a file,
   command argument, shell history, ticket, chat, or transcript. Do not ask
   one operator to collect or expose the threshold set.
4. Unseal only the affected node(s) as the HA recovery plan directs. Do not
   restart all nodes or alter Raft/storage state to clear a sealed alert.
   Confirm the cluster is unsealed/healthy, audit device is available, and the
   normal service path recovers before declaring service restored.

### Outage diagnosis and response

1. Classify the failure: DNS/TLS/network/connect timeout, sealed/standby or
   unavailable cluster, expired/invalid machine token, policy `403`, missing
   path/key/version, or CAS conflict. Use Vault status and sanitized service
   error codes; application health alone is not a Vault credential test.
2. Check Vault reachability and TLS trust from the Orchestrator/Connector
   runtime network, approved HA/KMS status, and audit sink availability. For
   `403`, compare the required mount/prefix with the reviewed policy and stop;
   do not broaden the policy. Treat missing key/version and CAS conflict as
   configuration/reconciliation incidents, not availability failures.
3. **Fail closed.** The Connector must not fall back to plaintext headers,
   legacy DB secret values, worker/browser-supplied keys, or a different
   unpinned KV version. Pause affected credential writes or provider calls
   through the approved service controls; keep durable revisions pending and
   preserve invocation/revision evidence without secret values.
4. For an ambiguous writer timeout, use the approved metadata-only CAS
   reconciliation: inspect the current KV version and durable revision state,
   then complete or retry the same idempotent change under its owner workflow.
   Do not blindly write another version or promote a `PENDING` reference.
5. After recovery, verify machine-token renewal, policy path, exact pinned
   version, and a non-production/test credential through the approved service
   path. Do not test readiness with a live provider key unless the separately
   approved credential test explicitly requires it. Reopen affected work
   gradually and review sanitized error/audit telemetry.

## 4. Machine-token renewal and identity recovery

Configure each service identity to receive a renewable short-lived token using
the approved AppRole/Kubernetes auth method. The renewal period, token maximum,
bootstrap credential lifetime, and warning margin are environment policy
values; SEC-00 must set them before rollout. The service renews over verified
TLS before the approved remaining-TTL margin and emits only success/failure
class, latency, and a bounded service identity label.

- Retry transient renewal failures with bounded backoff and alert before the
  remaining-TTL budget is exhausted. Do not log the `X-Vault-Token` header,
  renewal response, role credential, or error body.
- A token that is expired or revoked cannot be renewed. Re-authenticate only
  with the approved workload identity/SecretID delivery path, then replace
  in-memory credentials atomically. Never paste a token into a shell command,
  incident, or deployment manifest.
- If identity is denied, distinguish expired token from wrong policy, auth
  role, namespace, audience, mount, or path. Do not issue a root token to the
  service or add broad `sys/*` capabilities to either application policy.
- If Vault is unavailable at the renewal deadline, fail closed and pause
  affected secret operations/provider invocations. Do not continue by reading
  an unapproved legacy store. Resume only after the service identity has a
  valid token and the pinned credential read succeeds.

## 5. Emergency credential/token revocation and rollback

### Provider credential compromise

1. Revoke/disable the credential at the provider first; Vault deletion alone
   cannot revoke a value already read or cached by a downstream process.
2. Use the approved Connector/Orchestrator control to block new invocations
   for the affected connector/account and classify ambiguous in-flight calls
   under the invocation UNKNOWN runbook. If the control is not implemented,
   page the service/security owner and isolate affected provider traffic using
   the approved egress control.
3. Record only credential reference ID/version, actor, provider revocation
   receipt ID, and timestamps. A privileged Vault operator may soft-delete or
   destroy the specific KV v2 version only under the retention/incident policy.
   The application policies intentionally do not grant delete/destroy. Destroy
   is irreversible; do not use it as a routine rotation step.
4. Rotate to a new KV version with CAS and create a new connector revision in
   `PENDING`. Verify the reader can resolve the exact pinned version and that
   the approved canary passes before promoting it to `ACTIVE`. Reconcile any
   partial Vault-write/DB-update outcome before retrying.

### Vault machine-token compromise

Revoke the affected token using a privileged Vault operator path, rotate or
revoke its AppRole SecretID (or repair the approved Kubernetes role binding),
and issue a fresh service identity credential through the secret manager.
Redeploy/re-authenticate only the affected service identity. Review Vault audit
records and service telemetry for access outside its exact prefix. Do not
revoke all service tokens or disable audit unless the incident commander and
Vault owner approve that broader containment action.

### OIDC client or administrator compromise

Disable/revoke the compromised OIDC client secret or administrator at the IdP,
issue a replacement secret through the deployment secret manager, and revoke
affected server-side sessions using the approved session control. Do not place
OIDC tokens, callback codes, cookies, or the replacement client secret in the
Admin UI, browser state, or environment template. OIDC session/logout and
rotation controls remain a production gate until SEC-INT-01 proves the routes
and replicas.

### Rollback rules

- For a failed planned rotation, stop promotion and route new work to the last
  healthy connector revision pinned to the prior KV version **only if** the
  prior provider key is still valid and not suspected compromised. Keep the
  failed version and audit evidence for reconciliation; do not overwrite or
  renumber KV history.
- Never roll back to a credential, token, or client secret suspected of
  compromise. Revoke upstream first and issue a new version/identity.
- If Vault write succeeded but the durable revision update failed, leave the
  revision `PENDING`, inspect metadata/version only, and reconcile through the
  idempotent owner workflow. Do not enable invocations using a half-committed
  reference.
- Close only after upstream revocation is confirmed, affected service identity
  and connector revision state are correct, canary/auth failures are stable,
  and audit evidence contains no raw secret or token.

## 6. Audit, telemetry, and forbidden sinks

The following values are forbidden in every sink: provider/API credentials;
Vault root, service, renewal, or client tokens; AppRole SecretIDs; unseal
shares; OIDC ID/access/refresh tokens; authorization codes; `state`, `nonce`,
PKCE verifier; session/CSRF cookies; Authorization headers; secret values;
raw Vault path/key or sensitive URL query; and upstream request/response/error
bodies containing any of those values. Redaction is defense in depth; avoid
constructing log/event fields from raw errors in the first place.

| Sink | Never emit/store | Safe operational evidence |
|---|---|---|
| HTTP ProblemDetails | Raw upstream error, Vault path/key, token, code, provider body | Stable error code, generic detail, status, correlation ID |
| Admin HTML/client state/browser trace | Secret or token, cookie, callback code/state/nonce, PKCE verifier, unmasked credential | Masked configured/revoked state and approved non-secret version/status metadata |
| Application logs/stdout/collector/Elasticsearch | Request/response bodies, headers, raw `Error.message`/stack, SecretID, secret values | Sanitized error class/code, service role, latency, correlation ID |
| Metrics and dashboards | Secret/path/token/correlation/user/tenant identifiers as labels; unbounded labels | Low-cardinality service role, operation class, result class, duration/count |
| Distributed traces | Authorization/cookie headers, query string, form/body, IdP/Vault URLs with sensitive params | Sanitized span name, status class, duration, correlation context |
| Jobs, outbox, retry payloads, BullMQ/Redis | Provider key, Vault token, OIDC token/code, raw Vault path/key or secret body | Approved opaque connector/revision/ref ID only; no direct Vault access token |
| Webhook payload/`last_error`, usage labels/payload | Secret, token, raw Vault/IdP errors, path/key, provider response | Stable event/error code and non-secret correlation metadata |
| Database revision/invocation JSON and audit records | Plaintext credential, Vault token, OIDC token/cookie, raw request/response | Pinned typed Vault reference/version in designated metadata fields; masked GET/audit view |
| Vault audit sink | Unrestricted access to raw audit records or disabled audit during incident | Restricted, encrypted, retained audit device with reviewed HMAC/redaction and access trail |

SEC-INT-01 must inject unique synthetic sentinels and prove zero matches in
ProblemDetails, Admin HTML/browser state, logs/collectors, metrics labels,
traces, jobs/outbox/Redis, webhook/usage payloads, and revision/invocation
records. Include both allowed metadata and denied/error paths. SSE is not
present in the current service snapshot; apply the same scan if it is added.
Do not treat HTML escaping, a masked GET response, or the logger's current
redaction helper as proof of write-time secret protection.

## 7. Readiness and rehearsal evidence

This offline documentation pass did not bootstrap Vault, unseal a node, contact
an IdP, issue a service token, read/write a KV value, query DB/Redis, or run live
tests. Before production use, SEC-INT-02 rehearsal must record the exact
repository/build identity, policy revision, approved IdP/Vault configuration
with zero secret values in evidence, commands and exit codes, role allow/deny
matrix, token renew/expiry and outage/rollback outcomes, sink-sentinel scan
results, and owner sign-off. Full SEC/G-SEC closure remains subject to all
required SEC task receipts; this runbook alone does not satisfy that gate.

**References:** [SEC/OIDC/Vault plan](../../tasks/SEC-OIDC-VAULT-2026-09-24.md),
[`infra/vault/README.md`](../../infra/vault/README.md),
[`orchestrator-writer.hcl`](../../infra/vault/policies/orchestrator-writer.hcl),
[`connector-reader.hcl`](../../infra/vault/policies/connector-reader.hcl),
[`worker-browser.hcl`](../../infra/vault/policies/worker-browser.hcl),
[`vault-policies.ts`](../../packages/contracts/src/vault-policies.ts),
[`vault.ts`](../../packages/contracts/src/vault.ts),
[`oidc-client.ts`](../../services/orchestrator/src/modules/auth/oidc-client.ts),
[`redaction.ts`](../../packages/observability/src/redaction.ts).

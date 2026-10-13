# Receipt E2E-02/E2E-03 — isolated stack GREEN; two blockers isolated, neither a build defect

Date: 2026-10-11
Owner: coordinator
Status: stack up 8/8; live suite 9/10 PASS; 10th failure isolated to two independent defects

## Result summary

| Step | Result |
|---|---|
| Isolated stack up | 8/8 containers, migrate Exited(0), orchestrator Healthy |
| Live suite smoke.cjs | 9 pass / 1 fail |
| Blocking defect 1 | Vault address rule rejects the whole plain-HTTP dev-Vault topology |
| Blocking defect 2 | smoke.cjs builds a slash-less URL, so the Admin test cannot pass as written |

Both are configuration/documentation/test defects, not image or build defects. The
images built green and every runtime-image assertion passed.

## Blocker 1 — Vault address rule vs the entire dev-Vault topology

### Symptom

`orchestrator-1` crash-looped. The boot error was obtained by calling `main()`
directly in a one-off container, because `safeErrorForLog` reduces startup failures
to a generic redacted envelope and hides the real cause from the log stream:

```
VaultTransitError: Vault address must be an HTTPS origin (HTTP is allowed on loopback)
    at validateAddress (dist/modules/encryption/vault-transit-provider.js:97)
    at new VaultTransitProvider (dist/modules/encryption/vault-transit-provider.js:127)
    at buildEncryptionBootOptions (dist/modules/encryption/boot-options.js:334)
    at Object.main (dist/main.js:241)
```

No product control was weakened to observe this: the one-off container ran the real
entrypoint function directly.

### Rule

`validateAddress` at
`orchestrator/services/orchestrator/src/modules/encryption/vault-transit-provider.ts:143-164`
requires an HTTPS origin, allowing plain HTTP only on loopback hosts. Constructor
calls it at `:195`.

### Why the flags cannot bypass it

`resolveEncryptionBoot` at `boot-options.ts:290-294` forces both encryption blocks
whenever the data mode is real, regardless of the individual enable flags:

```
forced = dataMode.mode === real
metadataEnabled     = forced || flag || s3
publicUploadEnabled = forced || flag || s3
```

`.env.docker:29` sets `DU_DATA_MODE=real`, so the seam is always armed. This was
confirmed empirically, not inferred: setting both enable flags to false did not
change the outcome. Grep also proves no dev/test override knob exists in the module.

### Accept/reject set measured in the built image

```
http://host.docker.internal:8200   REJECT
http://vault:8200                  REJECT
https://vault:8200                 ACCEPT
http://127.0.0.1:8200              ACCEPT
http://localhost:8200              ACCEPT
```

### The decisive finding

This is not merely a mismatch with the value in `.env.docker:34`. The repo ships its
own documented dev topology on plain HTTP, and the rule rejects that too:

- `.env.docker.example:70` documents `http://vault:8200` — rejected by the rule.
- `infra/docker-compose.live.yml:55-62` runs the dev Vault with no TLS, listening on
  plain HTTP, and it has been healthy for 6 days.
- `infra/vault/README.md:27` concedes that a real dev-Vault compose boot is a
  separate follow-up, never completed.

So the HTTPS-or-loopback rule is incompatible with the plain-HTTP dev-Vault topology
the repo itself ships. The rule is a deliberate security control and is correct on its
own terms; the topology is what is incomplete.

Vault reachability was also ruled out as the cause: a fetch from the already-running
connector container returned an initialized, unsealed status payload. This is a
policy rejection, not a connectivity failure.

### Resolution applied

Used the exemption the design already provides, for this isolated stack only.
`DU_DATA_MODE=synthetic` plus a complete `DU_SYNTHETIC_DATA_ACK` object is the
sanctioned opt-out, validated at `boot-options.ts:206-226` against the strict schema
at `orchestrator/packages/contracts/src/encryption-persistence.ts:126-134`
(fields: mode, reason, approvedBy, acknowledgedAt, isolatedFromRealData).

Applied as shell environment only. No secrets file was edited, no product source was
touched, no security control was weakened, and the exemption is recorded in the
orchestrator logs.

Cost, stated honestly: this E2E run does not exercise the real-data Vault transit
encryption path. That path remains unverified by this run.

## Blocker 2 — smoke.cjs cannot pass its own Admin test as written

### Defect A: slash-less URL

`smoke.cjs:86-87` concatenates without a path separator:

```
const base = http://127.0.0.1:${env.ADMIN_SHELL_PORT}
fetch(base + 'admin')
```

which produces `http://127.0.0.1:3301admin` and throws `ERR_INVALID_URL`. Observed
verbatim in the failure output. Any port value fails; the test is unconditionally
broken regardless of deployment. This is a test defect, not a port-mapping issue.

### Defect B: the login 503 is a correct fail-closed control, not a bug

With the URL corrected, the flow advanced to a real 503 from the shell. The
orchestrator log states the reason precisely:

```
kind=auth.tls_required  reason=tls_unproven_under_enforcement  method=POST  pathname=/admin/login
```

`auth-dispatch.ts:109-131` runs this check after credential validation and refuses to
mint a Secure session cookie when TLS cannot be proven, emitting a 503. That is the
intended behavior, and the error page names the sanctioned remedy:
terminate TLS at a proxy that overwrites `x-forwarded-proto`, and set
`DU_ADMIN_TRUST_PROXY_PROTOCOL=true`.

The mismatch: `.env.docker:23` ships `DU_ADMIN_TRUST_PROXY_PROTOCOL=false`, while the
test itself sends `x-forwarded-proto: https`. The test asserts the proxy-terminated
posture but the shipped env disables it. `oidc-boot.ts:132-136` refuses to treat an
unknown value as trust, so the default is fail-closed by design.

### Verification of the fix without editing anything

Set the operator switch via shell env and recreated the orchestrator. Result:

```
POST /admin/login   -> 302
Secure + HttpOnly   -> true
GET /admin (authed) -> 200
assets              -> 2
  /admin/assets/index-B0_8hhMr.js   200   1068540 bytes
  /admin/assets/index-BYv0RYit.css  200     60589 bytes
```

The Admin flow is fully functional, the SPA bundle serves, and the session cookie
carries both Secure and HttpOnly. The remaining failure is purely Defect A, the
slash, which lives in the test file.

## What passed

All 9 non-Admin assertions passed against the running stack:

- 5 per-service runtime-image checks: non-root uid 1000, correct package identity,
  no source or test tree in the image, TypeScript not resolvable, all production
  dependencies resolvable, compiled entrypoint present; plus `/app/admin-web/index.html`
  and a non-empty migrations directory on the orchestrator.
- migrate exited 0 and every long-running container stayed up with restart count 0.
- 3 per-business network tests, each proving API health, a raw Redis PING/PONG over
  a socket, Connector readiness, and a 403 BINDING_DENIED for the invoke identity
  attempting connector management.

## Constraints honored

- No commit, no `git add`, no push, no gate tick.
- No peer stack stopped or modified. The 3300/3301 ports remain owned by a 5-day-old
  peer; this session moved its own ports to 13300/13301 and stayed isolated.
- No secrets file edited. The synthetic-mode override was applied as shell env only.
- No product source edited this segment. The only product file ever changed remains
  the single Dockerfile COPY line authorized earlier and recorded in
  receipt-e2e-01-build-green.
- The log-redaction boundary was respected; the real error was obtained by executing
  the entrypoint in a one-off container rather than by weakening redaction.

## Next

E2E-04 onward can proceed against this running stack. Two decisions are needed first,
both outside coordinator authority:

1. Fix Defect A in smoke.cjs:86-87 (add the path separator). This is a test edit.
2. Decide the standing posture for the Vault topology: give the dev Vault real TLS,
   add a sanctioned container-network HTTP path, or accept that E2E runs in synthetic
   mode and cover the real-data encryption path by a separate dedicated test.
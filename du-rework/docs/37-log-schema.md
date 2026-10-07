# 37 — Log schema and redaction contract (LOG-01)

Status: **draft, scope of LOG-01**. Owned by the OpenClaude lane for the
HTTP / Admin surface; platform / Connector / worker lanes own their own
service emitters but must conform to this schema and redaction contract.

## 1. Purpose

Every service in the pilot emits **structured JSON logs to stdout** so a
collector (LOG-02) can ship them to Elasticsearch with TLS. This document
locks down:

- the **shape** of every emitted log line (so dashboards, retention, ILM,
  and trace correlation all line up),
- the **redaction contract** for HTTP / Admin requests the OpenClaude
  lane owns,
- the **sentinel / must-not-appear** list across all lanes.

This is the LOG-01 deliverable; it does **not** by itself close the
G-DATA gate. G-DATA closes only after LOG-02 (collector→Elasticsearch)
plus DATA-INT-01 (cross-host fault E2E) land.

## 2. Wire shape (every line)

One JSON object per line, terminated by `\n`. No pretty printing. UTF-8.

**Atomicity guarantee.** Each event is a single `JSON.stringify(...)`
followed by a single `process.stdout.write(json + '\n')`. The collector
parses line-by-line; a `write` that spans two packets, two threads, or
two buffered flushes is a **line-corrupt bug** (the conformance test
asserts on a captured stream and treats any line that fails
`JSON.parse` as a hard failure). `console.log` is forbidden in
production because it multiplexes the call with `util.format` and
`process.stdout` re-encoding, neither of which is deterministic under
load.

**No trailing whitespace.** Lines MUST NOT end with spaces, tabs, or
any character other than `\n`. The conformance test reads the stream
verbatim and asserts each line matches `^[^\r\n]+\n$`.

Required keys (always present):

| Key | Type | Notes |
|---|---|---|
| `ts` | string (ISO 8601 UTC) | `2026-09-24T07:14:14.931Z`. Set at emit time, not at collector. Strict shape: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$` (timezone MUST be `Z`, not `+07:00` or other offsets). |
| `level` | string enum | `"trace" \| "debug" \| "info" \| "warn" \| "error"`. Closed set; any other value is rejected by the conformance test. |
| `service` | string | Stable identifier: `"orchestrator"`, `"connector"`, `"document-core"`, `"worker-sdk"`, `"example-review"`. |
| `version` | string | SemVer from `package.json` at build time (injected at build, not read at runtime). |
| `environment` | string enum | `"dev" \| "test" \| "staging" \| "prod"`. Closed set. |
| `message` | string | Human-readable single-line summary. No newlines; no ANSI; no embedded `\r`. The conformance test asserts `!message.includes('\n')`. |

Optional keys (when the request / operation carries them):

| Key | Type | Notes |
|---|---|---|
| `correlation_id` | string (UUID) | Set once at the entry point (HTTP request) and propagated through the call graph; `X-Correlation-Id` request header, generated server-side if absent. RFC 4122 shape. |
| `request_id` | string (UUID) | Per-request, distinct from `correlation_id` (which is per-business-flow). RFC 4122 shape. |
| `task_id` | string (UUID) | Present in any runtime task log. |
| `operation_id` | string (UUID) | Present in any operation / facade log. |
| `invocation_id` | string (UUID) | Present in any grant / invocation log. |
| `tenant_id` | string (UUID) | Present **only when the operation is scoped to a tenant**. See §4.4. |
| `duration_ms` | number | Set on every terminal log line (HTTP response, operation terminal, dispatch). Integer, never NaN. |
| `exit_code` | integer | `0` on success, non-zero on terminal failure. HTTP handlers: the HTTP status code. |
| `error` | object | `{ kind, message }` only; never the raw exception detail. See §4.6. |

Optional keys are absent (not null) when not applicable. The
conformance test parses each line with `JSON.parse` and asserts:

1. The line is a JSON object (not an array, not a scalar).
2. Every required key is present.
3. The `ts` value matches the strict UTC regex.
4. The `level` value is in the closed set.
5. The `environment` value is in the closed set.
6. No key outside the closed shape is present (forward-compat is
   handled by the schema being **additive**: services MUST NOT emit
   keys not listed here without bumping the schema's micro-version
   in `service`'s `version` suffix and a new entry in §7's open
   items).

## 3. Emit contract

- **stdout only.** Services write JSON lines to stdout; nothing to
  files, nothing to syslog, nothing to network sockets.
- **One line per event.** Multi-line stack traces are NOT a substitute
  for the structured `error` object; if a stack is logged, it goes into
  `error.stack` as a single string with newlines escaped to `\n`.
- **No `process.stdout.write` concatenation across calls.** Each event
  is a single `JSON.stringify` then `write(..., "\n")`.
- **Bounded size.** If a single serialized event exceeds **16 KiB**, the
  emitter MUST drop the offending payload, replace it with
  `{ message: "log_oversize", original_kind: <kind>, original_bytes: <N> }`,
  and emit a single warning. Reason: collector buffers are bounded.
- **No busy loops.** Anything emitted more than 1000 times in a 60-second
  window from a single (service, kind) MUST coalesce into a single
  warning line plus a counter (e.g. `{ message: "coalesced",
  kind: "http.request", dropped: 994 }`). Collector-side sampling is a
  separate concern.

## 4. Redaction contract (HTTP / Admin surface)

Applies to: `orchestrator/services/orchestrator/src/app/admin/**`,
`orchestrator/services/orchestrator/src/http/**`, and every request entry-point that
the OpenClaude lane owns. Platform / Connector lanes apply the
**sentinel list** (§4.7) but may define additional redaction classes
specific to their handlers.

### 4.1 Mandatory REDACT class

The OpenClaude lane MUST redact before `JSON.stringify` if the field
appears in the request payload, response payload, error message, or
exception detail:

| Sentinel | Pattern | Redaction token |
|---|---|---|
| `api_key` | any field literally named `api_key`, `apiKey`, `x-api-key`, or `x_api_key` | `"[REDACTED:api_key]"` |
| `bearer_token` | `Authorization: Bearer …` header value | `"[REDACTED:bearer]"` |
| `jwt` | three-base64url-segment tokens after `Bearer` or in a `jwt`/`token` field | `"[REDACTED:jwt]"` |
| `connector_credential` | fields `connector_secret`, `connectorCredential`, `connector_password`, `connectorPassword`, `api_secret`, `apiSecret`, `client_secret`, `clientSecret`, `webhook_secret`, `webhookSecret` | `"[REDACTED:connector_credential]"` |
| `signed_url` | URLs whose query string contains `signature=`, `X-Amz-Signature=`, `X-Amz-Credential=`, `sig=` | `"[REDACTED:signed_url]"` |
| `raw_artifact_bytes` | any field typed `Buffer`/`Uint8Array` or base64-encoded payload > 256 chars in JSON | `"[REDACTED:bytes:<N>]"` where `<N>` is the byte length |
| `vault_path` | any field matching `^vault:(du/)?[a-z0-9_./-]+$` | `"[REDACTED:vault_path]"` |
| `webhook_payload` | the JSON body of any inbound or outbound webhook | `"[REDACTED:webhook_payload]"` |
| `webhook_signature` | `X-DU-Signature`, `X-Hub-Signature-256` header value | `"[REDACTED:webhook_signature]"` |

The redaction class is implemented as a single pure function
`redactForLog(input: unknown): unknown` (see test file). It returns a
shallow-cloned object with sentinel fields replaced; nested objects /
arrays are walked recursively up to **depth 6** (anything beyond is
replaced with `"[REDACTED:depth>6]"`); cycles are guarded.

### 4.2 Body fields

If a request body is logged at all (e.g. for a `400 MALFORMED_BODY`),
the body MUST first be run through `redactForLog` then truncated to
**4 KiB** before emission. The truncation MUST happen on the
**redacted** payload, not the raw one, so a raw secret can never
re-appear in a later chunk.

### 4.3 Connector secret grant surface

The `connectors` section and any connector-config write MUST NOT log
the secret value, the pre-redaction form, or its hash. Only the
`secret_present: true | false` boolean may be emitted.

### 4.4 Tenant id

`tenant_id` is present on log lines **only** when the operation is
authorized and tenant-scoped. Unauthenticated request attempts (401
before tenant resolution) MUST NOT log `tenant_id`. Cross-tenant 404
(the intended response for SEC-01) MUST log only `tenant_id_present:
true|false` from the inbound key, not the resolved tenant — to avoid
leaking the requested-but-not-resolved target.

### 4.5 Error messages

Error logs MUST carry `error.kind` (a stable identifier, e.g.
`HTTP_BAD_BEARER`, `INGRESS_OVERSIZE`) and `error.message` (a single
human-readable sentence, free of variable interpolation that could
embed a secret). Stack traces are omitted in production; in dev/test
they may be emitted but MUST pass through `redactForLog` first because
Node's default `Error.toString()` embeds the offending message and any
object the constructor was called with.

### 4.6 Raw exception detail is forbidden

A response body that contains `error.detail`, `error.cause`, or the
raw `Error.toString()` output MUST NOT be echoed to logs. The HTTP
response itself may carry a ProblemDetails payload (frozen contract),
but the log line carries only the redacted `error.kind` +
`error.message`. The user's standing rule (per
`coordination/CLAUDE.md` §Ownership: "Lỗi lane khác ghi request/nudge
owner") is the basis for this — secret leakage through error detail
is a known incident class.

### 4.7 Sentinel / must-not-appear list (cross-lane)

These tokens MUST NOT appear in any log line emitted by any service:

- `sk_live_`, `sk_test_` (Stripe-style plaintext API keys)
- `xoxb-`, `xoxp-` (Slack tokens)
- `ghp_`, `gho_`, `ghs_`, `ghu_` (GitHub tokens)
- `AKIA` (AWS access key prefix)
- any string matching `^-----BEGIN [A-Z ]*PRIVATE KEY-----`
- any string matching `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
  (a JWT)
- raw Vault token strings (`hvs.` / `hvb.` / `s.` prefixes)
- any base64-encoded payload ≥ 256 chars that is not a known image /
  binary MIME type the business layer is documented to emit

The OpenClaude lane's `redactForLog` test (`tests/log-redaction.test.ts`)
covers the HTTP / Admin surface; the platform / Connector lanes MUST
add their own conformance tests before claiming LOG-01 closed for
their surfaces.

## 5. Collector / Elasticsearch envelope (LOG-02)

Out of scope for LOG-01 — collector mapping, ILM, retention, alerts
are LOG-02's deliverable. The schema here is the contract LOG-02
must consume.

## 6. Migration plan

There is no migration step for the schema itself — services emit the
new shape from their next build. Existing free-text console output is
deprecated; **no compatibility shim, no opt-in flag, no fallback path**.
The decision rationale:

- **Single source of truth.** A shim that emits the old shape when an
  unset env var is detected creates two divergent emitters; the
  conformance test (`log-schema-conformance.test.ts`, PR-LOG01-D) can
  only assert against one of them, and the other one inevitably leaks.
- **Collector mapping is identical for both shapes** (Lodash / Logstash
  filter chain reads required keys by name, not by version), so a
  shim buys nothing for LOG-02 downstream.
- **Schema migration is one-shot per service.** Each service emits the
  new shape from its next build; there is no compatibility window
  because there is no client outside the collector (services do not
  read each other's logs).
- **Test environments (`dev` / `test`) MAY keep the human-readable
  console path** for CLI ergonomics (`migrate-cli.ts` PR-LOG01-C is
  the only sanctioned example), but the JSON-line path is the
  production contract from day one.

The OpenClaude lane does not edit `orchestrator/services/orchestrator/src/**`
directly; the schema is wired by the PLATFORM REQUEST to Claude
Code (see §8). PR-LOG01-A emits the new shape from a single helper;
PR-LOG01-B wires the helper at the 38 existing emit sites; PR-LOG01-C
applies the dev/test carve-out for the CLI. No step in §D of the
PLATFORM REQUEST introduces a shim.

## 7. Open items

- ILM / retention values per environment: deferred to LOG-02.
- Cardinality budget for `tenant_id`, `operation_id`, `task_id` in
  hot tier: deferred to LOG-02.
- Sampling / coalescing thresholds: deferred to LOG-02.
- Cross-service propagation of `correlation_id` through Connector /
  worker SDK calls: deferred to DATA-04 / Connector lane.

## 8. PLATFORM REQUEST (LOG-01, src-side)

The OpenClaude lane owns only the doc + the test. The platform lane
(Claude Code, owner of `orchestrator/services/orchestrator/src/server.ts` and
`src/http/**`) owns:

- `redactForLog` implementation wired into the HTTP entry point
  (`src/http/ingress.ts`) and the Admin shell request handlers
  (`src/app/admin/**`)
- migration of the existing 38 `JSON.stringify` / `console.*` calls
  in `src/server.ts`, `src/migrate-cli.ts`, `src/modules/**`,
  `src/app/admin/**` to the schema in §2
- addition of a regression suite under
  `orchestrator/services/orchestrator/tests/log-schema-conformance.test.ts` that
  asserts every emitted line carries the six required keys and never
  carries any §4.7 sentinel

Request is filed in
`coordination/reports/claude.md` §LOG-01 with the file:line map. The
OpenClaude lane will not self-implement any `src/**` change.

## 9. Cross-references

- `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` LOG-01 row (delivery
  gate for this doc + G-DATA gate's log prerequisite)
- `docs/15-decisions.md` ADR-14 (bearer-token auth, error contract)
- `docs/07-internal-api.md` (Admin API contract; `x-api-key` /
  `Authorization: Bearer` are the only auth headers)
- `coordination/reports/claude.md` §LOG-01 (the PLATFORM REQUEST that
  this doc scopes)
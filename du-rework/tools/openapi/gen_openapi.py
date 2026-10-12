"""Generate du-rework/docs/21-openapi.json from router + contract source.

Usage: python du-rework/tools/openapi/gen_openapi.py
Exit 0 on success. Docs-only: reads server sources, writes one JSON doc.

The operations-list query surface is DERIVED from @du/contracts, not retyped
here: Reviewer T140-D1 found a reproducibility gap where this script still
advertised only limit/cursor while docs/21-openapi.json carried six parameters,
so a fresh run silently erased the documented contract. A second guard asserts
the written doc never loses a path the previous artifact had.

RESULT-WIRE-01 (2026-09-28): the same failure shape reached the result surface. The
spec advertised a bare "ResultEnvelope" with no schemaVersion, no encrypted delivery
variant and no download route, while x-absent still claimed the download route did
not exist - server.ts had implemented it since CR-12/MM-02. components.schemas now
carries the delivery shapes read from packages/contracts/src, and the guards below
assert the written artifact kept both variants of both routes.

COST-03 (2026-09-28): GET /api/v1/usage/events was the same failure once more. The route had
existed in server.ts with a settled prose contract in docs/20, and the spec advertised
neither the path nor one of its schemas. The thirteen parameters are now derived from
packages/contracts/src instead of retyped, and the guards below assert the written
artifact kept them.

SWAGGER-ORIGIN-DOCS-ALIGNMENT (2026-10-06): every operation is stamped with the origin of
its PM-M02 ingress family instead of a single legacy "http://localhost:2023" default -
public JSON (Orchestrator 3000), internal JSON for admin/management and runtime
(Orchestrator 3002, unpublished by default), and the Connector service (8080, unpublished
by default). Operations also carry tags/x-api-family so a Portal Swagger UI can filter
Public/Admin/Runtime/Connector without guessing from prose. Deployments override the
origins at generation time with DU_OPENAPI_PUBLIC_ORIGIN, DU_OPENAPI_INTERNAL_ORIGIN and
DU_OPENAPI_CONNECTOR_ORIGIN; the artifact remains the single generated source of truth.
"""
import base64, io, json, os, re, sys, subprocess
from pathlib import Path

# Resolve inputs from the script, so the documented command works in du-rework
# as well as the parent repository. No dependence on the caller's cwd.
os.chdir(Path(__file__).resolve().parents[3])

ORCH = "du-rework/orchestrator/services/orchestrator/src/server.ts"
CONN = "du-rework/orchestrator/services/connector/src/http/server.ts"
CONTRACT = "du-rework/orchestrator/packages/contracts/src/public-api.ts"
METRICS = "du-rework/orchestrator/packages/contracts/src/usage-metrics.ts"
RECON = "du-rework/orchestrator/packages/contracts/src/usage-reconciliation.ts"
USAGE_SERVICE = "du-rework/orchestrator/services/orchestrator/src/modules/usage/usage.ts"
COMPOSE = "du-rework/orchestrator/services/orchestrator/src/modules/compose-operations/contracts.ts"
OUT = "du-rework/docs/21-openapi.json"

# ---- PM-M02 ingress origins (SWAGGER-ORIGIN-DOCS-ALIGNMENT) ------------------
# Public and internal JSON are separate listeners of the same Orchestrator
# process; the Connector keeps its own service origin. Deployments set the
# real front-door origins at generation time; the defaults match the native
# PM-M02 host mapping (public bound to 127.0.0.1:3000, internal 3002 and
# Connector 8080 unpublished unless the debug overlay is explicitly applied).
def _origin(env_name, default):
    value = os.environ.get(env_name, default).strip().rstrip("/")
    assert value.startswith("http://") or value.startswith("https://"), (
        "%s must be an http(s) origin, got %r" % (env_name, value))
    return value

PUBLIC_ORIGIN = _origin("DU_OPENAPI_PUBLIC_ORIGIN", "http://localhost:3000")
INTERNAL_ORIGIN = _origin("DU_OPENAPI_INTERNAL_ORIGIN", "http://localhost:3002")
CONNECTOR_ORIGIN = _origin("DU_OPENAPI_CONNECTOR_ORIGIN", "http://localhost:8080")
PORTAL_ORIGIN = _origin('DU_OPENAPI_PORTAL_ORIGIN', 'http://localhost:3001')

FAMILY_SERVERS = {
    "public": [{"url": PUBLIC_ORIGIN,
                "description": "PM-M02 Public JSON ingress (Orchestrator 3000). Admin and runtime routes are rejected on this listener."}],
    "admin": [{"url": INTERNAL_ORIGIN,
               "description": "PM-M02 Internal JSON ingress (Orchestrator 3002, unpublished by default). Admin/management family; authorization is unchanged by the listener."}],
    "runtime": [{"url": INTERNAL_ORIGIN,
                 "description": "PM-M02 Internal JSON ingress (Orchestrator 3002, unpublished by default). Worker/service Runtime family; authorization is unchanged by the listener."}],
    "connector": [{"url": CONNECTOR_ORIGIN,
                   "description": "Internal Connector origin (unpublished by default); override for deployment. No /internal/v1 or /management prefix."}],
}

FAMILY_TAGS = [
    {"name": "public", "description": "Public JSON ingress, Orchestrator 3000."},
    {"name": "admin", "description": "Internal JSON ingress, Orchestrator 3002: admin/management routes."},
    {"name": "runtime", "description": "Internal JSON ingress, Orchestrator 3002: worker/service Runtime routes."},
    {"name": "connector", "description": "Connector service root-path contract, origin 8080."},
]

def op(summary, auth, req=None, resps=None, params=None):
    o = {"summary": summary}
    if auth:
        # A list means several auth paths on ONE contract (the operations list
        # and the usage event page both have two); a bare dict keeps the
        # single-path shape every other route has.
        o["security"] = auth if isinstance(auth, list) else [auth]
    if params:
        o["parameters"] = params
    if req:
        o["requestBody"] = req
    o["responses"] = resps or {"200": {"description": "ok"}}
    return o

def ex(value):
    return {"content": {"application/json": {"example": value}}}

def mint_cursor(iso, uid, sort, backward=False):
    """Encode an operations cursor with the SAME formula as server.ts
    encodeOperationsListCursor: base64url(`ISO|uuid|field:direction[|p]`).
    Minting the example rather than typing it is the point: a hand-written
    string becomes a second source of truth that can drift from the grammar
    the cursor parameter below advertises.
    """
    marker = "|p" if backward else ""
    payload = iso + "|" + uid + "|" + sort + marker
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")

# ---- contract source: single source of truth for the operations list --------

def ts_list(src, name):
    """Every quoted string inside export const <name> = [ ... ]."""
    m = re.search(r"export const " + name + r"\s*=\s*\[(.*?)\]", src, re.S)
    assert m, "cannot find array %s in %s" % (name, CONTRACT)
    return re.findall(r"'([^']*)'", m.group(1))

def ts_string(src, name):
    m = re.search(r"export const " + name + r"(?:\s*:\s*[^=]+)?\s*=\s*'([^']*)'", src)
    assert m, "cannot find string %s in %s" % (name, CONTRACT)
    return m.group(1)

def ts_number(src, name):
    m = re.search(r"export const " + name + r"(?:\s*:\s*[^=]+)?\s*=\s*(\d+)", src)
    assert m, "cannot find number %s in %s" % (name, CONTRACT)
    return int(m.group(1))

def ts_regex(src, name):
    m = re.search(r"export const " + name + r"\s*=\s*/(.*?)/[a-z]*\s*;", src, re.S)
    assert m, "cannot find regex %s in %s" % (name, CONTRACT)
    return m.group(1)

def ts_enum(src, name):
    """Quoted strings of a z.enum([...]) or a [... ] as const export."""
    m = re.search(r"export const " + name + r"(?:\s*:\s*[^=]+)?\s*=\s*(?:z\.enum\(\s*)?\[(.*?)\]", src, re.S)
    assert m, "cannot find enum %s" % name
    return re.findall(r"'([^']*)'", m.group(1))

def ts_object_keys(src, name):
    """Top-level keys of a z.object({ ... }).strict() export."""
    m = re.search(r"export const " + name + r"\s*=\s*z\.object\(\{", src)
    assert m, "cannot find z.object %s" % name
    body = src[m.end():]
    end = body.find("}).strict()")
    assert end != -1, "cannot find the .strict() terminator of %s" % name
    return re.findall(r"^ {2}(\w+):", body[:end], re.M)

def ts_interface_keys(src, name):
    """Top-level fields of a flat TS interface, used for public projection DTOs."""
    m = re.search(r"export interface " + name + r"\s*\{(.*?)^\}", src, re.S | re.M)
    assert m, "cannot find interface %s" % name
    return re.findall(r"^ {2}(\w+)\??:", m.group(1), re.M)

def _usage_limit_bounds(src, key):
    m = re.search(r"^ {2}" + key + r":[^\n]*?\.max\((\d+)\)\.default\((\d+)\)", src, re.M)
    assert m, "cannot find %s bounds and default" % key
    return int(m.group(1)), int(m.group(2))

def ts_bound_int(src, name, key):
    return _usage_limit_bounds(src, key)[0]

def ts_default_int(src, name, key):
    return _usage_limit_bounds(src, key)[1]

def ts_default_literal(src, name, key):
    m = re.search(r"^ {2}" + key + r":\s*\w+Schema\.default\('([^']*)'\)", src, re.M)
    assert m, "cannot find %s default literal" % key
    return m.group(1)

_c = io.open(CONTRACT, encoding="utf-8").read()

QUERY_PARAMS = ts_list(_c, "OPERATIONS_LIST_QUERY_PARAMS")
# WFA-ADMIN-TENANTS. Same reason as the operations list: the allow-list is read
# from the contract instead of retyped, so a new parameter cannot be published
# without documenting it and a removed one cannot keep its parameter.
TENANT_LIST_QUERY_PARAMS = ts_list(_c, "TENANT_LIST_QUERY_PARAMS")
assert TENANT_LIST_QUERY_PARAMS == ["limit", "cursor"], (
    "tenant list allow-list changed to %r; the advertised parameters follow the contract"
    % (TENANT_LIST_QUERY_PARAMS,))
SORT_FIELDS = ts_list(_c, "OPERATIONS_LIST_SORT_FIELDS")
SORT_DIRECTIONS = ts_list(_c, "OPERATIONS_LIST_SORT_DIRECTIONS")
# OPERATIONS_LIST_SORT_VALUES is a flatMap in the contract; reproduce it exactly.
SORT_VALUES = [f + ":" + d for f in SORT_FIELDS for d in SORT_DIRECTIONS]
SORT_DEFAULT = (ts_string(_c, "OPERATIONS_LIST_SORT_DEFAULT_FIELD") + ":"
               + ts_string(_c, "OPERATIONS_LIST_SORT_DEFAULT_DIRECTION"))
# ALL is the internal "no filter" value; the route keeps it off the wire
# (server.ts filters it out of the advertised enum), so it is not advertised.
STATE_VALUES = [v for v in ts_list(_c, "OPERATIONS_STATE_FILTER_VALUES") if v != "ALL"]
TOKEN_PATTERN = ts_regex(_c, "OPERATIONS_LIST_TOKEN_PATTERN")
LIMIT_DEFAULT = ts_number(_c, "OPERATIONS_LIST_LIMIT_DEFAULT")
LIMIT_MAX = ts_number(_c, "OPERATIONS_LIST_LIMIT_MAX")
# COST-03 contract surface. The allow-list, the id pattern and the enums are read
# from the package rather than retyped, for the same reason the operations list
# is: a retyped value is a second source of truth that silently drifts.
_m = io.open(METRICS, encoding="utf-8").read()
_r = io.open(RECON, encoding="utf-8").read()

USAGE_ID_PATTERN = ts_regex(_m, "USAGE_ATTRIBUTION_ID_PATTERN")
USAGE_COST_STATUSES = ts_list(_m, "UsageCostStatus")
USAGE_UNIT_TYPES = ts_list(_m, "UsageUnitType")
USAGE_EVENT_KINDS = ["initial", "correction", "refund"]
TIME_FIELD_VALUES = ts_enum(_r, "UsageAggregateTimeFieldSchema")
USAGE_EVENT_QUERY_PARAMS = ts_object_keys(_r, "UsageEventDrilldownQuerySchema")
USAGE_EVENT_LIMIT_MAX, USAGE_EVENT_LIMIT_DEFAULT = _usage_limit_bounds(
    _r, "limit")
TIME_FIELD_DEFAULT = ts_default_literal(_r, "UsageEventDrilldownQuerySchema", "timeField")

assert USAGE_EVENT_QUERY_PARAMS == ["tenantId", "apiKeyId", "businessId", "action",
                                    "profileRevision", "provider", "model",
                                    "operationId", "from", "to", "timeField",
                                    "limit", "cursor"], (
    "UsageEventDrilldownQuerySchema keys changed to %r; add its OpenAPI parameter here"
    % (USAGE_EVENT_QUERY_PARAMS,))
assert USAGE_COST_STATUSES == ["measured", "estimated", "pending", "unpriced"], (
    "UsageCostStatus changed to %r" % (USAGE_COST_STATUSES,))
assert TIME_FIELD_VALUES == ["occurredAt", "receivedAt"], (
    "UsageAggregateTimeFieldSchema changed to %r" % (TIME_FIELD_VALUES,))
assert TIME_FIELD_DEFAULT == "occurredAt", (
    "timeField default changed to %r" % (TIME_FIELD_DEFAULT,))

# BASIC_ADMIN_USAGE_V1 is intentionally a distinct admin projection from the
# rich public COST exporter above. Keep its persisted-wire fields independently
# represented; unavailable attribution/provenance fields are not invented.
_admin_usage = io.open(USAGE_SERVICE, encoding="utf-8").read()
ADMIN_USAGE_RECORD_FIELDS = ts_interface_keys(_admin_usage, "AdminUsageEventRecord")
ADMIN_USAGE_PAGE_FIELDS = ts_interface_keys(_admin_usage, "AdminUsageEventPage")
assert ADMIN_USAGE_RECORD_FIELDS == ["eventId", "operationId", "taskId", "invocationId", "provider", "model", "units", "costMicrousd", "costStatus", "measurement", "occurredAt", "receivedAt"], (
    "AdminUsageEventRecordSchema changed to %r; update its OpenAPI projection" % ADMIN_USAGE_RECORD_FIELDS)
assert ADMIN_USAGE_PAGE_FIELDS == ["tenantId", "events", "limit", "hasMore", "nextCursor", "skippedInvalidEvents", "timeSemantics"], (
    "AdminUsageEventPageSchema changed to %r; update its OpenAPI projection" % ADMIN_USAGE_PAGE_FIELDS)



# The example token in the operations page response is minted, not typed.
# The string A23 inherited decoded to a TRUNCATED payload carrying a
# literal <uuid> placeholder and a malformed instant, so it contradicted
# the very grammar this file advertises. SORT_DEFAULT comes from the contract.
EXAMPLE_ISO = "2026-09-26T00:00:00.000Z"
EXAMPLE_UUID = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff"
EXAMPLE_CURSOR = mint_cursor(EXAMPLE_ISO, EXAMPLE_UUID, SORT_DEFAULT)
EXAMPLE_PAYLOAD = EXAMPLE_ISO + "|" + EXAMPLE_UUID + "|" + SORT_DEFAULT
EXAMPLE_DECODED = base64.urlsafe_b64decode(
    EXAMPLE_CURSOR + "=" * (-len(EXAMPLE_CURSOR) % 4)).decode("utf-8")
assert EXAMPLE_DECODED == EXAMPLE_PAYLOAD, (
    "example cursor decodes to %r, not the payload it claims" % (EXAMPLE_DECODED,))
assert len(EXAMPLE_CURSOR) <= 128, (
    "example cursor exceeds the bound the page schema, route and shell share: %d"
    % len(EXAMPLE_CURSOR))

assert QUERY_PARAMS == ["limit", "cursor", "state", "tenant", "id", "sort", "from", "to"], (
    "OPERATIONS_LIST_QUERY_PARAMS changed to %r; add its OpenAPI parameter here"
    % (QUERY_PARAMS,))
assert SORT_VALUES == ["created_at:asc", "created_at:desc", "updated_at:asc",
                       "updated_at:desc", "deadline_at:asc", "deadline_at:desc"], (
    "sort allow-list changed to %r; the advertised enum follows the contract"
    % (SORT_VALUES,))
assert SORT_VALUES[SORT_VALUES.index(SORT_DEFAULT)] == SORT_DEFAULT


def page_schema():
    """The five-field list envelope (OperationsListPageSchema, strict)."""
    return {"type": "object",
            "required": ["items", "nextCursor", "prevCursor", "total", "limit"],
            "properties": {
                "items": {"type": "array", "items": {"type": "object"}},
                "nextCursor": {"type": "string", "nullable": True},
                "prevCursor": {"type": "string", "nullable": True},
                "total": {"type": "integer"},
                "limit": {"type": "integer"},
            }}

def page_response(description, example):
    return {"description": description,
            "content": {"application/json": {"schema": page_schema(), "example": example}}}

def param(name, description, schema):
    return {"name": name, "in": "query", "description": description, "schema": schema}

# ---- result + artifact delivery wire shapes (RESULT-WIRE-01) ---------------
# The spec advertised a bare "ResultEnvelope" with no schemaVersion, no
# encrypted variant and no download route at all, so a reader of this file
# could not tell a MIME proxy from an encrypted delivery. The shapes are read
# from the zod source (packages/contracts/src/operations.ts and encryption.ts)
# rather than from a receipt, and strictness is copied honestly: a zod object
# without .strict() is not published as additionalProperties: false.

def obj_schema(props, required, strict=False):
    """A zod object as JSON Schema. strict mirrors .strict() and nothing else."""
    s = {"type": "object", "required": required, "properties": props}
    if strict:
        s["additionalProperties"] = False
    return s

def ref(name):
    return {"$ref": "#/components/schemas/" + name}

USAGE_SCHEMA = obj_schema({
    "inputTokens": {"type": "integer", "minimum": 0},
    "outputTokens": {"type": "integer", "minimum": 0},
    "costMicrousd": {"type": "integer", "minimum": 0,
                     "description": "Integer micro-USD. A money integer on purpose: no float ever crosses this field."},
    "measurement": {"type": "string",
                    "enum": ["measured", "estimated", "pending", "final", "corrected"]},
}, ["inputTokens", "outputTokens", "costMicrousd", "measurement"])
USAGE_SCHEMA["description"] = "UsageSchema (operations.ts). Not .strict() in the contract, so it is not additionalProperties: false here."

ARTIFACT_REF_SCHEMA = obj_schema({
    "artifactId": {"type": "string", "format": "uuid"},
    "role": {"type": "string", "default": "output",
             "description": "Top-level role from the submit_artifacts declaration for a declared input, else the stored purpose (input|output)."},
    "fileName": {"type": "string"},
    "mimeType": {"type": "string"},
    "sizeBytes": {"type": "integer", "minimum": 0},
    "hashSha256": {"type": "string"},
    "download": {"type": "string",
                 "description": "Relative public URL, /api/v1/artifacts/{id}/download. Tenant-scoped and grant-free; the id still has to pass the READY and SUCCEEDED checks of that route."},
}, ["artifactId", "role"])
ARTIFACT_REF_SCHEMA["description"] = "ArtifactRefSchema (operations.ts). role carries a zod default, so it is optional to a producer and always present on this route's wire."

RESULT_ENVELOPE_SCHEMA = obj_schema({
    "schemaVersion": {"type": "string", "enum": ["1"],
                      "description": "Envelope version. Literal '1'; a v1 reader must refuse anything else rather than guess."},
    "data": {"description": "Opaque worker result. This route copies result_ref verbatim as {resultRef} and never guesses an inner envelope."},
    "artifacts": {"type": "array", "items": ref("ArtifactRef"),
                  "description": "REAL refs: submit-declared inputs plus task-produced READY outputs. This route projects them from a join; it never returns the [] the contract default allows."},
    "usage": ref("Usage"),
    "warnings": {"type": "array", "items": {"type": "string"},
                 "description": "Defaults to [] in the contract; this route currently always sends []."},
}, ["schemaVersion", "data", "artifacts", "usage", "warnings"], strict=True)
RESULT_ENVELOPE_SCHEMA["description"] = "ResultEnvelopeSchema (operations.ts), the PLAIN variant of the result wire. Strict."

ENCRYPTED_RESULT_ENVELOPE_SCHEMA = obj_schema({
    "schemaVersion": {"type": "string", "enum": ["1"]},
    "encrypted": {"type": "boolean", "enum": [True],
                  "description": "Always true. Present so a client can branch without inferring from the absence of data."},
    "delivery": ref("RecipientDeliveryEnvelope"),
}, ["schemaVersion", "encrypted", "delivery"], strict=True)
ENCRYPTED_RESULT_ENVELOPE_SCHEMA["description"] = "EncryptedResultEnvelopeSchema (operations.ts). Decrypting delivery yields the exact ResultEnvelope above."

DELIVERY_ENVELOPE_SCHEMA = obj_schema({
    "version": {"type": "integer", "enum": [1],
                "description": "Delivery envelope version, always 1."},
    "suite": {"type": "string", "enum": ["hpke-rfc9180", "rsa-oaep-sha256"],
              "description": "hpke-rfc9180 = DHKEM(X25519)/HKDF-SHA256 with an AES-256-GCM payload, the preferred suite; rsa-oaep-sha256 = RSA-OAEP-SHA256 key wrap over an AES-256-GCM payload, kept for enterprise and legacy recipients."},
    "recipientKeyId": {"type": "string", "minLength": 1, "maxLength": 256},
    "recipientKeyVersion": {"type": "integer", "minimum": 1,
                            "description": "Pinned at result-generation time, not read back from current tenant state."},
    "enc": {"type": "string",
            "description": "Base64 (RFC 4648) encapsulated or wrapped delivery DEK."},
    "nonce": {"type": "string",
              "description": "Base64 payload nonce, 12 bytes for AES-GCM."},
    "tag": {"type": "string",
            "description": "Base64 payload GCM auth tag, 16 bytes."},
    "ciphertext": {"type": "string", "description": "Base64 encrypted payload."},
    "aad": {"type": "string",
            "description": "Optional base64 AAD; a wire-profile decision, not a per-request input."},
}, ["version", "suite", "recipientKeyId", "recipientKeyVersion", "enc", "nonce",
    "tag", "ciphertext"], strict=True)
DELIVERY_ENVELOPE_SCHEMA["description"] = "RecipientDeliveryEnvelopeSchema (encryption.ts), shared by the encrypted result and the encrypted download. Strict."

ENCRYPTED_ARTIFACT_DOWNLOAD_SCHEMA = obj_schema({
    "schemaVersion": {"type": "string", "enum": ["1"]},
    "encrypted": {"type": "boolean", "enum": [True]},
    "delivery": ref("RecipientDeliveryEnvelope"),
    "artifactId": {"type": "string", "format": "uuid"},
    "mimeType": {"type": "string", "minLength": 1, "maxLength": 255,
                 "description": "The artifact's stored MIME, defaulted server-side to application/octet-stream. It names the PLAINTEXT a recipient recovers after decrypting; it is NOT the response content type, which is application/json for this variant."},
}, ["schemaVersion", "encrypted", "delivery", "artifactId", "mimeType"], strict=True)
ENCRYPTED_ARTIFACT_DOWNLOAD_SCHEMA["description"] = "EncryptedArtifactDownloadSchema (operations.ts): the same bytes as the plain download, carried as a JSON wrapper. Strict."

RESULT_RESPONSE_SCHEMA = {
    "oneOf": [ref("ResultEnvelope"), ref("EncryptedResultEnvelope")],
    "description": "ResultResponseSchema (operations.ts) = ResultEnvelope | EncryptedResultEnvelope. Exactly one branch matches, and which one is decided by the server-side tenant policy, never by a request parameter.",
}

ARTIFACT_DOWNLOAD_RESPONSE_SCHEMA = {
    "oneOf": [{"type": "string", "format": "binary"}, ref("EncryptedArtifactDownload")],
    "description": "ArtifactDownloadResponseSchema (operations.ts) = plain bytes | EncryptedArtifactDownload. The plain branch is a byte string or an async byte stream, which JSON Schema cannot express, so it is published as format: binary and the response content map names its media type.",
}


# ---- COST-03 usage drill-down / export (docs/20-openapi-descriptions.md §1, §6.1)
# The prose in docs/20 settled the contract; these shapes are read from
# packages/contracts/src (usage-reconciliation.ts, usage-metrics.ts) so the
# machine-readable companion cannot drift from the contract a second time.

USAGE_TIME_SEMANTICS_SCHEMA = obj_schema({
    "field": {"type": "string", "enum": TIME_FIELD_VALUES},
    "order": {"type": "string", "enum": ["asc"]},
    "timezone": {"type": "string", "enum": ["UTC"]},
}, ["field", "order", "timezone"], strict=True)
USAGE_TIME_SEMANTICS_SCHEMA["description"] = "Which ledger clock answered the window, published rather than assumed. The route always sends order asc and timezone UTC (usage-reconciliation.ts UsageEventExportPageSchema)."

USAGE_LEDGER_UNITS_SCHEMA = obj_schema({
    "inputTokens": {"type": "integer", "minimum": 0},
    "outputTokens": {"type": "integer", "minimum": 0},
    "cachedInputTokens": {"type": "integer", "minimum": 0},
    "pages": {"type": "integer", "minimum": 0},
}, ["inputTokens", "outputTokens"], strict=True)
USAGE_LEDGER_UNITS_SCHEMA["description"] = "UsageLedgerUnitsSchema (usage-metrics.ts). Strict. cachedInputTokens and pages are optional; the other two default to 0."

USAGE_LEDGER_EVENT_SCHEMA = obj_schema({
    "eventId": {"type": "string", "minLength": 1, "maxLength": 128,
                "description": "The dedup key. A duplicate delivery of one eventId counts exactly once."},
    "idempotencyKey": {"type": "string", "pattern": USAGE_ID_PATTERN,
                       "description": "Stable request key reused when delivery of this event is retried."},
    "kind": {"type": "string", "enum": USAGE_EVENT_KINDS, "default": "initial",
             "description": "initial, correction or refund. A correction or refund is a NEW event linked by correctsEventId; the original row is never rewritten."},
    "correctsEventId": {"type": "string", "minLength": 1, "maxLength": 128,
                        "description": "Required for kind correction and refund, forbidden for initial, and never equal to this eventId."},
    "tenantId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "apiKeyId": {"type": "string", "pattern": USAGE_ID_PATTERN,
                 "description": "Identifier only. Key material has no representation on this route."},
    "operationId": {"type": "string", "format": "uuid"},
    "taskId": {"type": "string", "format": "uuid"},
    "invocationId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "attempt": {"type": "integer", "minimum": 1},
    "stepKey": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "businessId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "businessVersion": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "action": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "profileRevision": {"type": "integer", "minimum": 0},
    "connectorId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "connectorRevision": {"type": "integer", "minimum": 0},
    "provider": {"type": "string", "pattern": USAGE_ID_PATTERN,
                 "description": "Provider actually used, snapshotted at invocation time and never re-derived from current configuration."},
    "model": {"type": "string", "pattern": USAGE_ID_PATTERN,
              "description": "Model actually used, snapshotted at invocation time."},
    "unitType": {"type": "string", "enum": USAGE_UNIT_TYPES,
                 "description": "tokens, pages or mixed. mixed when the provider reported both families."},
    "units": ref("UsageLedgerUnits"),
    "costMicrousd": {"type": "integer", "minimum": 0, "default": 0,
                     "description": "Integer micro-USD. Must be 0 when costStatus is pending or unpriced: unsettled usage may not carry an implied cost."},
    "currency": {"type": "string", "enum": ["USD"], "default": "USD"},
    "costStatus": {"type": "string", "enum": USAGE_COST_STATUSES,
                   "description": "measured differs from estimated differs from pending differs from unpriced; the four are never collapsed."},
    "durationMs": {"type": "integer", "minimum": 0},
    "occurredAt": {"type": "string", "format": "date-time",
                   "description": "RFC 3339 with optional numeric offset; UTC Z always accepted."},
    "receivedAt": {"type": "string", "format": "date-time",
                   "description": "When the ledger row landed, as opposed to when the usage occurred."},
}, ["eventId", "idempotencyKey", "kind", "tenantId", "apiKeyId", "operationId",
    "taskId", "invocationId", "attempt", "stepKey", "businessId",
    "businessVersion", "action", "profileRevision", "connectorId",
    "connectorRevision", "provider", "model", "unitType", "units",
    "costMicrousd", "currency", "costStatus", "durationMs", "occurredAt",
    "receivedAt"], strict=True)
USAGE_LEDGER_EVENT_SCHEMA["description"] = "UsageLedgerEventSchema (usage-metrics.ts), the record this route exports. Strict: prompts, documents, credentials, URLs and upstream error bodies have no representation."

USAGE_EVENT_PAGE_SCHEMA = obj_schema({
    "tenantId": {"type": "string", "pattern": USAGE_ID_PATTERN,
                 "description": "The authorized scope, echoed back. It comes from the principal, never from the query."},
    "events": {"type": "array", "maxItems": 100, "items": ref("UsageLedgerEvent")},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
    "hasMore": {"type": "boolean",
                "description": "True exactly when nextCursor is present; the two can never disagree."},
    "nextCursor": {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"},
    "skippedInvalidEvents": {"type": "integer", "minimum": 0,
                              "description": "Rows dropped because their payload was not a valid ledger event. Counted, never returned raw, so a corrupt row cannot silently shrink a page unnoticed."},
    "timeSemantics": ref("UsageTimeSemantics"),
}, ["tenantId", "events", "limit", "hasMore", "skippedInvalidEvents",
    "timeSemantics"], strict=True)
USAGE_EVENT_PAGE_SCHEMA["description"] = "UsageEventExportPageSchema (usage-reconciliation.ts): one bounded page, usable by both a drill-down UI and a streamed export client. Strict."

USAGE_EVENT_CURSOR_SCHEMA = obj_schema({
    "version": {"type": "integer", "enum": [1]},
    "tenantId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "queryHash": {"type": "string", "pattern": "^[a-f0-9]{64}$",
                  "description": "sha256 over the tenant and the eleven-key filter binding. A cursor minted for one query is refused by any other."},
    "after": {"type": "string", "format": "date-time"},
    "eventId": {"type": "string", "minLength": 1, "maxLength": 128},
}, ["version", "tenantId", "queryHash", "after", "eventId"], strict=True)
USAGE_EVENT_CURSOR_SCHEMA["description"] = "UsageEventDrilldownCursorSchema (usage-reconciliation.ts): the decoded payload of the opaque base64url cursor. Published so a client can read the grammar without guessing."

USAGE_EVENT_QUERY_SCHEMA = obj_schema({
    "tenantId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "apiKeyId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "businessId": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "action": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "profileRevision": {"type": "integer", "minimum": 0},
    "provider": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "model": {"type": "string", "pattern": USAGE_ID_PATTERN},
    "operationId": {"type": "string", "format": "uuid"},
    "from": {"type": "string", "format": "date-time"},
    "to": {"type": "string", "format": "date-time"},
    "timeField": {"type": "string", "enum": TIME_FIELD_VALUES, "default": TIME_FIELD_DEFAULT},
    "limit": {"type": "integer", "minimum": 1, "maximum": USAGE_EVENT_LIMIT_MAX, "default": USAGE_EVENT_LIMIT_DEFAULT},
    "cursor": {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"},
}, USAGE_EVENT_QUERY_PARAMS, strict=True)
USAGE_EVENT_QUERY_SCHEMA["description"] = "UsageEventDrilldownQuerySchema (usage-reconciliation.ts) as an object shape. On the wire these thirteen names are query parameters, not a JSON body."

_USAGE_ID = {"type": "string", "pattern": USAGE_ID_PATTERN}
_USAGE_INT = {"type": "integer", "minimum": 0, "pattern": "^\\d+$"}
_USAGE_TS = {"type": "string", "format": "date-time"}

USAGE_EVENTS_PARAMS = [
    param("tenantId", "Optional consistency check only. Scope is taken from the principal: an admin bearer may read any tenant it is authorized for and then REQUIRES this parameter (422 when absent), while an API key is pinned to its own tenant and a mismatch here is 403. Hashed into the cursor, so changing it invalidates a cursor.", _USAGE_ID),
    param("apiKeyId", "Attribution dimension filter, hashed into the cursor.", _USAGE_ID),
    param("businessId", "Must be supplied TOGETHER with action; one half of that pair is 422, never a wider result set.", _USAGE_ID),
    param("action", "Must be supplied TOGETHER with businessId.", _USAGE_ID),
    param("profileRevision", "Non-negative integer; the route rejects anything that is not a plain digit string before the schema runs.", _USAGE_INT),
    param("provider", "Must be supplied TOGETHER with model; one half of that pair is 422.", _USAGE_ID),
    param("model", "Must be supplied TOGETHER with provider.", _USAGE_ID),
    param("operationId", "Exact operation id, uuid.", {"type": "string", "format": "uuid"}),
    param("from", "Half-open window start, inclusive. Paired with to, which must be strictly after from: an empty span is 422 rather than a silent full-table read.", _USAGE_TS),
    param("to", "Half-open window end, EXCLUSIVE. Strictly after from.", _USAGE_TS),
    param("timeField", "Which ledger clock orders and windows this query, published rather than assumed. The choice is echoed back in timeSemantics. Hashed into the cursor, so a cursor minted on one clock is refused on the other.", {"type": "string", "enum": TIME_FIELD_VALUES, "default": TIME_FIELD_DEFAULT}),
    param("limit", "1..%d, default %d. The page size; the query fetches at most limit+1 rows and the extra row is only the hasMore signal." % (USAGE_EVENT_LIMIT_MAX, USAGE_EVENT_LIMIT_DEFAULT), {"type": "integer", "minimum": 1, "maximum": USAGE_EVENT_LIMIT_MAX, "default": USAGE_EVENT_LIMIT_DEFAULT}),
    param("cursor", "Opaque base64url keyset position over (timeField, event_id). It carries the tenant and a sha256 of the eleven-key filter binding, so re-using it with another tenant, filter, window, clock or page size is 422 INVALID_ARGUMENT, refused before SQL is built. A non-canonical base64url spelling is rejected too, so one cursor has exactly one encoding.", {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"}),
]

# WFA-ADMIN-TENANTS: the roster item and its five-field page. The shape is the
# contract one (AdminTenantSchema / AdminTenantsPageSchema, public-api.ts); both
# zod objects are .strict(), so strict=True copies the contract honestly.
TENANT_SCHEMA = obj_schema({
    "id": {"type": "string", "format": "uuid",
           "description": "Tenant id; the tie-break half of the (lower(name), id) keyset order."},
    "name": {"type": "string",
             "description": "Display name. The picker orders on lower(name), which is why this list exposes no sort parameter."},
    "state": {"type": "string",
              "description": "Tenant lifecycle state as stored; not an allow-listed enum at this boundary."},
}, ["id", "name", "state"], strict=True)

TENANTS_PAGE_SCHEMA = obj_schema({
    "items": {"type": "array", "items": ref("AdminTenant")},
    "nextCursor": {"type": "string", "nullable": True,
                   "description": "Opaque forward token, null on the last page. The tenant module mints its own id+direction token bounded by LIST_CURSOR_MAX_LEN, not the shared timestamp cursor dialect."},
    "prevCursor": {"type": "string", "nullable": True,
                   "description": "Opaque backward token, null on page one."},
    "total": {"type": "integer",
              "description": "COUNT(*) of the filtered set, never items.length."},
    "limit": {"type": "integer",
              "description": "The clamped page size actually used."},
}, ["items", "nextCursor", "prevCursor", "total", "limit"], strict=True)

# BASIC_ADMIN_USAGE_V1 — a separate, honest projection over persisted
# runtime UsageEvent rows. Nullable cost/provenance means those facts were not
# present in the source row; it never implies measured/estimated cost.
ADMIN_USAGE_ID = {"type": "string", "pattern": USAGE_ID_PATTERN}
ADMIN_USAGE_AMOUNT = {"type": "integer", "minimum": 0, "maximum": 9007199254740991}
ADMIN_USAGE_RECORD_SCHEMA = obj_schema({
    "eventId": {"type": "string", "minLength": 1, "maxLength": 128},
    "operationId": {"type": "string", "format": "uuid"},
    "taskId": {"type": "string", "format": "uuid"},
    "invocationId": {"type": "string", "minLength": 1, "maxLength": 128},
    "provider": {**ADMIN_USAGE_ID, "nullable": True, "description": "Null when the persisted event has no provider attribution."},
    "model": {**ADMIN_USAGE_ID, "nullable": True, "description": "Null when the persisted event has no model attribution."},
    "units": obj_schema({
        "inputTokens": dict(ADMIN_USAGE_AMOUNT),
        "outputTokens": dict(ADMIN_USAGE_AMOUNT),
        "pages": dict(ADMIN_USAGE_AMOUNT),
    }, ["inputTokens", "outputTokens"], strict=True),
    "costMicrousd": {**ADMIN_USAGE_AMOUNT, "nullable": True, "description": "Null when the persisted runtime event had no cost field."},
    "costStatus": {"type": "string", "enum": ["measured", "estimated", "unpriced"], "nullable": True,
                   "description": "Null when explicit cost provenance was absent from the persisted event."},
    "measurement": {"type": "string", "enum": ["measured", "estimated"]},
    "occurredAt": {"type": "string", "minLength": 1, "maxLength": 128},
    "receivedAt": {"type": "string", "format": "date-time"},
}, ADMIN_USAGE_RECORD_FIELDS, strict=True)
ADMIN_USAGE_RECORD_SCHEMA["description"] = "AdminUsageEventRecordSchema (BASIC_ADMIN_USAGE_V1). Persisted runtime facts only; richer cost attribution is not inferred."

ADMIN_USAGE_PAGE_SCHEMA = obj_schema({
    "tenantId": ADMIN_USAGE_ID,
    "events": {"type": "array", "maxItems": 100, "items": ref("AdminUsageEventRecord")},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
    "hasMore": {"type": "boolean"},
    "nextCursor": {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"},
    "skippedInvalidEvents": {"type": "integer", "minimum": 0, "maximum": 9007199254740991},
    "timeSemantics": obj_schema({
        "field": {"type": "string", "enum": ["receivedAt"]},
        "order": {"type": "string", "enum": ["asc"]},
        "timezone": {"type": "string", "enum": ["UTC"]},
    }, ["field", "order", "timezone"], strict=True),
}, ADMIN_USAGE_PAGE_FIELDS, strict=True)
ADMIN_USAGE_PAGE_SCHEMA["description"] = "AdminUsageEventPageSchema (BASIC_ADMIN_USAGE_V1). Tenant-scoped keyset page; invalid rows are counted and omitted."

ADMIN_USAGE_QUERY_SCHEMA = obj_schema({
    "tenantId": {**ADMIN_USAGE_ID, "description": "Optional scope check; tenant role is server-bound. Platform Admin must provide tenantId."},
    "from": {"type": "string", "format": "date-time"},
    "to": {"type": "string", "format": "date-time"},
    "timeField": {"type": "string", "enum": ["receivedAt"], "default": "receivedAt"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
    "cursor": {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"},
    "operationId": {"type": "string", "format": "uuid"},
    "provider": ADMIN_USAGE_ID,
    "model": ADMIN_USAGE_ID,
}, ["from", "to"], strict=True)
ADMIN_USAGE_QUERY_SCHEMA["description"] = "AdminUsageEventQuerySchema. The [from,to) window is required and bounded to 366 days; provider and model filters are paired; cursor is bound to tenant and full query."

# Bounded Compose DTOs are copied from contracts.ts. These schemas expose only
# sanitized host observations, state and pinned image facts; no environment,
# filesystem paths, command output or credentials are present.
COMPOSE_ID = {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"}
COMPOSE_SHA = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
COMPOSE_TIME = {"type": "string", "format": "date-time"}
COMPOSE_ACTIONS = ["apply_release", "rollback_release", "restart_service"]
COMPOSE_STATES = ["QUEUED", "CLAIMED", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL", "UNKNOWN", "RECONCILED"]
COMPOSE_ERRORS = ["RUNNER_NOT_CONFIGURED", "SNAPSHOT_NOT_RECEIVED", "SNAPSHOT_INVALID", "MANIFEST_DIGEST_MISMATCH",
    "DOCKER_UNAVAILABLE", "INVENTORY_UNAVAILABLE", "HEALTHCHECK_FAILED", "COMMAND_FAILED", "COMMAND_TIMEOUT",
    "OUTPUT_LIMIT", "TARGET_BUSY", "STALE_SAMPLE", "STALE_PREVIEW", "TARGET_REVISION_CONFLICT",
    "IDEMPOTENCY_CONFLICT", "EXECUTION_UNCERTAIN", "RUNNER_REPORT_REJECTED"]
COMPOSE_ERROR_SCHEMA = {"type": "string", "enum": COMPOSE_ERRORS}
def _nullable(schema):
    return {**schema, "nullable": True}

COMPOSE_OBSERVED_SCHEMA = obj_schema({
    "serviceId": COMPOSE_ID,
    "containerId": _nullable({"type": "string", "maxLength": 128}),
    "imageId": _nullable({"type": "string", "maxLength": 256}),
    "imageDigest": _nullable({"type": "string", "maxLength": 256}),
    "state": {"type": "string", "enum": ["CREATED", "RUNNING", "PAUSED", "RESTARTING", "EXITED", "DEAD", "REMOVING", "UNKNOWN"]},
    "health": {"type": "string", "enum": ["HEALTHY", "UNHEALTHY", "STARTING", "NONE", "UNKNOWN"], "nullable": True},
    "startedAt": _nullable(COMPOSE_TIME),
    "finishedAt": _nullable(COMPOSE_TIME),
    "observedReleaseId": _nullable(COMPOSE_ID),
}, ["serviceId", "containerId", "imageId", "imageDigest", "state", "health", "startedAt", "finishedAt", "observedReleaseId"], strict=True)

COMPOSE_SERVICE_SCHEMA = obj_schema({"serviceId": COMPOSE_ID, "displayName": {"type": "string", "minLength": 1, "maxLength": 128},
    "restartAllowed": {"type": "boolean"}}, ["serviceId", "displayName", "restartAllowed"], strict=True)
COMPOSE_RELEASE_SCHEMA = obj_schema({
    "releaseId": COMPOSE_ID, "displayName": {"type": "string", "minLength": 1, "maxLength": 128}, "releaseDigest": COMPOSE_SHA,
    "targetServices": {"type": "array", "maxItems": 32, "items": COMPOSE_ID},
    "images": {"type": "array", "maxItems": 32, "items": obj_schema({"serviceId": COMPOSE_ID, "imageDigest": {"type": "string", "maxLength": 256}}, ["serviceId", "imageDigest"], strict=True)},
    "migrationCompatibility": {"type": "string", "enum": ["acknowledged", "not_acknowledged"]},
    "rollbackAllowedFrom": {"type": "array", "maxItems": 64, "items": COMPOSE_ID},
}, ["releaseId", "displayName", "releaseDigest", "targetServices", "images", "migrationCompatibility", "rollbackAllowedFrom"], strict=True)
COMPOSE_ACTIVE_JOB_SCHEMA = obj_schema({"jobId": {"type": "string", "format": "uuid"},
    "state": {"type": "string", "enum": ["QUEUED", "CLAIMED", "RUNNING", "UNKNOWN"]}}, ["jobId", "state"], strict=True)
COMPOSE_CATALOG_PROJECT_SCHEMA = obj_schema({
    "projectId": COMPOSE_ID, "displayName": {"type": "string", "minLength": 1, "maxLength": 128},
    "catalogRevision": _nullable(COMPOSE_SHA), "manifestDigest": _nullable(COMPOSE_SHA),
    "availability": {"type": "string", "enum": ["FRESH", "STALE", "UNAVAILABLE"]},
    "sampledAt": _nullable(COMPOSE_TIME), "receivedAt": _nullable(COMPOSE_TIME),
    "lastErrorCode": _nullable(COMPOSE_ERROR_SCHEMA), "observedDigest": _nullable(COMPOSE_SHA),
    "targetRevision": {"type": "integer", "minimum": 0}, "desiredReleaseId": _nullable(COMPOSE_ID),
    "activeJob": {"oneOf": [ref("ComposeActiveJob"), {"type": "null"}]},
    "services": {"type": "array", "maxItems": 64, "items": ref("ComposeCatalogService")},
    "releases": {"type": "array", "maxItems": 128, "items": ref("ComposeCatalogRelease")},
    "observedServices": {"type": "array", "maxItems": 64, "items": ref("ComposeObservedService")},
}, ["projectId", "displayName", "catalogRevision", "manifestDigest", "availability", "sampledAt", "receivedAt", "lastErrorCode", "observedDigest", "targetRevision", "desiredReleaseId", "activeJob", "services", "releases", "observedServices"], strict=True)
COMPOSE_CATALOG_SCHEMA = obj_schema({
    "configured": {"type": "boolean"}, "hostId": _nullable(COMPOSE_ID), "manifestDigest": _nullable(COMPOSE_SHA),
    "availability": {"type": "string", "enum": ["FRESH", "STALE", "UNAVAILABLE"]},
    "receivedAt": _nullable(COMPOSE_TIME), "lastErrorCode": _nullable(COMPOSE_ERROR_SCHEMA),
    "projects": {"type": "array", "maxItems": 64, "items": ref("ComposeCatalogProject")},
}, ["configured", "hostId", "manifestDigest", "availability", "receivedAt", "lastErrorCode", "projects"], strict=True)

COMPOSE_PREVIEW_REQUEST_SCHEMA = obj_schema({
    "hostId": COMPOSE_ID, "projectId": COMPOSE_ID, "action": {"type": "string", "enum": COMPOSE_ACTIONS},
    "releaseId": COMPOSE_ID, "serviceId": COMPOSE_ID, "reason": {"type": "string", "minLength": 3, "maxLength": 500},
}, ["hostId", "projectId", "action", "reason"], strict=True)
COMPOSE_PREVIEW_SCHEMA = obj_schema({
    "previewId": {"type": "string", "format": "uuid"}, "hostId": COMPOSE_ID, "projectId": COMPOSE_ID,
    "action": {"type": "string", "enum": COMPOSE_ACTIONS}, "releaseId": _nullable(COMPOSE_ID), "serviceId": _nullable(COMPOSE_ID),
    "reason": {"type": "string", "minLength": 3, "maxLength": 500}, "createdAt": COMPOSE_TIME, "expiresAt": COMPOSE_TIME,
    "manifestDigest": COMPOSE_SHA, "observedDigest": COMPOSE_SHA, "expectedTargetRevision": {"type": "integer", "minimum": 0},
    "targetServices": {"type": "array", "maxItems": 64, "items": COMPOSE_ID}, "targetReleaseDigest": _nullable(COMPOSE_SHA),
    "impact": obj_schema({"affectedServices": {"type": "array", "maxItems": 64, "items": COMPOSE_ID},
        "downtime": {"type": "string", "enum": ["possible", "likely"]}, "statefulServicesExcluded": {"type": "boolean", "enum": [True]}},
        ["affectedServices", "downtime", "statefulServicesExcluded"], strict=True),
    "warnings": {"type": "array", "maxItems": 8, "items": {"type": "string", "enum": ["POSSIBLE_SERVICE_INTERRUPTION", "MIGRATION_COMPATIBILITY_ACKNOWLEDGED"]}},
}, ["previewId", "hostId", "projectId", "action", "releaseId", "serviceId", "reason", "createdAt", "expiresAt", "manifestDigest", "observedDigest", "expectedTargetRevision", "targetServices", "targetReleaseDigest", "impact", "warnings"], strict=True)
COMPOSE_SUBMIT_REQUEST_SCHEMA = obj_schema({"previewId": {"type": "string", "format": "uuid"}, "expectedTargetRevision": {"type": "integer", "minimum": 0}}, ["previewId", "expectedTargetRevision"], strict=True)
COMPOSE_OUTCOME_SCHEMA = obj_schema({"serviceId": COMPOSE_ID, "status": {"type": "string", "enum": ["SUCCEEDED", "FAILED", "SKIPPED", "UNKNOWN"]},
    "errorCode": _nullable(COMPOSE_ERROR_SCHEMA)}, ["serviceId", "status", "errorCode"], strict=True)
COMPOSE_JOB_SCHEMA = obj_schema({
    "jobId": {"type": "string", "format": "uuid"}, "previewId": {"type": "string", "format": "uuid"},
    "hostId": COMPOSE_ID, "projectId": COMPOSE_ID, "action": {"type": "string", "enum": COMPOSE_ACTIONS},
    "releaseId": _nullable(COMPOSE_ID), "serviceId": _nullable(COMPOSE_ID), "targetReleaseDigest": _nullable(COMPOSE_SHA),
    "targetServices": {"type": "array", "maxItems": 64, "items": COMPOSE_ID}, "reason": {"type": "string", "minLength": 3, "maxLength": 500},
    "actorLabel": {"type": "string", "minLength": 1, "maxLength": 128}, "state": {"type": "string", "enum": COMPOSE_STATES},
    "stateVersion": {"type": "integer", "minimum": 1}, "expectedTargetRevision": {"type": "integer", "minimum": 0},
    "targetRevision": {"type": "integer", "minimum": 0}, "createdAt": COMPOSE_TIME, "startedAt": _nullable(COMPOSE_TIME),
    "completedAt": _nullable(COMPOSE_TIME), "claimExpiresAt": _nullable(COMPOSE_TIME), "observedBeforeDigest": COMPOSE_SHA,
    "startExpectedObservedDigest": COMPOSE_SHA, "observedBefore": {"type": "array", "maxItems": 64, "items": ref("ComposeObservedService")},
    "observedAfter": {"type": "array", "maxItems": 64, "items": ref("ComposeObservedService"), "nullable": True},
    "observedAfterDigest": _nullable(COMPOSE_SHA), "perServiceOutcomes": {"type": "array", "maxItems": 64, "items": ref("ComposePerServiceOutcome")},
    "uncertainReason": {"type": "string", "enum": ["CLAIM_EXPIRED", "START_ACK_LOST", "RUNNER_LOST", "REPORT_LOST", "EXECUTOR_TIMEOUT", "EXECUTION_UNCERTAIN"], "nullable": True},
}, ["jobId", "previewId", "hostId", "projectId", "action", "releaseId", "serviceId", "targetReleaseDigest", "targetServices", "reason", "actorLabel", "state", "stateVersion", "expectedTargetRevision", "targetRevision", "createdAt", "startedAt", "completedAt", "claimExpiresAt", "observedBeforeDigest", "startExpectedObservedDigest", "observedBefore", "observedAfter", "observedAfterDigest", "perServiceOutcomes", "uncertainReason"], strict=True)
COMPOSE_JOB_PAGE_SCHEMA = obj_schema({"items": {"type": "array", "maxItems": 100, "items": ref("ComposeJob")},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "hasMore": {"type": "boolean"},
    "nextCursor": {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"}},
    ["items", "limit", "hasMore"], strict=True)
COMPOSE_JOB_SUBMISSION_SCHEMA = obj_schema({"job": ref("ComposeJob"), "replayed": {"type": "boolean"}}, ["job", "replayed"], strict=True)
COMPOSE_ACK_SCHEMA = obj_schema({"job": ref("ComposeJob")}, ["job"], strict=True)
COMPOSE_RUNNER_CLAIM_SCHEMA = obj_schema({"job": ref("ComposeJob"), "executionToken": {"type": "string", "minLength": 32, "maxLength": 256}}, ["job", "executionToken"], strict=True)
COMPOSE_RUNNER_CLAIM_RESPONSE_SCHEMA = obj_schema({"claim": {"oneOf": [ref("ComposeRunnerClaim"), {"type": "null"}]}}, ["claim"], strict=True)
COMPOSE_RUNNER_SNAPSHOT_REQUEST_SCHEMA = obj_schema({"hostId": COMPOSE_ID, "manifestDigest": COMPOSE_SHA, "sampledAt": COMPOSE_TIME,
    "projects": {"type": "array", "maxItems": 64, "items": ref("ComposeRunnerProjectSnapshot")}}, ["hostId", "manifestDigest", "sampledAt", "projects"], strict=True)
COMPOSE_RUNNER_START_REQUEST_SCHEMA = obj_schema({"jobId": {"type": "string", "format": "uuid"}, "executionToken": {"type": "string", "minLength": 32, "maxLength": 256},
    "expectedStateVersion": {"type": "integer", "minimum": 1}, "manifestDigest": COMPOSE_SHA, "observedDigest": COMPOSE_SHA},
    ["jobId", "executionToken", "expectedStateVersion", "manifestDigest", "observedDigest"], strict=True)
COMPOSE_RUNNER_START_ACK_SCHEMA = obj_schema({"jobId": {"type": "string", "format": "uuid"}, "state": {"type": "string", "enum": ["RUNNING"]},
    "stateVersion": {"type": "integer", "minimum": 1}, "startedAt": COMPOSE_TIME}, ["jobId", "state", "stateVersion", "startedAt"], strict=True)
COMPOSE_RUNNER_COMPLETE_REQUEST_SCHEMA = obj_schema({
    "jobId": {"type": "string", "format": "uuid"}, "executionToken": {"type": "string", "minLength": 32, "maxLength": 256},
    "expectedStateVersion": {"type": "integer", "minimum": 1}, "manifestDigest": COMPOSE_SHA, "sampledAt": COMPOSE_TIME,
    "outcome": {"type": "string", "enum": ["SUCCEEDED", "FAILED", "PARTIAL", "UNKNOWN"]}, "errorCode": _nullable(COMPOSE_ERROR_SCHEMA),
    "uncertainReason": {"type": "string", "enum": ["CLAIM_EXPIRED", "START_ACK_LOST", "RUNNER_LOST", "REPORT_LOST", "EXECUTOR_TIMEOUT", "EXECUTION_UNCERTAIN"], "nullable": True},
    "observedServices": {"type": "array", "maxItems": 64, "items": ref("ComposeObservedService"), "nullable": True},
    "perServiceOutcomes": {"type": "array", "maxItems": 64, "items": ref("ComposePerServiceOutcome")},
}, ["jobId", "executionToken", "expectedStateVersion", "manifestDigest", "sampledAt", "outcome", "errorCode", "uncertainReason", "observedServices", "perServiceOutcomes"], strict=True)
COMPOSE_RUNNER_RECONCILE_REQUEST_SCHEMA = obj_schema({
    "jobId": {"type": "string", "format": "uuid"}, "expectedStateVersion": {"type": "integer", "minimum": 1},
    "manifestDigest": COMPOSE_SHA, "sampledAt": COMPOSE_TIME, "executorQuiescent": {"type": "boolean"},
    "evidenceCode": {"type": "string", "enum": ["NO_ACTIVE_EXECUTOR", "EXECUTOR_TERMINATED", "MANUAL_OPERATOR_CONFIRMED", "UNCERTAIN"]},
    "observedServices": {"type": "array", "maxItems": 64, "items": ref("ComposeObservedService"), "nullable": True},
    "perServiceOutcomes": {"type": "array", "maxItems": 64, "items": ref("ComposePerServiceOutcome")},
}, ["jobId", "expectedStateVersion", "manifestDigest", "sampledAt", "executorQuiescent", "evidenceCode", "observedServices", "perServiceOutcomes"], strict=True)
COMPOSE_RUNNER_PROJECT_SNAPSHOT_SCHEMA = obj_schema({"projectId": COMPOSE_ID, "displayName": {"type": "string", "minLength": 1, "maxLength": 128},
    "services": {"type": "array", "maxItems": 64, "items": ref("ComposeCatalogService")},
    "releases": {"type": "array", "maxItems": 128, "items": ref("ComposeCatalogRelease")},
    "observedServices": {"type": "array", "maxItems": 64, "items": ref("ComposeObservedService")}},
    ["projectId", "displayName", "services", "releases", "observedServices"], strict=True)
COMPOSE_RUNNER_SNAPSHOT_ACK_SCHEMA = obj_schema({"hostId": COMPOSE_ID, "manifestDigest": COMPOSE_SHA, "receivedAt": COMPOSE_TIME,
    "projects": {"type": "array", "maxItems": 64, "items": obj_schema({"projectId": COMPOSE_ID, "catalogRevision": COMPOSE_SHA,
        "observedDigest": COMPOSE_SHA, "targetRevision": {"type": "integer", "minimum": 0}},
        ["projectId", "catalogRevision", "observedDigest", "targetRevision"], strict=True)}}, ["hostId", "manifestDigest", "receivedAt", "projects"], strict=True)

# Assembled here, after every schema constant above it is defined.
SCHEMAS = {

    "ArtifactDownloadResponse": ARTIFACT_DOWNLOAD_RESPONSE_SCHEMA,
    "AdminUsageEventRecord": ADMIN_USAGE_RECORD_SCHEMA,
    "AdminUsageEventPage": ADMIN_USAGE_PAGE_SCHEMA,
    "AdminUsageEventQuery": ADMIN_USAGE_QUERY_SCHEMA,
    "AdminTenant": TENANT_SCHEMA,
    "AdminTenantsPage": TENANTS_PAGE_SCHEMA,
    "ArtifactRef": ARTIFACT_REF_SCHEMA,
    "EncryptedArtifactDownload": ENCRYPTED_ARTIFACT_DOWNLOAD_SCHEMA,
    "EncryptedResultEnvelope": ENCRYPTED_RESULT_ENVELOPE_SCHEMA,
    "RecipientDeliveryEnvelope": DELIVERY_ENVELOPE_SCHEMA,
    "ResultEnvelope": RESULT_ENVELOPE_SCHEMA,
    "ResultResponse": RESULT_RESPONSE_SCHEMA,
    "Usage": USAGE_SCHEMA,
    "UsageEventCursor": USAGE_EVENT_CURSOR_SCHEMA,
    "UsageEventExportPage": USAGE_EVENT_PAGE_SCHEMA,
    "UsageEventQuery": USAGE_EVENT_QUERY_SCHEMA,
    "UsageLedgerEvent": USAGE_LEDGER_EVENT_SCHEMA,
    "UsageLedgerUnits": USAGE_LEDGER_UNITS_SCHEMA,
    "UsageTimeSemantics": USAGE_TIME_SEMANTICS_SCHEMA,
    "ComposeActiveJob": COMPOSE_ACTIVE_JOB_SCHEMA,
    "ComposeCatalog": COMPOSE_CATALOG_SCHEMA,
    "ComposeCatalogProject": COMPOSE_CATALOG_PROJECT_SCHEMA,
    "ComposeCatalogRelease": COMPOSE_RELEASE_SCHEMA,
    "ComposeCatalogService": COMPOSE_SERVICE_SCHEMA,
    "ComposeJobAck": COMPOSE_ACK_SCHEMA,
    "ComposeJob": COMPOSE_JOB_SCHEMA,
    "ComposeJobPage": COMPOSE_JOB_PAGE_SCHEMA,
    "ComposeJobSubmission": COMPOSE_JOB_SUBMISSION_SCHEMA,
    "ComposeObservedService": COMPOSE_OBSERVED_SCHEMA,
    "ComposePerServiceOutcome": COMPOSE_OUTCOME_SCHEMA,
    "ComposePreview": COMPOSE_PREVIEW_SCHEMA,
    "ComposePreviewRequest": COMPOSE_PREVIEW_REQUEST_SCHEMA,
    "ComposeRunnerClaim": COMPOSE_RUNNER_CLAIM_SCHEMA,
    "ComposeRunnerClaimResponse": COMPOSE_RUNNER_CLAIM_RESPONSE_SCHEMA,
    "ComposeRunnerCompleteRequest": COMPOSE_RUNNER_COMPLETE_REQUEST_SCHEMA,
    "ComposeRunnerProjectSnapshot": COMPOSE_RUNNER_PROJECT_SNAPSHOT_SCHEMA,
    "ComposeRunnerReconcileRequest": COMPOSE_RUNNER_RECONCILE_REQUEST_SCHEMA,
    "ComposeRunnerSnapshotAck": COMPOSE_RUNNER_SNAPSHOT_ACK_SCHEMA,
    "ComposeRunnerSnapshotRequest": COMPOSE_RUNNER_SNAPSHOT_REQUEST_SCHEMA,
    "ComposeRunnerStartAck": COMPOSE_RUNNER_START_ACK_SCHEMA,
    "ComposeRunnerStartRequest": COMPOSE_RUNNER_START_REQUEST_SCHEMA,
    "ComposeSubmitJobRequest": COMPOSE_SUBMIT_REQUEST_SCHEMA,
}

APIKEY = {"ApiKey": []}
ADMIN = {"AdminBearer": []}
RUNTIME = {"RuntimeBearer": []}
USAGETOK = {"UsageBearer": []}
SVC = {"Svc": []}

paths = {}
# Legacy workflow facade contracts are implemented by the compat mount, not
# separate server.ts branches. Guard those sources before publishing the paths.
_workflow_mount = Path('du-rework/orchestrator/services/orchestrator/src/compat/legacy-http-mount.ts').read_text(encoding='utf-8-sig')
_workflow_decoder = Path('du-rework/orchestrator/services/orchestrator/src/compat/legacy-workflow-decoders.ts').read_text(encoding='utf-8-sig')
assert 'await host.submitLegacyWorkflow(' in _workflow_mount, 'Workflow facade submission is not wired'
_process_match = re.search(r'LEGACY_WORKFLOW_PROCESSES\s*=\s*\[([^\]]+)\]', _workflow_decoder)
assert _process_match, 'Legacy process contract missing'
_workflow_processes = re.findall(r"'([^']+)'", _process_match.group(1))
assert _workflow_processes == ['disbursement', 'lc-checker', 'doc-compare'], 'Legacy workflow process contract drift'
for _schema_route in [False, True]:
    _workflow_path = '/api/v1/docs/workflows' + ('/schema' if _schema_route else '')
    _selector = 'schemaSlug' if _schema_route else 'process'
    _properties = {
        _selector: {'type': 'string'},
        'files[]': {'type': 'array', 'items': {'type': 'string', 'format': 'binary'}},
        'source_file': {'type': 'string', 'format': 'binary'},
        'target_file': {'type': 'string', 'format': 'binary'},
        'file': {'type': 'string', 'format': 'binary'},
        'apiKeyId': {'type': 'string', 'description': 'Optional compatibility field; must match the authenticated caller. Never selects another identity.'},
    }
    if _schema_route:
        _properties['input'] = {'type': 'string', 'description': 'JSON object string; defaults to {}. Arrays/scalars are rejected. Schema revision is pinned at admission.'}
    else:
        _properties['process']['enum'] = _workflow_processes
        _properties['resolution_data'] = {'type': 'string', 'description': 'Optional disbursement process parameter.'}
    _workflow = op('Legacy schema workflow submission' if _schema_route else 'Legacy named workflow submission', APIKEY,
        {'required': True, 'content': {'multipart/form-data': {'schema': {
            'type': 'object', 'required': [_selector], 'properties': _properties}}}},
        {str(code): {'description': description} for code, description in [
            (202, 'Fresh asynchronous workflow operation; sync and Idempotency-Key are ignored for legacy parity.'),
            (400, 'Missing selector/files or invalid input/schema'), (401, 'Missing or invalid active API key'),
            (403, 'Caller/profile/action denied or mismatched body apiKeyId'), (404, 'Unknown process or schema'),
            (409, 'Schema has no active revision or admission conflict'), (413, 'Upload/file-count limit exceeded'),
            (415, 'Unsupported content type'), (422, 'Profile/business validation failure'),
            (429, 'Quota exceeded'), (503, 'Required service/profile/encryption unavailable'),
            (500, 'Redacted internal failure')]})
    _workflow['description'] = ('Compatibility facade maps internally to registered business/action through shared admission and outbox. '
        'No HTTP redirect. Uploaded files are selected as files[], then source_file, target_file, file; empty uploads are ignored. '
        'Named workflows require at least one file; valid schema workflows can be fileless. Implementation and acceptance evidence: WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md; full runtime acceptance remains a separate gate.')
    _workflow['responses']['202'].update({
        'headers': {'Operation-Location': {'description': 'Relative polling URL', 'schema': {'type': 'string'}}},
        'content': {'application/json': {'schema': {'type': 'object', 'required': ['name', 'done', 'metadata'],
            'properties': {'name': {'type': 'string'}, 'done': {'type': 'boolean', 'enum': [False]},
                'metadata': {'type': 'object', 'required': ['state', 'workflow', 'progress_percent', 'progress_message'],
                    'properties': {'state': {'type': 'string', 'enum': ['RUNNING']}, 'workflow': {'type': 'string'},
                        'progress_percent': {'type': 'integer', 'enum': [0]}, 'progress_message': {'type': 'string'}}}}}}}})
    paths[_workflow_path] = {'post': _workflow}
paths["/health"] = {"get": op("Liveness alias, no auth. server.ts:315.", None, None, {"200": {"description": "ok|degraded {status,db,redis,activeLeases}"}, "503": {"description": "degraded"}})}
paths["/api/v1/health"] = {"get": op("Liveness alias, no auth. server.ts:315.", None, None, {"200": {"description": "ok|degraded"}, "503": {"description": "degraded"}})}
paths["/api/v1/businesses/{id}/actions/{action}"] = {"post": op("Generic business submission. server.ts:559.", APIKEY, {"required": True, **ex({"input": {"type": "invoice"}, "artifacts": [], "output": {"format": "json"}})}, {"202": {"description": "SubmitAck, replayed=false"}, "200": {"description": "SubmitAck replayed=true"}})}
_submission = paths["/api/v1/businesses/{id}/actions/{action}"]["post"]
_submission["requestBody"]["description"] = (
    "SubmissionSchema: sourceUrl optionally accepts HTTPS or s3://bucket/key?versionId=... "
    "(max 2048 characters). S3 source reads use the Orchestrator workload IAM identity, "
    "not caller credentials or presigned URLs. S3 artifact storage and trusted per-tenant "
    "DU_S3_SOURCE_RULES bucket/prefix/region/owner permissions are required. "
    "No source endpoint or role ARN override is accepted. HTTP 202 starts asynchronous ingestion."
)
_submission_json = _submission["requestBody"]["content"]["application/json"]
_submission_json["examples"] = {
    "inline": {"value": _submission_json.pop("example")},
    "iamS3Ingest": {"summary": "Use action=ingest; IAM role reads an allowed S3 object", "value": {
        "input": {"mode": "parse"}, "sourceUrl": "s3://customer-documents/invoices/document.pdf"}},
}
_submission["responses"].update({
    "403": {"description": "PERMISSION_DENIED: S3 source bucket/prefix is not authorized for the authenticated tenant"},
    "422": {"description": "INVALID_SCHEMA, profile policy denial, or UNSUPPORTED_STORAGE_BACKEND for sourceUrl with non-S3 artifact storage"},
})

# Six parameters, in OPERATIONS_LIST_QUERY_PARAMS order. The list itself is
# asserted against the contract above, so a seventh contract parameter fails
# generation here instead of being published as an undocumented or dropped one.
OPERATIONS_PARAMS = [
    param("limit",
          "1..%d, default %d. The only parameter that CLAMPS instead of returning 422."
          % (LIMIT_MAX, LIMIT_DEFAULT),
          {"type": "integer", "minimum": 1, "maximum": LIMIT_MAX, "default": LIMIT_DEFAULT}),
    param("cursor",
          "Opaque base64url keyset token. Grammar: "
          "<ISO>|<uuid>|<field>:<direction>[|p]. The third slot names the "
          "ordering the position belongs to, and the trailing |p marks a "
          "backward walk. 422 INVALID_SCHEMA when the token cannot be "
          "decoded, when it exceeds the 128-character bound, or when its "
          "ordering slot differs from the requested sort. A mismatch is "
          "refused, never reinterpreted, and omitting ?sort is not a way "
          "around it: absent sort resolves to %s. A token minted before the "
          "sort parameter existed omits the third slot and is read as %s, so "
          "links written earlier keep paging. Reviewer T140-A1 is still "
          "open: that binding is IMPLEMENTED and offline VERIFIED, not "
          "live-verified or accepted."
          % (SORT_DEFAULT, SORT_DEFAULT),
          {"type": "string", "minLength": 1}),
    param("state",
          "Operator UI enum only. Each value expands server-side into a set of "
          "machine wire states; RUNNING covers seven. A machine state such as "
          "QUEUED is a 422 by design.",
          {"type": "string", "enum": STATE_VALUES}),
    param("tenant",
          "Exact tenant id; the accepted charset is schema.pattern, taken from "
          "OPERATIONS_LIST_TOKEN_PATTERN. A solid hex string of 32+ chars is "
          "rejected as API-key material, not an id. 403 when outside caller "
          "scope rather than 422.",
          {"type": "string", "pattern": TOKEN_PATTERN}),
    param("id",
          "Case-insensitive substring of the operation id.",
          {"type": "string", "pattern": TOKEN_PATTERN}),
    param("sort",
          "Allow-listed ordering, <field>:<direction>. Case-insensitive; split on "
          "the LAST colon, so an extra colon is rejected rather than truncated. "
          "Absent or empty is %s, the pre-parameter order. Anything outside the "
          "allow-list is 422 INVALID_SCHEMA, never a silent fallback to the "
          "default. Allow-list (OPERATIONS_LIST_SORT_VALUES): %s. "
          "deadline_at orders NULLs last via COALESCE(deadline_at, "
          "'0001-01-01T00:00:00.000Z'::timestamptz) for desc and "
          "'9999-12-31T23:59:59.999Z'::timestamptz for asc, written as an "
          "inline literal constant (Const node) rather than a bind parameter, "
          "so migration 0019 expression indexes match the ORDER BY form."
          % (SORT_DEFAULT, ", ".join(SORT_VALUES)),
          {"type": "string", "default": SORT_DEFAULT, "enum": SORT_VALUES}),
    param("from", "Inclusive created-at ISO timestamp", {"type": "string", "format": "date-time"}),
    param("to", "Exclusive created-at ISO timestamp", {"type": "string", "format": "date-time"}),
]
paths["/api/internal/operations"] = {"get": op(
    "List operations. server.ts parseOperationsListQuery + listOperationsPage; "
    "contracts public-api.ts OPERATIONS_LIST_QUERY_PARAMS (%d names) and "
    "OPERATIONS_LIST_SORT_*. Admin bearer/session only, tenant fenced." % len(QUERY_PARAMS), [ADMIN, {"PortalSession": []}], None,
    {"200": page_response(
        "Five-field page: {items: OperationView[], nextCursor, prevCursor, total, "
        "limit}. total is a COUNT(*) over the FILTERED population, never "
        "items.length, and does not vary with sort. prevCursor is null on the "
        "first page.",
        {"items": [], "nextCursor": EXAMPLE_CURSOR,
         "prevCursor": None, "total": 1284, "limit": 20}),
     "401": {"description": "missing or invalid auth"},
     "403": {"description": "tenant outside caller scope; a foreign tenant is a fence, not a widened view"},
     "422": {"description": "INVALID_SCHEMA on state, tenant, id, cursor or sort. A query key outside the allow-list is ignored, not 422. This route never returns 400."}},
    OPERATIONS_PARAMS)}
paths["/api/v1/operations/{id}"] = {"get": op("Legacy result by ID, scoped to submitting API key.", APIKEY, None, {"200": {"description": "Legacy operation envelope (name, done, metadata, response/error)."}, "404": {"description": "Unknown or foreign operation"}})}
paths["/api/v1/operations/{id}/download"] = {"get": op("Legacy result output download; API-key ownership and delivery policy apply.", APIKEY, None, {"200": {"description": "Output bytes or encrypted delivery envelope"}})}
paths["/api/internal/operations/{id}"] = {
    "get": op("Admin operation detail: operation, tasks, humanWaits, result, artifacts, serverNow.", [ADMIN, {"PortalSession": []}], None, {"200": {"description": "Admin detail"}, "404": {"description": "Unknown or foreign operation"}}),
    "delete": op("Soft-delete terminal operation; admin/operator tenant scope and session CSRF required.", [ADMIN, {"PortalSession": []}], None, {"200": {"description": "Deleted"}, "409": {"description": "Operation still active"}})}
paths["/api/internal/operations/metrics"] = {"get": op("Tenant-scoped admin metrics.", [ADMIN, {"PortalSession": []}], None, {"200": {"description": "Operation metrics"}}, [param("tenant", "Tenant filter", {"type": "string"}), param("from", "Start ISO timestamp", {"type": "string"}), param("to", "End ISO timestamp", {"type": "string"})])}
paths["/api/internal/operations/uploads"] = {"post": op("Upload one file for a selected active API key. Internal admin/operator only; session CSRF required. Encrypted storage mandatory, maximum16MiB; S3 streams and PostgreSQL bounded encrypted fallback. Result artifact is key-owned before workflow submission.", [ADMIN, {"PortalSession": []}], {"required": True, "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}, {"201": {"description": "{artifactId,state:READY,fileName,mimeType,sizeBytes}"}, "403": {"description": "Role, tenant or CSRF denied"}, "413": {"description": "File exceeds configured limit"}, "503": {"description": "Encrypted storage unavailable"}}, [{"name": name, "in": "query", "required": True, "schema": {"type": "string"}} for name in ["tenantId", "apiKeyId", "fileName"]])}
paths["/api/internal/operations/{id}/download"] = {"get": op("Admin operation output download; tenant fence and delivery policy apply.", [ADMIN, {"PortalSession": []}], None, {"200": {"description": "Output bytes or encrypted delivery envelope"}, "404": {"description": "Unknown/foreign operation or absent output"}})}
paths["/api/internal/operations/{id}/retry"] = {"post": op("Retry original pinned request; platform admin only, session CSRF required.", [ADMIN, {"PortalSession": []}], ex({}), {"200": {"description": "Fresh operation or replay"}, "409": {"description": "Unavailable input or non-retryable state"}})}
# Two variants on one status code, so the schema is the union and the description
# carries the selection rule. Citation corrected: server.ts:619 is an abort-path
# comment today; the handler is the block at server.ts:1724.
paths["/api/internal/operations/{id}/result"] = {"get": op(
    "Admin result projection or encrypted delivery wrapper; tenant fenced.",
    [ADMIN, {"PortalSession": []}], None,
    {"200": {"description": "Both variants are application/json and the choice is made by the SERVER-SIDE tenant policy, never by a request parameter: a client cannot ask for plaintext, and a failed encryption is a 503 rather than a downgrade, so this route cannot quietly serve plaintext under a tenant that switched encryption on. PLAIN: ResultEnvelope v1, schemaVersion \"1\", strict. data carries the worker's opaque resultRef verbatim as {resultRef} with no envelope guessing; artifacts carries REAL refs for submit-declared inputs and task-produced READY outputs, each with a relative /api/v1/artifacts/{id}/download URL; usage and warnings complete the envelope. ENCRYPTED: {schemaVersion \"1\", encrypted true, delivery}, strict, and decrypting delivery yields the exact ResultEnvelope above, so a recipient needs the matching recipient private key to rebuild the plain shape.",
             "content": {"application/json": {"schema": ref("ResultResponse")}}},
     "404": {"description": "NOT_FOUND when the operation belongs to another tenant. Deliberately indistinguishable from an unknown id: no existence leak."},
     "409": {"description": "STATE_CONFLICT: the operation is not SUCCEEDED (facade.ts resultHttpStatus decides the split), or delivery encryption is not enabled for this tenant."},
     "410": {"description": "GONE: the operation is in an expired terminal state."},
     "503": {"description": "TEMPORARY_UNAVAILABLE: encrypted delivery failed, including a revoked recipient key. The route does not fall back to the plain variant."}})}
# CR-12/MM-02. Listed as absent in x-absent while server.ts implemented it, which
# is how a real MIME-proxy route and its encrypted wrapper stayed undocumented.
paths["/api/v1/artifacts/{id}/download"] = {"get": op(
    "Tenant-scoped artifact download. MIME proxy or encrypted wrapper. Handler server.ts:1817.",
    APIKEY, None,
    {"200": {"description": "Two variants, and the SERVER-SIDE tenant policy picks one; a caller cannot opt out and no request parameter would change it. PLAIN (policy absent or disabled): a MIME PROXY. The stored bytes stream raw, unwrapped and not re-encoded (CR-13), and the response Content-Type is the artifact's stored MIME type, or application/octet-stream when that column is empty. That is the application/octet-stream entry below; the contract types the body as a byte string or an async byte stream, which JSON Schema cannot express, so it is published as format: binary. ENCRYPTED (policy enabled): the SAME bytes as a JSON body with Content-Type application/json and the EncryptedArtifactDownload shape - schemaVersion \"1\", encrypted true, the delivery envelope, plus the artifactId and the mimeType the recipient recovers after decrypting. Wrapping only the metadata and streaming plaintext underneath would leave the payload - the part that matters - in the clear, so both public delivery routes encrypt or neither does.",
             "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                         "application/json": {"schema": ref("EncryptedArtifactDownload")}}},
     "404": {"description": "NOT_FOUND for a foreign or an unknown id, deliberately indistinguishable: no existence leak."},
     "409": {"description": "STATE_CONFLICT: the row exists but is not READY, so its bytes are not yet integrity-verified."},
     "413": {"description": "TOO_LARGE: the encrypted variant has to hold the whole payload (AES-GCM is single-shot) and fails closed past maxBlobBytes, default 64 MiB, instead of degrading to an unbounded buffer or to plaintext."},
     "503": {"description": "TEMPORARY_UNAVAILABLE: encrypted delivery failed, including a revoked recipient key."}})}
paths["/api/internal/operations/{id}/cancel"] = {"post": op("Admin cancel; session CSRF required.", [ADMIN, {"PortalSession": []}], ex({}), {"200": {"description": "CANCEL_REQUESTED for a live worker until provider abort acknowledgement; otherwise CANCELLED, or terminal replay"}})}
paths["/api/internal/operations/{id}/resume"] = {"post": op("Admin resume with CAS; session CSRF required.", [ADMIN, {"PortalSession": []}], ex({"waitId": "w1", "input": {}, "expectedStateVersion": 3}), {"200": {"description": "resumed or replayed"}})}
paths["/api/v1/usage/summary"] = {"get": op("Tenant usage projection. server.ts:361.", APIKEY, None, {"200": {"description": "UsageSummary"}}, [{"name": "from", "in": "query"}, {"name": "to", "in": "query"}])}
# COST-03. Two auth paths on ONE contract: an API key pinned to its own tenant,
# or an admin bearer that may read any authorized tenant and must then name it.
# The principal decides scope before the query is built, never the query string.
paths["/api/v1/usage/events"] = {"get": op(
    "Bounded keyset page over the usage ledger: drill-down and export. Handler server.ts:1143.",
    [APIKEY, ADMIN],
    None,
    {"200": {"description": "One bounded page of the usage ledger, shared by drill-down UI and export clients, audited on every successful page (action usage.export on resource usage-events:page, severity info) with NO filter value, cursor or credential in the log. The SQL keyset query orders by (timeField, event_id) and keeps the tenant predicate in SQL even for a cursor minted here. A row whose payload is not a valid ledger event is counted in skippedInvalidEvents and dropped rather than returned raw; a row whose eventId, operationId or tenantId contradicts its stored key is 500 USAGE_LEDGER_CONFLICT, not a silent skip.",
             "content": {"application/json": {"schema": ref("UsageEventExportPage")}}},
     "401": {"description": "missing or invalid credentials"},
     "403": {"description": "PERMISSION_DENIED when tenantId does not match the API key tenant, or falls outside the admin credential scope"},
     "422": {"description": "INVALID_SCHEMA for an unsupported or REPEATED parameter (the allow-list has no wildcard, so no arbitrary filter, content or credential can enter this boundary), a non-integer limit or profileRevision, a to that is not strictly after from, half a businessId+action or provider+model pair, or a missing tenantId under an admin bearer. Also INVALID_ARGUMENT when a cursor does not belong to this query. This route never returns 400."}},
    USAGE_EVENTS_PARAMS)}

# BASIC_ADMIN_USAGE_V1: an additive tenant-scoped Admin read API. This is a
# basic persisted-wire projection and stays distinct from the rich public COST
# exporter; no rich provenance or budget fields are implied.
ADMIN_USAGE_PARAMS = [
    param("tenantId", "Optional consistency/scope input. Tenant sessions are bound by the server; a platform Admin must name the tenant.", _USAGE_ID),
    param("from", "Required inclusive receivedAt window start.", _USAGE_TS),
    param("to", "Required exclusive receivedAt window end; after from and no more than 366 days.", _USAGE_TS),
    param("timeField", "Fixed to receivedAt for this basic projection.", {"type": "string", "enum": ["receivedAt"], "default": "receivedAt"}),
    param("limit", "Bounded page size, 1..100, default 50.", {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}),
    param("cursor", "Opaque keyset cursor bound to tenant and full query.", {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"}),
    param("operationId", "Optional operation UUID filter.", {"type": "string", "format": "uuid"}),
    param("provider", "Optional provider/model filter; both values are required together.", _USAGE_ID),
    param("model", "Optional provider/model filter; both values are required together.", _USAGE_ID),
]
for _p in ADMIN_USAGE_PARAMS:
    if _p["name"] in ["from", "to"]:
        _p["required"] = True
paths["/api/internal/usage/events"] = {"get": op(
    "BASIC_ADMIN_USAGE_V1: bounded tenant-fenced page over persisted runtime UsageEvent rows. This read exposes basic event facts with nullable missing cost/provenance; it is not the rich COST ledger exporter.",
    [ADMIN, {"PortalSession": []}], None,
    {"200": {"description": "Tenant-scoped basic usage event page; skipped invalid rows are counted, never silently treated as absent.", "content": {"application/json": {"schema": ref("AdminUsageEventPage")}}},
     "401": {"description": "missing or invalid admin credential/session"},
     "403": {"description": "tenant scope denied"},
     "422": {"description": "INVALID_SCHEMA for unsupported/repeated filters, invalid window, paired provider/model mismatch, or cursor/query mismatch"}},
    ADMIN_USAGE_PARAMS)}

# Compose internal API: platform-admin reads/writes and the separate host
# runner protocol. The runner credential is intentionally never an Admin
# bearer, and runner endpoints have no BFF path.
COMPOSE_JOB_PARAMS = [
    param("hostId", "Optional host selector; a runner-configured Admin may only access its configured host.", COMPOSE_ID),
    param("projectId", "Optional manifest project filter.", COMPOSE_ID),
    param("state", "Optional Compose job state.", {"type": "string", "enum": COMPOSE_STATES}),
    param("limit", "Bounded keyset page size, 1..100, default 50.", {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}),
    param("cursor", "Opaque query-bound cursor.", {"type": "string", "minLength": 1, "maxLength": 2048, "pattern": "^[A-Za-z0-9_-]+$"}),
]
paths["/api/internal/compose/catalog"] = {"get": op(
    "Read the sanitized configured host catalog and latest observed project state. Missing host configuration is returned as capability-disabled, not synthetic telemetry.", ADMIN, None,
    {"200": {"description": "ComposeCatalog", "content": {"application/json": {"schema": ref("ComposeCatalog")}}}, "401": {"description": "missing platform Admin bearer"}, "403": {"description": "platform Admin required"}, "503": {"description": "host runner unavailable"}})}
paths["/api/internal/compose/previews"] = {"post": op(
    "Create an expiring, manifest/revision-bound Compose impact preview. State and target are checked server-side.", ADMIN,
    {"required": True, "content": {"application/json": {"schema": ref("ComposePreviewRequest")}}},
    {"201": {"description": "ComposePreview", "content": {"application/json": {"schema": ref("ComposePreview")}}}, "401": {"description": "missing platform Admin bearer"}, "403": {"description": "platform Admin or session CSRF denied"}, "409": {"description": "stale observation, unavailable host, or target conflict"}, "422": {"description": "invalid preview request"}, "503": {"description": "runner not configured"}},
    [{"name": "x-csrf-token", "in": "header", "required": False, "schema": {"type": "string"}, "description": "Required when the Admin BFF forwards a browser session proof; direct trusted bearer calls use the existing bearer policy."}] )}
paths["/api/internal/compose/jobs"] = {
    "get": op("List bounded Compose job history by optional host/project/state filter.", ADMIN, None,
        {"200": {"description": "ComposeJobPage", "content": {"application/json": {"schema": ref("ComposeJobPage")}}}, "401": {"description": "missing platform Admin bearer"}, "403": {"description": "platform Admin required"}}, COMPOSE_JOB_PARAMS),
    "post": op("Submit a previously issued Compose preview with revision compare-and-swap and idempotency.", ADMIN,
        {"required": True, "content": {"application/json": {"schema": ref("ComposeSubmitJobRequest")}}},
        {"201": {"description": "ComposeJobSubmission", "content": {"application/json": {"schema": ref("ComposeJobSubmission")}}}, "401": {"description": "missing platform Admin bearer"}, "403": {"description": "platform Admin or session CSRF denied"}, "409": {"description": "idempotency mismatch, stale preview/revision, or active target fence"}, "422": {"description": "invalid request or missing Idempotency-Key"}, "503": {"description": "runner not configured"}},
        [{"name": "x-csrf-token", "in": "header", "required": False, "schema": {"type": "string"}}, {"name": "idempotency-key", "in": "header", "required": True, "schema": {"type": "string", "minLength": 8, "maxLength": 200}}])}
paths["/api/internal/compose/jobs/{jobId}"] = {"get": op(
    "Read one Compose job by id, host fenced.", ADMIN, None,
    {"200": {"description": "ComposeJob", "content": {"application/json": {"schema": ref("ComposeJob")}}}, "401": {"description": "missing platform Admin bearer"}, "404": {"description": "unknown or foreign-host job"}})}

COMPOSE_RUNNER = {"ComposeRunnerBearer": []}
paths["/api/internal/compose/runner/snapshot"] = {"post": op(
    "Publish a fresh, host-scoped allowlisted manifest and Docker observation snapshot.", COMPOSE_RUNNER,
    {"required": True, "content": {"application/json": {"schema": ref("ComposeRunnerSnapshotRequest")}}},
    {"200": {"description": "snapshot acknowledgement with computed catalog and observation digests", "content": {"application/json": {"schema": ref("ComposeRunnerSnapshotAck")}}}, "401": {"description": "dedicated Compose runner bearer required"}, "422": {"description": "invalid or stale host snapshot"}, "503": {"description": "runner unavailable"}})}
paths["/api/internal/compose/runner/claim"] = {"post": op(
    "Atomically claim one queued job for the configured host; returns null when no job is ready.", COMPOSE_RUNNER, None,
    {"200": {"description": "bounded claim and execution token", "content": {"application/json": {"schema": ref("ComposeRunnerClaimResponse")}}}, "401": {"description": "dedicated Compose runner bearer required"}})}
paths["/api/internal/compose/runner/start"] = {"post": op(
    "Persist the durable start acknowledgement only when the fresh stored observation digest matches the immutable job expectation.", COMPOSE_RUNNER,
    {"required": True, "content": {"application/json": {"schema": ref("ComposeRunnerStartRequest")}}},
    {"200": {"description": "durable RUNNING acknowledgement", "content": {"application/json": {"schema": ref("ComposeRunnerStartAck")}}}, "401": {"description": "dedicated Compose runner bearer required"}, "409": {"description": "stale sample, digest mismatch or claim conflict; no host command is authorized"}})}
paths["/api/internal/compose/runner/complete"] = {"post": op(
    "Report a completed host action; exact report replays return the stored acknowledgement, divergent retries conflict.", COMPOSE_RUNNER,
    {"required": True, "content": {"application/json": {"schema": ref("ComposeRunnerCompleteRequest")}}},
    {"200": {"description": "accepted completion", "content": {"application/json": {"schema": ref("ComposeJobAck")}}}, "401": {"description": "dedicated Compose runner bearer required"}, "409": {"description": "state/version/token conflict"}})}
paths["/api/internal/compose/runner/reconcile"] = {"post": op(
    "Reconcile an UNKNOWN host job only with quiescence evidence and a fresh observation; exact report retries replay the stored acknowledgement.", COMPOSE_RUNNER,
    {"required": True, "content": {"application/json": {"schema": ref("ComposeRunnerReconcileRequest")}}},
    {"200": {"description": "accepted reconciliation", "content": {"application/json": {"schema": ref("ComposeJobAck")}}}, "401": {"description": "dedicated Compose runner bearer required"}, "409": {"description": "job is not UNKNOWN or state version changed"}})}
paths["/api/internal/compose/runner/jobs/{jobId}"] = {"get": op(
    "Read current runner-visible job state after expiry sweeping, scoped to the configured host. No Admin/BFF proxy exists.", COMPOSE_RUNNER, None,
    {"200": {"description": "host-scoped ComposeJob", "content": {"application/json": {"schema": ref("ComposeJob")}}}, "401": {"description": "dedicated Compose runner bearer required"}, "404": {"description": "job not found or belongs to another host"}})}

paths["/api/v1/connectors/{id}/test"] = {"get": op("Connector probe proxy, sanitized. server.ts:378.", APIKEY, None, {"200": {"description": "ConnectorProbeOutcome"}, "502": {"description": "unhealthy/unavailable"}})}
paths["/api/v1/admin/audit"] = {"get": op(
    "Admin audit ledger page. server.ts GET /api/v1/admin/audit (ADM-BASE-01, "
    "W-ADMUX02-EXT-1). Reads the real admin_audit_events table from migration "
    "0010. Previously listed as an absent surface.", ADMIN, None,
    {"200": page_response(
        "The same five-field page envelope as the operations list: {items, "
        "nextCursor, prevCursor, total, limit}. The retired {tenantId, events} "
        "shape is gone. This route does NOT accept sort, state or id, so its "
        "ordering stays created-at keyset.",
        {"items": [], "nextCursor": None, "prevCursor": None, "total": 0, "limit": 20}),
     "401": {"description": "missing or invalid admin bearer"},
     "403": {"description": "tenant outside the credential scope; identical wording for foreign and unknown ids"}},
    [param("limit", "Page size, clamped like the other list routes.", {"type": "integer"}),
     param("cursor", "Opaque keyset token. Direction-bearing, like the operations cursor.", {"type": "string"}),
     param("tenant", "Narrows the scope, but AUTHORIZES nothing: the scope comes from the credential. A platform principal may narrow to any tenant; a tenant operator is pinned to its own tenant and receives 403 on a foreign one. No tenant in scope returns an honest empty 200 page, never platform-global rows.", {"type": "string"}),
     param("severity", "Allow-listed severity filter.", {"type": "string"}),
     param("action", "Allow-listed action filter.", {"type": "string"})])}
for pth, summ, ln in [("/api/v1/admin/businesses/{id}/versions/{version}/enable", "Enable version, fail-closed 404.", "server.ts:666"), ("/api/v1/admin/businesses/{id}/versions/{version}/activate", "Activate version.", "server.ts:690"), ("/api/v1/admin/businesses/{id}/versions/{version}/deactivate", "Drain version.", "server.ts:702")]:
    paths[pth] = {"put": op("%s %s" % (summ, ln), ADMIN, None, {"200": {"description": "ok"}, "202": {"description": "async"}})}
paths["/api/v1/admin/profile-bindings"] = {"post": op("Create profile revision. server.ts:714.", ADMIN, ex({"apiKey": "RAW-NEVER-STORED", "businessId": "document-core", "businessVersion": "1.0.0", "action": "extract", "connectorBindings": {"reasoning": {"connectorId": "c1", "revision": 1}}}), {"201": {"description": "revision"}})}
paths["/api/v1/admin/operations/sweep-deadlines"] = {"post": op("Deadline sweep trigger. server.ts:732.", ADMIN, None, {"200": {"description": "{timedOut}"}})}
rt = [("post", "/api/runtime/v1/usage-events", "Usage ingest (usageToken). server.ts:348", USAGETOK), ("put", "/api/runtime/v1/businesses/{id}/versions/{version}", "Register version. server.ts:451", RUNTIME), ("put", "/api/runtime/v1/workers/{id}/heartbeat", "Worker heartbeat. server.ts:460", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/claim", "Claim. server.ts:467", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/heartbeat", "Heartbeat. server.ts:478", RUNTIME), ("put", "/api/runtime/v1/tasks/{id}/steps/{step}", "Save step. server.ts:489", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/progress", "Progress. server.ts:499", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/complete", "Complete. server.ts:509", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/fail", "Fail. server.ts:519", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/children", "Spawn children 202. server.ts:529", RUNTIME), ("get", "/api/runtime/v1/tasks/{id}/children", "Join view. server.ts:539", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/wait-input", "Human wait. server.ts:549", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/artifacts", "Upload grant 201. server.ts:388", RUNTIME), ("post", "/api/runtime/v1/artifacts/{id}/finalize", "Finalize. server.ts:399", RUNTIME), ("post", "/api/runtime/v1/artifacts/{id}/access", "Access grant. server.ts:408", RUNTIME), ("post", "/api/runtime/v1/tasks/{id}/invocation-grants", "Grant 201. server.ts:421", RUNTIME), ("put", "/api/runtime/v1/artifacts/blob/{key}", "Blob put 204 ?grant=. server.ts:432", RUNTIME), ("get", "/api/runtime/v1/artifacts/blob/{key}", "Blob get ?grant=. server.ts:432", RUNTIME)]
for method, pth, summ, auth in rt:
    paths.setdefault(pth, {})[method] = op(summ, auth, None, {"200": {"description": "ok"}, "201": {"description": "created"}, "202": {"description": "accepted"}, "204": {"description": "no content"}})
_grant_source = Path('du-rework/orchestrator/packages/contracts/src/runtime.ts').read_text(encoding='utf-8-sig')
assert "storageEncryption: z.literal('server').optional()" in _grant_source, 'Runtime upload encryption negotiation drift'
paths['/api/runtime/v1/tasks/{id}/artifacts']['post']['responses']['201'] = {
    'description': 'Authenticated upload grant. Optional storageEncryption=server is minted only when the runtime uses its configured server encryption seam. SDK sends plaintext on the authorized internal transport; runtime stores ciphertext and manifest before finalization. Absence preserves existing worker sealing behavior; never infer mode from a URL.',
    'content': {'application/json': {'schema': {'type': 'object',
        'required': ['artifactId', 'uploadUrl', 'expiresAt'],
        'properties': {'artifactId': {'type': 'string', 'format': 'uuid'},
            'uploadUrl': {'type': 'string', 'format': 'uri'}, 'expiresAt': {'type': 'string'},
            'storageEncryption': {'type': 'string', 'enum': ['server']}}}}},
}
_connector_source = io.open(CONN, encoding="utf-8").read()
assert "path.startsWith('/connectors') ? 'connector:manage' : 'connector:invoke'" in _connector_source, (
    "Connector scope selection changed; review the documented auth matrix")

def connector_line(fragment):
    assert fragment in _connector_source, "Connector route absent: %s" % fragment
    return _connector_source[:_connector_source.index(fragment)].count("\n") + 1

# Root paths match the router and both clients. HTTP bearer security uses an
# empty scope array; required service scopes are JWT claims, not OAuth scopes.
cp = [
    ("get", "/health/live", "Liveness", "method === 'GET' && path === '/health/live'", {"200": "live"}),
    ("get", "/health/ready", "Readiness, no provider call", "method === 'GET' && path === '/health/ready'", {"200": "ready", "503": "not ready"}),
    ("get", "/capabilities", "Adapter catalog (invocation scope)", "path === '/capabilities'", {"200": "adapter catalog"}),
    ("get", "/connectors", "List redacted revisions", "path === '/connectors'", {"200": "redacted revisions"}),
    ("post", "/connectors", "Create revision", "method === 'POST' && path === '/connectors'", {"201": "redacted revision", "422": "invalid input"}),
    ("post", "/connectors/{id}/revisions", "Create pending revision", "const pending =", {"201": "pending revision", "422": "invalid input"}),
    ("post", "/connectors/{id}/revisions/bootstrap", "Bootstrap bound chain", "const bootstrapped =", {"201": "revision and replayed flag", "422": "invalid input"}),
    ("post", "/connectors/{id}/revisions/{revision}/activate", "Activate revision with CAS", "const activated =", {"200": "activated", "409": "CAS conflict", "422": "invalid input"}),
    ("post", "/connectors/{id}/revisions/{revision}/retire", "Retire revision", "const retired =", {"204": "retired"}),
    ("get", "/connectors/{id}/revisions/current", "Read current redacted revision", "const current =", {"200": "redacted revision", "404": "no current revision"}),
    ("get", "/connectors/{id}/revisions/{revision}", "Read redacted revision", "const one =", {"200": "redacted revision", "404": "revision absent"}),
    ("post", "/invocations", "Invoke", "method === 'POST' && path === '/invocations'", {"200": "completed", "202": "pending"}),
    ("get", "/invocations/{id}", "Query with x-invocation-grant", "method === 'GET' && path.startsWith('/invocations/')", {"200": "state/result", "404": "inaccessible or absent"}),
    ("post", "/invocations/{id}/cancel", "Cancel with x-invocation-grant", "path.endsWith('/cancel')", {"202": "best-effort cancellation"}),
    ("post", "/connectors/{id}/credentials/rotate", "Rotate write-only credential", "path.endsWith('/credentials/rotate')", {"204": "rotated"}),
    ("post", "/connectors/{id}/disable", "Disable connector", "path.endsWith('/disable')", {"204": "disabled"}),
    ("post", "/connectors/{id}/test", "Provider test (distinct from readiness)", "path.endsWith('/test')", {"200": "provider test outcome"}),
]
for method, pth, summ, fragment, responses in cp:
    scope = None if pth.startswith('/health/') else (
        'connector:manage' if pth.startswith('/connectors') else 'connector:invoke')
    response_docs = {code: {"description": description} for code, description in responses.items()}
    if scope:
        response_docs['401'] = {"description": "missing or invalid service identity signature/expiry (GRANT_INVALID)"}
        response_docs['403'] = {"description": "wrong audience or missing required service scope (BINDING_DENIED)"}
    operation = op(summ, SVC if scope else None, None, response_docs)
    # The family stamping pass below assigns the Connector origin together
    # with tags/x-api-family for every operation; a per-op literal here would
    # be a second source of truth for the same constant.
    operation['x-source'] = "%s:%d" % (CONN, connector_line(fragment))
    if scope:
        operation['x-required-service-scope'] = scope
        operation['description'] = "Signed HS256 Bearer JWT, aud=connector, integer exp; required scopes claim includes %s." % scope
    else:
        operation['security'] = []
    path_names = re.findall(r'\{([^}]+)\}', pth)
    if path_names:
        operation['parameters'] = [{"name": name, "in": "path", "required": True,
            "schema": {"type": "integer", "minimum": 1} if name == 'revision' else {"type": "string"}}
            for name in path_names]
    if pth.startswith('/invocations/'):
        operation.setdefault('parameters', []).append({"name": "x-invocation-grant", "in": "header", "required": True,
            "description": "Signed runtime grant bound to invocation and tenant; distinct from service identity.", "schema": {"type": "string"}})
    paths.setdefault(pth, {})[method] = operation

# Reconstruct four Connector-related Platform entries missing from the old
# generator. Source is the admin router, never the previous JSON artifact.
_admin_file = 'du-rework/orchestrator/services/orchestrator/src/http/routes/admin.ts'
_admin_source = io.open(_admin_file, encoding='utf-8').read()

def admin_source(fragment):
    assert fragment in _admin_source, 'Platform management route absent: %s' % fragment
    return '%s:%d' % (_admin_file, _admin_source[:_admin_source.index(fragment)].count('\n') + 1)

paths['/api/v1/admin/actions'] = {'post': op(
    'POST-only admin action dispatcher; other methods return 405. Bearer or shell session with server CSRF validation; action-specific RBAC and idempotency. operations.cancel stops a request; operations.retry is platform-admin-only, creates a fresh execution linked by retryOf, and rejects unavailable input with RETRY_INPUT_UNAVAILABLE. Terminal execution times remain immutable.',
    ADMIN, {'content': {'application/json': {'schema': {
        'type': 'object', 'required': ['action'], 'properties': {
            'action': {'type': 'string', 'minLength': 1},
            'params': {'type': 'object', 'description': 'Action-specific params; absent or non-object params normalize to an empty object.'}}}}}},
    {'200': {'description': 'Action result or idempotent replay'},
     '201': {'description': 'Created action result'}, '202': {'description': 'Accepted action'},
     '401': {'description': 'Missing or invalid admin identity'}, '403': {'description': 'RBAC, tenant or CSRF denied'},
     '404': {'description': 'Unknown action'}, '405': {'description': 'Non-POST method'},
     '409': {'description': 'State or idempotency conflict'}, '422': {'description': 'Missing action or invalid params'},
     '503': {'description': 'Required management/workflow composition unavailable'}},
    [{'name': 'idempotency-key', 'in': 'header', 'schema': {'type': 'string'},
      'description': 'Idempotency key read from headers, not a body field.'}])}
paths['/api/v1/admin/actions']['post']['x-source'] = admin_source("if (pathname === '/api/v1/admin/actions')")
# ORV12: effective configuration revisions and operational callback controls.
_scope_params = [{"name": name, "in": "query", "required": False, "schema": {"type": "string"}} for name in ["tenantId", "apiKeyId", "endpointSlug"]]
paths['/api/v1/admin/settings'] = {'get': op('Effective deployment storage metadata and selected core profile/prompt configuration. Scope fields are required together. Latest20 revision history; optional revision selects decrypted authorized diff. activeRevisionMatchesEffective reports external dependency drift. No credential values.', ADMIN, None, {'200': {'description': 'EffectiveSettings with configuration {activeRevision,activeRevisionMatchesEffective,historyLimit:20,profile,revisions,selectedRevision?}'}, '403': {'description': 'Tenant denied'}, '422': {'description': 'Invalid scope'}}, _scope_params + [{'name':'revision','in':'query','schema':{'type':'integer','minimum':0}}])}
paths['/api/v1/admin/settings']['get']['x-source'] = admin_source("if (pathname === '/api/v1/admin/settings')")
paths['/api/v1/admin/legacy-migration/readiness'] = {'get': op('Tenant-scoped archived migration inventory/readiness. No archive/configuration payload is exposed; cutoverReady remains false until external verification gates are met.', ADMIN, None, {'200':{'description':'{tenantId,runs:[source digests,counts,latestInventory,status,cutoverReady:false]}'},'403':{'description':'Tenant denied'}}, [{'name':'tenantId','in':'query','required':True,'schema':{'type':'string','format':'uuid'}}])}
paths['/api/v1/admin/legacy-migration/readiness']['get']['x-source'] = admin_source("if (pathname === '/api/v1/admin/legacy-migration/readiness')")
paths['/api/internal/operations/{id}/deliveries'] = {'get': op('Tenant-scoped callback delivery status and retry capability. Excludes destination credentials/payload and sanitizes errors. Admin/session only.', [ADMIN, {'PortalSession':[]}], None, {'200':{'description':'{items:[{deliveryId,status,attempts,maxAttempts,lastError,nextAttemptAt,canRetry,disabledReason}]}'},'404':{'description':'Unknown/deleted/foreign operation'}})}
paths['/api/v1/admin/actions']['post']['x-action-contracts'] = {
 'settings.revision.create': {'params':'tenantId, apiKeyId, endpointSlug, expectedActiveRevision:number|null, expectedProfileRevision?:positive integer, changes:{prompts?:[{connectionId:UUID,stepId:_default,promptOverride:string|null}],connectorBindings?:full slot->{connectorId,revision} map}', 'result':'revision detail root; immutable encrypted draft; baseline0 retained; admin only'},
 'settings.revision.validate': {'params':'scope + revision', 'result':'{revision,valid,issues:[{code,message}],checks}; configuration checks only, no paid provider execution'},
 'settings.revision.apply': {'params':'scope + revision + expectedActiveRevision', 'result':'{revision,activeRevision,profileRevision,appliesTo:new submissions only}; encrypted actual prompts and cloned profile pins; dependency and head CAS'},
 'settings.revision.rollback': {'params':'scope + historical revision + expectedActiveRevision', 'result':'new applied revision restoring target; no old operation pin mutation'},
 'settings.prompt.update': {'params':'legacy prompt target/value + expectedUpdatedAt', 'result':'timestamp CAS shorthand over create/validate/apply'},
 'profile.upsert': {'params':'existing command + endpointSlug?:core action:variant + connectorBindings?:full initial map', 'result':'native exact-endpoint profile creation; endpoint selector immutable; omitted pins preserve active map'},
 'operations.callback.retry': {'params':'operationId, deliveryId, expectedAttempts', 'result':'same failed delivery requeued, immutable payload/policy/id and consumed attempts retained; bounded10 attempts; RBAC,tenant,CSRF,idempotency,audit; never reexecute provider'}
}

paths['/api/v1/admin/connectors'] = {'get': op('Platform proxy: redacted Connector revision list.', ADMIN, None,
    {'200': {'description': '{items: redacted revisions}'}, '401': {'description': 'Missing or invalid admin identity'},
     '403': {'description': 'Admin scope denied'}, '502': {'description': 'Invalid upstream response'},
     '503': {'description': 'Management store not composed or upstream unavailable'}})}
paths['/api/v1/admin/connectors']['get']['x-source'] = admin_source("method === 'GET' && pathname === '/api/v1/admin/connectors'")
paths['/api/v1/admin/connectors/capabilities'] = {'get': op(
    'Platform composition-derived management capabilities; not the Connector adapter catalog.', ADMIN, None,
    {'200': {'description': 'Booleans reflect injected composition; absent seams remain false.',
        'content': {'application/json': {'schema': {'type': 'object',
            'required': ['management', 'credentialWorkflow', 'test'],
            'properties': {name: {'type': 'boolean'} for name in ['management', 'credentialWorkflow', 'test']}}}}},
     '401': {'description': 'Missing or invalid admin identity'}, '403': {'description': 'Admin scope denied'}})}
paths['/api/v1/admin/connectors/capabilities']['get']['x-source'] = admin_source("pathname === '/api/v1/admin/connectors/capabilities'")
paths['/api/v1/admin/connectors/{id}/revisions/{rev}'] = {'get': op(
    'Platform redacted revision read; latest/current select current when composed. Without the store or on upstream 503, a configured numeric/latest revision may return a disabled placeholder, not a live capability.',
    ADMIN, None, {'200': {'description': 'Real redacted revision or disabled configured placeholder'},
        '401': {'description': 'Missing or invalid admin identity'}, '403': {'description': 'Admin scope denied'},
        '404': {'description': 'Unconfigured connector or absent revision'}, '502': {'description': 'Invalid upstream response'}},
    [{'name': name, 'in': 'path', 'required': True, 'schema': {'type': 'string'},
      'description': 'Connector id' if name == 'id' else 'latest/current or positive integer revision'} for name in ['id', 'rev']])}
paths['/api/v1/admin/connectors/{id}/revisions/{rev}']['get']['x-source'] = admin_source('const revSeg = decodeURIComponent(m[2]!);')

# WFA-ADMIN-TENANTS. The route landed in the admin router without a generator
# entry, so it was missing from the spec entirely. Source is admin.ts, never the
# previous JSON artifact.
paths['/api/v1/admin/tenants'] = {'get': op(
    'Admin tenant roster page. Ordered by (lower(name), id): its only consumer is the tenant picker, a picker that is not alphabetical is unusable, and the tenants table (migration 0001) has no updated_at column, so this list deliberately exposes no sort parameter. Scope comes from the CREDENTIAL, never from a query parameter - this route accepts none: the platform bearer sees the whole roster, a tenant operator sees exactly its own row and the predicate rides in SQL.',
    ADMIN, None,
    {'200': {'description': 'The shared five-field page envelope {items, nextCursor, prevCursor, total, limit}; each item is the whole wire row {id, name, state}, with nothing else projected.',
             'content': {'application/json': {'schema': ref('AdminTenantsPage')}}},
     '401': {'description': 'missing or invalid admin bearer'},
     '403': {'description': 'tenant outside the credential scope; the credential is the only scope input this route accepts'}},
    [param('limit', 'Page size, clamped like the other list routes.', {'type': 'integer'}),
     param('cursor', 'Opaque keyset token. The tenant module carries a small id+direction token bounded by LIST_CURSOR_MAX_LEN rather than the shared timestamp cursor dialect, because the order is (lower(name), id).', {'type': 'string'})])}
paths['/api/v1/admin/tenants']['get']['x-source'] = admin_source("if (method === 'GET' && pathname === '/api/v1/admin/tenants')")

# ---- SC-04 / CB-05: canonical models and existing Portal BFF routes ---------
_projection = subprocess.run(
    ['node', 'du-rework/tools/openapi/catalog_callback_schemas.cjs'],
    capture_output=True, text=True, check=True)
SCHEMAS.update(json.loads(_projection.stdout))
_secret_file = 'du-rework/orchestrator/services/orchestrator/src/app/admin/bff/secrets.ts'
_secret_source = io.open(_secret_file, encoding='utf-8').read()
_secret_handle = io.open('du-rework/orchestrator/services/orchestrator/src/app/admin/bff/handle.ts', encoding='utf-8').read()
assert 'matchSecretsRoute(relative)' in _secret_handle
# WT-7: the dispatch contract is asserted by CALLING resolveSecretsRoute,
# not by scanning secrets.ts source text. A reformat of that file used to
# fail the generator with an error that did not describe the real risk.
_dispatch = subprocess.run(
    ['node', 'du-rework/tools/openapi/secrets-route-assert.cjs'],
    capture_output=True, text=True, check=True)
_dispatch_matrix = json.loads(_dispatch.stdout)
assert _dispatch_matrix['list_get'] == 'list', _dispatch_matrix
assert _dispatch_matrix['list_post'] == 'create', _dispatch_matrix
for _denied in ('put', 'delete', 'patch', 'head'):
    assert _dispatch_matrix['list_' + _denied] is None, _dispatch_matrix
    assert _dispatch_matrix['rotate_' + _denied] is None, _dispatch_matrix
for _op in ('rotate', 'disable', 'test'):
    assert _dispatch_matrix[_op + '_post'] == _op, _dispatch_matrix
    assert _dispatch_matrix[_op + '_get'] is None, _dispatch_matrix
_secret_security = {'PortalSession': []}
_secret_errors = {
    '401': {'description': 'Missing Portal session'},
    '403': {'description': 'Tenant/RBAC/credential fence; mutations require platform admin and x-csrf-token'},
    '405': {'description': 'Method not allowed'},
    '422': {'description': 'Invalid JSON/schema; no offending secret value echoed'},
    '503': {'description': 'Admin upstream not configured/unavailable'},
    '404': {'description': 'Catalog upstream route absent in current snapshot; no metadata repository API is implemented'},
}
_portal_paths = set()

def secret_operation(path, method, summary, request_schema=None, response_schema=None):
    responses = dict(_secret_errors)
    if response_schema:
        responses['200'] = {'description': 'Contract projection if upstream is composed; not a claim of current upstream implementation',
            'content': {'application/json': {'schema': {'$ref': '#/components/schemas/' + response_schema}}}}
    params = []
    if '{secretId}' in path:
        params.append({'name': 'secretId', 'in': 'path', 'required': True, 'schema': {'type': 'string'}})
    if method == 'post':
        params += [{'name': 'x-csrf-token', 'in': 'header', 'required': True, 'schema': {'type': 'string'}},
                   {'name': 'idempotency-key', 'in': 'header', 'schema': {'type': 'string', 'maxLength': 200},
                    'description': 'BFF forwards a bounded key; upstream idempotency is not implemented here.'}]
        responses['413'] = {'description': 'Bounded BFF body exceeded'}
    request = None if not request_schema else {'required': True, 'content': {'application/json': {'schema': {'$ref': '#/components/schemas/' + request_schema}}}}
    operation = op(summary, _secret_security, request, responses, params)
    operation['operationId'] = 'portalSecrets' + method.title() + (path.rsplit('/', 1)[-1].strip('{}').title())
    operation['x-source'] = _secret_file
    operation['x-implementation-status'] = 'BFF only; upstream catalog API absent'
    paths.setdefault(path, {})[method] = operation
    _portal_paths.add(path)
    return operation

_list = secret_operation('/admin/api/secrets', 'get', 'Tenant-fenced metadata catalog proxy; no plaintext resolve/readback API.', response_schema='SecretCatalogListPage')
_list['parameters'] = [{'name': name, 'in': 'query', 'schema': {'type': 'string'},
    'description': 'Forwarded to upstream; operator tenant cannot be widened. Upstream filter validation is not implemented in this snapshot.'}
    for name in ['tenantId', 'cursor', 'limit', 'state', 'purpose', 'sort']]
_create = secret_operation('/admin/api/secrets', 'post',
    'Platform-admin + CSRF create/link proxy: POST selects effectiveRoute=create; validate write-only DTO then forward to Internal JSON. Catalog upstream API remains absent.',
    'SecretCatalogCreate')
_create['description'] = 'BFF method dispatch is implemented, not unconditional 405. Reads never return secret values. Create requires tenantId in the body or resolved tenantId query scope; differing body/query tenant is rejected. Upstream availability, storage and idempotency remain unimplemented in this snapshot.'
_create['parameters'].append({'name': 'tenantId', 'in': 'query', 'schema': {'type': 'string', 'format': 'uuid'},
    'description': 'Optional platform-admin scope; fills an omitted body tenantId and must match an explicitly supplied one.'})
_create_body = dict(SCHEMAS['SecretCatalogCreate'])
_create_body['required'] = [key for key in _create_body['required'] if key != 'tenantId']
_create_body['description'] = 'Canonical create DTO after BFF tenant scope injection. tenantId must be supplied in body or resolved query scope; managed_value requires write-only literal, vault_reference forbids value. Canonical Zod refinements apply.'
_create['requestBody']['content']['application/json']['schema'] = _create_body
for _action, _model in [('rotate', 'SecretCatalogRotate'), ('disable', 'SecretCatalogDisable'), ('test', None)]:
    _operation = secret_operation('/admin/api/secrets/{secretId}/' + _action, 'post',
        'Platform-admin + CSRF secret ' + _action + ' proxy. Body secretId is supplied/overridden by path; upstream catalog API absent.', _model)
    if _action in ['rotate', 'disable']:
        # BFF supplies the path identifier before parsing the canonical DTO.
        _body = dict(SCHEMAS[_model])
        _body['required'] = [key for key in _body['required'] if key != 'secretId']
        _operation['requestBody']['content']['application/json']['schema'] = _body
    else:
        _operation['description'] = 'Accepts a bounded JSON object and forwards {}; does not prove a live secret availability probe.'

# Existing Admin BFF adapters for basic usage and Compose. Portal operations
# are kept separate from internal JSON routes; no runner endpoint is proxied.
_portal_security = {'PortalSession': []}
_portal_paths.add('/admin/api/usage/events')
paths['/admin/api/usage/events'] = {'get': op(
    'BASIC_ADMIN_USAGE_V1 BFF page. Resolves the active Admin session and tenant scope before forwarding to Internal JSON.',
    _portal_security, None,
    {'200': {'description': 'AdminUsageEventPage; basic persisted runtime facts with nullable absent cost/provenance.', 'content': {'application/json': {'schema': ref('AdminUsageEventPage')}}},
     '401': {'description': 'missing/expired Portal session'}, '403': {'description': 'tenant scope denied'}, '422': {'description': 'invalid bounded query'}, '503': {'description': 'Admin JSON upstream unavailable'}},
    ADMIN_USAGE_PARAMS)}

_compose_portal_source = 'du-rework/orchestrator/services/orchestrator/src/app/admin/bff/compose.ts'
def compose_portal_operation(path, method, summary, request_schema=None, response_schema=None, query_params=None, csrf=False, idem=False, status='200'):
    params = list(query_params or [])
    if csrf:
        params.append({'name': 'x-csrf-token', 'in': 'header', 'required': True, 'schema': {'type': 'string'}})
    if idem:
        params.append({'name': 'idempotency-key', 'in': 'header', 'required': True, 'schema': {'type': 'string', 'minLength': 8, 'maxLength': 200}})
    responses = {
        status: {'description': summary, **({'content': {'application/json': {'schema': ref(response_schema)}}} if response_schema else {})},
        '401': {'description': 'missing/expired Portal session'}, '403': {'description': 'platform Admin or CSRF denied'},
        '422': {'description': 'unsupported/repeated query parameter or invalid DTO'}, '503': {'description': 'Admin JSON upstream unavailable'},
    }
    if method == 'post': responses['409'] = {'description': 'stale preview/revision, active target fence or idempotency conflict'}
    request = {'required': True, 'content': {'application/json': {'schema': ref(request_schema)}}} if request_schema else None
    result = op(summary, _portal_security, request, responses, params)
    result['operationId'] = 'portalCompose' + method.title() + ''.join(part.title() for part in path.strip('/').split('/') if part and not part.startswith('{')) + ('ById' if '{jobId}' in path else '')
    result['x-source'] = _compose_portal_source
    paths.setdefault(path, {})[method] = result
    _portal_paths.add(path)
    return result

compose_portal_operation('/admin/api/compose/catalog', 'get', 'Read the sanitized Compose catalog.', response_schema='ComposeCatalog')
compose_portal_operation('/admin/api/compose/previews', 'post', 'Create an expiring Compose preview.', request_schema='ComposePreviewRequest', response_schema='ComposePreview', csrf=True, status='201')
compose_portal_operation('/admin/api/compose/jobs', 'get', 'List bounded Compose job history.', response_schema='ComposeJobPage', query_params=[
    param('hostId', 'Optional host filter.', COMPOSE_ID), param('projectId', 'Optional project filter.', COMPOSE_ID),
    param('state', 'Optional job-state filter.', {'type': 'string', 'enum': COMPOSE_STATES}),
    param('limit', 'Bounded keyset page size, 1..100, default 50.', {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 50}),
    param('cursor', 'Opaque query-bound cursor.', {'type': 'string', 'minLength': 1, 'maxLength': 2048, 'pattern': '^[A-Za-z0-9_-]+$'})])
compose_portal_operation('/admin/api/compose/jobs', 'post', 'Submit a preview with revision compare-and-swap and idempotency.', request_schema='ComposeSubmitJobRequest', response_schema='ComposeJobSubmission', csrf=True, idem=True, status='201')
compose_portal_operation('/admin/api/compose/jobs/{jobId}', 'get', 'Read one Compose job.', response_schema='ComposeJob', query_params=[])

_compose_job_detail = paths['/admin/api/compose/jobs/{jobId}']['get']
_compose_job_detail['parameters'] = [{'name': 'jobId', 'in': 'path', 'required': True, 'schema': {'type': 'string', 'format': 'uuid'}}]
_compose_job_detail['responses']['404'] = {'description': 'job not found'}

# PM-M07 structural reconciliation: every template variable is an explicit
# required path parameter; these are wire strings, not guessed UUID enums.
for _path, _item in paths.items():
    for _method, _operation in _item.items():
        _parameters = _operation.setdefault('parameters', [])
        for _name in re.findall(r'\{([^}]+)\}', _path):
            if not any(p.get('in') == 'path' and p.get('name') == _name for p in _parameters):
                _parameters.append({'name': _name, 'in': 'path', 'required': True, 'schema': {'type': 'string'}})
        for _parameter in _parameters:
            if 'schema' not in _parameter and 'content' not in _parameter:
                assert (_path, _parameter['name']) in [('/api/v1/operations/{id}', 'wait'),
                    ('/api/v1/usage/summary', 'from'), ('/api/v1/usage/summary', 'to')], 'Undocumented parameter type'
                _parameter['schema'] = {'type': 'string'}
                _parameter['description'] = ('Parsed as integer seconds and clamped to [0,30] by the poll handler.'
                    if _parameter['name'] == 'wait' else 'ISO time string; validated by the usage handler.')
        if not _parameters:
            del _operation['parameters']

# ---- PM-M02 family stamping -------------------------------------------------
# Every operation gets the server origin, tag and x-api-family of its ingress
# family. The Connector bucket is the root-path block added above; admin and
# runtime are the internal-listener families; everything else is public API.
CONNECTOR_PATHS = {pth for (_method, pth, _summary, _fragment, _responses) in cp}

def _family_of(path):
    if path in CONNECTOR_PATHS:
        return "connector"
    if path.startswith("/api/internal/operations") or path.startswith("/api/internal/usage/") or path.startswith("/api/internal/compose/") or path.startswith("/api/v1/admin/") or path in _portal_paths:
        return "admin"
    if path.startswith("/api/runtime/"):
        return "runtime"
    return "public"

for _path, _item in paths.items():
    _family = _family_of(_path)
    for _method, _operation in _item.items():
        if _method.startswith("x-"):
            continue
        _operation["servers"] = ([{'url': PORTAL_ORIGIN, 'description': 'Portal shell/BFF 3001; cookie session and mutation CSRF. Not internal JSON 3002.'}]
                                 if _path in _portal_paths else [dict(_server) for _server in FAMILY_SERVERS[_family]])
        _operation["tags"] = [_family]
        _operation["x-api-family"] = _family
doc = {"openapi": "3.0.3", "info": {"title": "DUGate rework API (code-derived, W40-CX)", "version": "1.3.0", "description": "From orchestrator server.ts + connector http/server.ts. Absent surfaces in x-absent. Since 1.3.0: server origins are family-scoped to the PM-M02 ingress - public JSON Orchestrator 3000, admin/management and runtime internal JSON Orchestrator 3002, Connector service 8080 - with tags/x-api-family on every operation and generation-time overrides DU_OPENAPI_PUBLIC_ORIGIN / DU_OPENAPI_INTERNAL_ORIGIN / DU_OPENAPI_CONNECTOR_ORIGIN. Try-it-out stays disabled by default in any Portal rendering; this document grants no interactive access. Since 1.2.0: GET /api/v1/usage/events (COST-03) is published with its query, cursor, ledger-record and page schemas. Since 1.1.0: the RESULT-WIRE-01 delivery surfaces are published - components.schemas carries ResultEnvelope v1, EncryptedResultEnvelope v1, RecipientDeliveryEnvelope and EncryptedArtifactDownload, and GET /api/v1/artifacts/{id}/download is a documented path instead of an x-absent entry."}, "servers": FAMILY_SERVERS["public"], "tags": FAMILY_TAGS, "components": {"securitySchemes": {"ApiKey": {"type": "apiKey", "in": "header", "name": "x-api-key"}, "AdminBearer": {"type": "http", "scheme": "bearer"}, "RuntimeBearer": {"type": "http", "scheme": "bearer"}, "UsageBearer": {"type": "http", "scheme": "bearer"}, "Svc": {"type": "http", "scheme": "bearer"}}}, "paths": paths, "x-absent": ["GET /api/v1/businesses", "GET schema", "POST /docs/{action}", "POST /api/v1/artifacts", "GET /api/v1/artifacts/{id} metadata", "admin /api/internal/v1 base + profiles/api-keys/connectors-CRUD/usage/replay", "GET /api/runtime/v1/tasks/{id}/context"]}

# Attached after the literal so the schemas live under components, where the
# OpenAPI specification and the RESULT-WIRE-01 guard below both look for them.
doc["components"]["schemas"] = SCHEMAS
doc['components']['securitySchemes']['PortalSession'] = {'type': 'apiKey', 'in': 'cookie', 'name': 'du_session',
    'description': 'Server-side Portal session; mutations additionally require x-csrf-token and platform admin.'}
doc['components']['securitySchemes']['ComposeRunnerBearer'] = {'type': 'http', 'scheme': 'bearer',
    'description': 'Dedicated host-scoped Compose runner token; never an Admin/platform credential and not accepted by the Admin BFF.'}
doc['info']['version'] = '1.6.0'
doc['info']['description'] = ('Since 1.6.0: BASIC_ADMIN_USAGE_V1 and bounded Compose Admin/host-runner routes are documented as separate schemas and auth planes; '
    'since 1.5.0: legacy workflow multipart admission facades at '
    '/api/v1/docs/workflows and /api/v1/docs/workflows/schema are documented; '
    'runtime compatibility acceptance is tracked separately in the WFA plan. ' + doc['info']['description'])
doc['x-contract-models'] = {'secretCatalog': 'Canonical models + existing BFF routes; /api/v1/admin/secrets upstream absent.',
    'adminBasicUsage': 'BASIC_ADMIN_USAGE_V1 persisted runtime-event projection; distinct from the rich public COST exporter and does not invent absent provenance.',
    'composeOperations': 'Platform Admin/BFF catalog-preview-job routes plus distinct host-scoped runner protocol; unavailable host adapter remains an explicit capability state.',
    'callbackPolicy': 'Frozen contract models and offline dispatcher implementation; profile/admission policy.callbackPolicy and production resolver wiring absent. Not a new endpoint.'}
doc['x-absent'] = [item.replace('admin /api/internal/v1 base + profiles/api-keys/connectors-CRUD/usage/replay',
    'admin /api/internal/v1 base + profiles/api-keys/connectors-CRUD/replay') for item in doc['x-absent']]
doc['x-absent'].extend(['Secret catalog upstream /api/v1/admin/secrets* and any plaintext resolve endpoint',
                      'Rich COST provenance and budget-editing features beyond BASIC_ADMIN_USAGE_V1',
                      'Profile/admission policy.callbackPolicy plumbing (contract models exist)'])
doc["components"]["securitySchemes"]["Svc"].update({
    "bearerFormat": "JWT", "description": "Connector HS256 service identity: aud=connector, exp, subject and required scopes claim. See x-required-service-scope on each operation."})

# Explicit ORV11 retirement migration: all other documented drops still fail.
ALLOWED_RETIRED_PATHS = {
    '/api/v1/operations', '/api/v1/operations/{id}/result',
    '/api/v1/operations/{id}/cancel', '/api/v1/operations/{id}/resume',
}
ALLOWED_RETIRED_OPERATIONS = {(p, m) for p, m in [
    ('/api/v1/operations', 'get'), ('/api/v1/operations/{id}/result', 'get'),
    ('/api/v1/operations/{id}/cancel', 'post'), ('/api/v1/operations/{id}/resume', 'post'),
]}
before = set()
before_operations = set()
if os.path.exists(OUT):
    _previous_paths = json.load(io.open(OUT, encoding="utf-8")).get("paths", {})
    before = set(_previous_paths)
    before_operations = {(path, method) for path, item in _previous_paths.items()
                         for method in item if method in ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']}
assert not (before - set(paths) - ALLOWED_RETIRED_PATHS), "regeneration would drop documented paths; refusing write"
_current_operations = {(path, method) for path, item in paths.items()
                       for method in item if method in ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']}
assert not (before_operations - _current_operations - ALLOWED_RETIRED_OPERATIONS), 'regeneration would drop documented operations; refusing write'
assert not any(p.startswith('/internal/v1') or p.startswith('/management/') for p in paths), (
    "Connector aliases must not be invented by the generator")

# CRLF, not LF: every other file under du-rework/docs is CRLF, and a deterministic
# newline keeps "generate then diff" clean instead of churning the whole file.
io.open(OUT, "w", encoding="utf-8", newline="\r\n").write(json.dumps(doc, indent=2))
io.open("du-rework/orchestrator/docs/21-openapi.json", "w", encoding="utf-8", newline="\r\n").write(json.dumps(doc, indent=2))

# Re-read what was actually written. These are the checks that would have caught
# T140-D1 at generation time instead of at audit time.
written = json.load(io.open(OUT, encoding="utf-8"))
after = set(written["paths"])
dropped = sorted(before - after)
assert not (set(dropped) - ALLOWED_RETIRED_PATHS), (
    "regeneration dropped documented paths %r; re-add them to gen_openapi.py" % (dropped,))
_written_ops = written["paths"]["/api/internal/operations"]["get"]
assert [p["name"] for p in _written_ops["parameters"]] == QUERY_PARAMS, "operations parameters drifted from the contract"
assert _written_ops["parameters"][QUERY_PARAMS.index("sort")]["schema"]["enum"] == SORT_VALUES, "sort enum drifted from the contract"
assert set(_written_ops["responses"]) == {"200", "401", "403", "422"}, "operations responses drifted"
assert "/api/v1/admin/audit" in after, "admin audit surface missing"
assert "/api/v1/admin/tenants" in after, "admin tenant roster surface missing"
# SWAGGER-ORIGIN-DOCS-ALIGNMENT guard. The written artifact must never carry
# the legacy 2023 origin, and each operation must point at the listener of its
# own PM-M02 family with matching tags/x-api-family metadata. Checked on the
# WRITTEN file so a hand-edit that reintroduces one global origin fails here.
assert "localhost:2023" not in json.dumps(written), (
    "legacy port 2023 leaked back into the artifact")
_written_families = set()
for _path, _item in written["paths"].items():
    _family = _family_of(_path)
    for _method, _operation in _item.items():
        if _method.startswith("x-"):
            continue
        _written_families.add(_family)
        assert _operation.get("x-api-family") == _family, (
            "%s %s x-api-family drifted to %r"
            % (_method, _path, _operation.get("x-api-family")))
        assert _operation.get("tags") == [_family], (
            "%s %s tags drifted to %r" % (_method, _path, _operation.get("tags")))
        _urls = [s.get("url") for s in _operation.get("servers", [])]
        assert _urls == ([PORTAL_ORIGIN] if _path in _portal_paths else [FAMILY_SERVERS[_family][0]["url"]]), (
            "%s %s points at %r, not the %s origin %r"
            % (_method, _path, _urls, _family, FAMILY_SERVERS[_family][0]["url"]))
assert _written_families == {"public", "admin", "runtime", "connector"}, (
    "an API family disappeared from the artifact: %r" % sorted(_written_families))
# RESULT-WIRE-01 guard. The two delivery variants and the download route are what
# a hand-edit drops first, so they are asserted on the WRITTEN file, not on the
# dict this script assembled.
_schemas = written["components"]["schemas"]
assert set(["ArtifactDownloadResponse", "ArtifactRef",
                            "EncryptedArtifactDownload", "EncryptedResultEnvelope",
                            "RecipientDeliveryEnvelope", "ResultEnvelope",
                            "ResultResponse", "Usage", "UsageEventCursor",
                            "UsageEventExportPage", "UsageEventQuery",
                            "UsageLedgerEvent", "UsageLedgerUnits",
                            "UsageTimeSemantics"]).issubset(_schemas), (
    "components.schemas drifted to %r" % (sorted(_schemas),))
_result_200 = written["paths"]["/api/internal/operations/{id}/result"]["get"]["responses"]["200"]
_result_schema = _result_200["content"]["application/json"]["schema"]
assert _result_schema["$ref"] == "#/components/schemas/ResultResponse", (
    "result 200 no longer points at the delivery union")
assert [_v["$ref"] for _v in _schemas["ResultResponse"]["oneOf"]] == [
    "#/components/schemas/ResultEnvelope", "#/components/schemas/EncryptedResultEnvelope"], (
    "result 200 lost one delivery variant")
assert _schemas["ArtifactDownloadResponse"]["oneOf"][0].get("format") == "binary", (
    "the plain download branch stopped being raw bytes")
assert _schemas["ArtifactDownloadResponse"]["oneOf"][1]["$ref"] == (
    "#/components/schemas/EncryptedArtifactDownload"), "the download union lost its wrapper"
_download_200 = written["paths"]["/api/v1/artifacts/{id}/download"]["get"]["responses"]["200"]
assert sorted(_download_200["content"]) == ["application/json", "application/octet-stream"], (
    "download 200 lost its byte or wrapper variant")
assert _download_200["content"]["application/json"]["schema"]["$ref"] == (
    "#/components/schemas/EncryptedArtifactDownload"), "download 200 points at the wrong wrapper"
assert "GET artifact metadata/download" not in written["x-absent"], (
    "x-absent still claims the download route is absent; server.ts:1817 implements it")
# COST-03 guard. The thirteen parameters are asserted against the contract key
# list, so a new filter in the schema cannot be published without documenting it
# and a removed one cannot keep its parameter.
_events = written["paths"]["/api/v1/usage/events"]["get"]
assert [p["name"] for p in _events["parameters"]] == USAGE_EVENT_QUERY_PARAMS, (
    "usage event parameters drifted from the contract: %r"
    % ([p["name"] for p in _events["parameters"]],))
assert len(_events["security"]) == 2, "usage event route must publish both auth paths"
assert _events["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] == (
    "#/components/schemas/UsageEventExportPage"), "usage event 200 points at the wrong page schema"
assert _schemas["UsageEventExportPage"]["properties"]["events"]["items"]["$ref"] == (
    "#/components/schemas/UsageLedgerEvent"), "usage event page lost its record schema"
assert _schemas["UsageEventExportPage"]["additionalProperties"] is False, (
    "the export page is strict in the contract; do not publish it as open")
assert set(["AdminUsageEventRecord", "AdminUsageEventPage", "AdminUsageEventQuery", "ComposeCatalog", "ComposePreview",
            "ComposeJob", "ComposeJobPage", "ComposeJobSubmission", "ComposeRunnerSnapshotRequest",
            "ComposeRunnerStartRequest", "ComposeRunnerCompleteRequest", "ComposeRunnerReconcileRequest"]).issubset(_schemas), (
    "BASIC_ADMIN_USAGE_V1 or Compose schema outputs are missing")
assert sorted(_schemas["AdminUsageEventRecord"]["properties"]) == sorted(ADMIN_USAGE_RECORD_FIELDS), (
    "BASIC_ADMIN_USAGE_V1 record fields drifted from usage.ts")
assert sorted(_schemas["AdminUsageEventPage"]["properties"]) == sorted(ADMIN_USAGE_PAGE_FIELDS), (
    "BASIC_ADMIN_USAGE_V1 page fields drifted from usage.ts")
assert written['paths']['/api/v1/usage/events']['get']['responses']['200']['content']['application/json']['schema']['$ref'] == '#/components/schemas/UsageEventExportPage', (
    "the rich public COST exporter was replaced by the basic admin projection")
for _path in ['/api/internal/usage/events', '/admin/api/usage/events', '/api/internal/compose/catalog',
              '/api/internal/compose/previews', '/api/internal/compose/jobs', '/api/internal/compose/jobs/{jobId}',
              '/api/internal/compose/runner/snapshot', '/api/internal/compose/runner/claim',
              '/api/internal/compose/runner/start', '/api/internal/compose/runner/complete',
              '/api/internal/compose/runner/reconcile', '/api/internal/compose/runner/jobs/{jobId}',
              '/admin/api/compose/catalog', '/admin/api/compose/previews', '/admin/api/compose/jobs',
              '/admin/api/compose/jobs/{jobId}']:
    assert _path in written['paths'], 'missing Admin BASIC_USAGE/Compose route: ' + _path
for _path in ['/api/internal/compose/runner/snapshot', '/api/internal/compose/runner/claim',
              '/api/internal/compose/runner/start', '/api/internal/compose/runner/complete',
              '/api/internal/compose/runner/reconcile', '/api/internal/compose/runner/jobs/{jobId}']:
    _runner_operations = written['paths'][_path]
    for _operation in _runner_operations.values():
        assert _operation['security'] == [{'ComposeRunnerBearer': []}], 'runner auth must stay distinct: ' + _path
assert not any(path.startswith('/admin/api/compose/runner') for path in written['paths']), 'runner routes must never be proxied through the Admin BFF'
assert written['components']['securitySchemes']['ComposeRunnerBearer']['scheme'] == 'bearer'
assert _schemas['SecretCatalogEntryRead']['additionalProperties'] is False
assert 'value' not in _schemas['SecretCatalogEntryRead']['properties']
assert _schemas['LiteralValueSource']['properties']['value']['writeOnly'] is True
assert _schemas['CallbackMode']['enum'] == ['notification_only', 'notification_with_result']
# WFA-ADMIN-TENANTS guard. The roster is the one admin list whose allow-list,
# page envelope and item shape are all pinned here, because retyped ones drift.
_tenants_get = written["paths"]["/api/v1/admin/tenants"]["get"]
assert [p["name"] for p in _tenants_get["parameters"]] == TENANT_LIST_QUERY_PARAMS, (
    "tenant list parameters drifted from the contract: %r"
    % ([p["name"] for p in _tenants_get["parameters"]],))
assert _tenants_get["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] == (
    "#/components/schemas/AdminTenantsPage"), "tenant list 200 points at the wrong page schema"
assert _schemas["AdminTenantsPage"]["properties"]["items"]["items"]["$ref"] == (
    "#/components/schemas/AdminTenant"), "tenant list page lost its item schema"
assert _schemas["AdminTenantsPage"]["additionalProperties"] is False, (
    "the tenant page is strict in the contract; do not publish it as open")
assert sorted(_schemas["AdminTenant"]["properties"]) == ["id", "name", "state"], (
    "the roster item is the contract shape {id, name, state}; do not invent fields")
assert all(path in written['paths'] for path in _portal_paths)
print('NO-UNAUTHORIZED-DROP paths=%d operations=%d; authorized-retirements=%d' % (len(before - after - ALLOWED_RETIRED_PATHS), len(before_operations - _current_operations - ALLOWED_RETIRED_OPERATIONS), len(before - after)))
print("OPENAPI-JSON path-count=%d operations-params=%d sort-values=%d usage-events-params=%d dropped-paths=%d schemas=%d origins=public:%s|internal:%s|connector:%s"
      % (len(after), len(QUERY_PARAMS), len(SORT_VALUES), len(USAGE_EVENT_QUERY_PARAMS),
         len(dropped), len(_schemas), PUBLIC_ORIGIN, INTERNAL_ORIGIN, CONNECTOR_ORIGIN))

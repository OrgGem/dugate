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
"""
import base64, io, json, os, re, sys

ORCH = "du-rework/services/orchestrator/src/server.ts"
CONN = "du-rework/services/connector/src/http/server.ts"
CONTRACT = "du-rework/packages/contracts/src/public-api.ts"
METRICS = "du-rework/packages/contracts/src/usage-metrics.ts"
RECON = "du-rework/packages/contracts/src/usage-reconciliation.ts"
OUT = "du-rework/docs/21-openapi.json"

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

assert QUERY_PARAMS == ["limit", "cursor", "state", "tenant", "id", "sort"], (
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

# Assembled here, after every schema constant above it is defined.
SCHEMAS = {
    "ArtifactDownloadResponse": ARTIFACT_DOWNLOAD_RESPONSE_SCHEMA,
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
}

APIKEY = {"ApiKey": []}
ADMIN = {"AdminBearer": []}
RUNTIME = {"RuntimeBearer": []}
USAGETOK = {"UsageBearer": []}
SVC = {"Svc": []}

paths = {}
paths["/health"] = {"get": op("Liveness alias, no auth. server.ts:315.", None, None, {"200": {"description": "ok|degraded {status,db,redis,activeLeases}"}, "503": {"description": "degraded"}})}
paths["/api/v1/health"] = {"get": op("Liveness alias, no auth. server.ts:315.", None, None, {"200": {"description": "ok|degraded"}, "503": {"description": "degraded"}})}
paths["/api/v1/businesses/{id}/actions/{action}"] = {"post": op("Generic business submission. server.ts:559.", APIKEY, {"required": True, **ex({"input": {"type": "invoice"}, "artifacts": [], "output": {"format": "json"}})}, {"202": {"description": "SubmitAck, replayed=false"}, "200": {"description": "SubmitAck replayed=true"}})}

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
]
paths["/api/v1/operations"] = {"get": op(
    "List operations. server.ts parseOperationsListQuery + listOperationsPage; "
    "contracts public-api.ts OPERATIONS_LIST_QUERY_PARAMS (%d names) and "
    "OPERATIONS_LIST_SORT_*. Admin bearer is an alternate auth path on the same "
    "contract (ADM-UX-02)." % len(QUERY_PARAMS), APIKEY, None,
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
paths["/api/v1/operations/{id}"] = {"get": op("Poll; ?wait seconds clamped [0,30]. server.ts:602 facade.ts:16.", APIKEY, None, {"200": {"description": "OperationView"}}, [{"name": "wait", "in": "query"}])}
# Two variants on one status code, so the schema is the union and the description
# carries the selection rule. Citation corrected: server.ts:619 is an abort-path
# comment today; the handler is the block at server.ts:1724.
paths["/api/v1/operations/{id}/result"] = {"get": op(
    "ResultEnvelope or its encrypted delivery wrapper. Handler server.ts:1724.",
    APIKEY, None,
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
paths["/api/v1/operations/{id}/cancel"] = {"post": op("Idempotent cancel. server.ts:646.", APIKEY, ex({"reason": "no longer needed"}), {"202": {"description": "cancelling"}, "200": {"description": "replayed"}})}
paths["/api/v1/operations/{id}/resume"] = {"post": op("Resume with CAS. server.ts:656.", APIKEY, ex({"waitId": "w1", "input": {}, "expectedStateVersion": 3}), {"202": {"description": "resumed"}, "200": {"description": "replayed"}})}
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
cp = [("get", "/health/live", "Liveness. http/server.ts:80", None), ("get", "/health/ready", "Readiness. http/server.ts:81", None), ("get", "/capabilities", "Catalog. http/server.ts:85", SVC), ("get", "/connectors", "List redacted. http/server.ts:86", SVC), ("post", "/connectors", "Create revision. http/server.ts:90", SVC), ("post", "/invocations", "Invoke 200|202. http/server.ts:122", SVC), ("get", "/invocations/{id}", "Query. http/server.ts:112", SVC), ("post", "/invocations/{id}/cancel", "Cancel 202. http/server.ts:130", SVC), ("post", "/connectors/{id}/credentials/rotate", "Rotate 204 write-only. http/server.ts:139", SVC), ("post", "/connectors/{id}/disable", "Disable 204. http/server.ts:148", SVC), ("post", "/connectors/{id}/test", "Self-test. http/server.ts:153", SVC)]
for method, pth, summ, auth in cp:
    paths.setdefault(pth, {})[method] = op(summ, auth, None, {"200": {"description": "ok"}, "201": {"description": "created"}, "202": {"description": "accepted"}, "204": {"description": "no content"}})
doc = {"openapi": "3.0.3", "info": {"title": "DUGate rework API (code-derived, W40-CX)", "version": "1.2.0", "description": "From orchestrator server.ts + connector http/server.ts. Absent surfaces in x-absent. Since 1.2.0: GET /api/v1/usage/events (COST-03) is published with its query, cursor, ledger-record and page schemas. Since 1.1.0: the RESULT-WIRE-01 delivery surfaces are published - components.schemas carries ResultEnvelope v1, EncryptedResultEnvelope v1, RecipientDeliveryEnvelope and EncryptedArtifactDownload, and GET /api/v1/artifacts/{id}/download is a documented path instead of an x-absent entry."}, "servers": [{"url": "http://localhost:2023"}], "components": {"securitySchemes": {"ApiKey": {"type": "apiKey", "in": "header", "name": "x-api-key"}, "AdminBearer": {"type": "http", "scheme": "bearer"}, "RuntimeBearer": {"type": "http", "scheme": "bearer"}, "UsageBearer": {"type": "http", "scheme": "bearer"}, "Svc": {"type": "http", "scheme": "bearer"}}}, "paths": paths, "x-absent": ["GET /api/v1/businesses", "GET schema", "POST /docs/{action}", "POST /api/v1/artifacts", "GET /api/v1/artifacts/{id} metadata", "admin /api/internal/v1 base + profiles/api-keys/connectors-CRUD/usage/replay", "GET /api/runtime/v1/tasks/{id}/context"]}

# Attached after the literal so the schemas live under components, where the
# OpenAPI specification and the RESULT-WIRE-01 guard below both look for them.
doc["components"]["schemas"] = SCHEMAS

before = set()
if os.path.exists(OUT):
    before = set(json.load(io.open(OUT, encoding="utf-8")).get("paths", {}))

# CRLF, not LF: every other file under du-rework/docs is CRLF, and a deterministic
# newline keeps "generate then diff" clean instead of churning the whole file.
io.open(OUT, "w", encoding="utf-8", newline="\r\n").write(json.dumps(doc, indent=2))

# Re-read what was actually written. These are the checks that would have caught
# T140-D1 at generation time instead of at audit time.
written = json.load(io.open(OUT, encoding="utf-8"))
after = set(written["paths"])
dropped = sorted(before - after)
assert not dropped, (
    "regeneration dropped documented paths %r; re-add them to gen_openapi.py" % (dropped,))
_written_ops = written["paths"]["/api/v1/operations"]["get"]
assert [p["name"] for p in _written_ops["parameters"]] == QUERY_PARAMS, "operations parameters drifted from the contract"
assert _written_ops["parameters"][QUERY_PARAMS.index("sort")]["schema"]["enum"] == SORT_VALUES, "sort enum drifted from the contract"
assert set(_written_ops["responses"]) == {"200", "401", "403", "422"}, "operations responses drifted"
assert "/api/v1/admin/audit" in after, "admin audit surface missing"
# RESULT-WIRE-01 guard. The two delivery variants and the download route are what
# a hand-edit drops first, so they are asserted on the WRITTEN file, not on the
# dict this script assembled.
_schemas = written["components"]["schemas"]
assert sorted(_schemas) == ["ArtifactDownloadResponse", "ArtifactRef",
                            "EncryptedArtifactDownload", "EncryptedResultEnvelope",
                            "RecipientDeliveryEnvelope", "ResultEnvelope",
                            "ResultResponse", "Usage", "UsageEventCursor",
                            "UsageEventExportPage", "UsageEventQuery",
                            "UsageLedgerEvent", "UsageLedgerUnits",
                            "UsageTimeSemantics"], (
    "components.schemas drifted to %r" % (sorted(_schemas),))
_result_200 = written["paths"]["/api/v1/operations/{id}/result"]["get"]["responses"]["200"]
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
print("OPENAPI-JSON path-count=%d operations-params=%d sort-values=%d usage-events-params=%d dropped-paths=%d schemas=%d"
      % (len(after), len(QUERY_PARAMS), len(SORT_VALUES), len(USAGE_EVENT_QUERY_PARAMS),
         len(dropped), len(_schemas)))

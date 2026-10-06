"""Independent analysis of docs/21-openapi.json for VERIFY-PLAT-MIG-03-905.

Read-only. Checks PLAT-MIG-03 acceptance surfaces and cross-checks the
Connector/admin blocks against the real router sources.
"""
import io
import json
import re

DOC = "du-rework/docs/21-openapi.json"
CONN_SRC = "du-rework/services/connector/src/http/server.ts"
ADMIN_SRC = "du-rework/services/orchestrator/src/http/routes/admin.ts"

ADMIN_TEXT = io.open(ADMIN_SRC, encoding="utf-8").read()

doc = json.load(io.open(DOC, encoding="utf-8"))
paths = doc["paths"]
schemas = doc["components"]["schemas"]
fails = []


def check(cond, msg):
    print(("PASS" if cond else "FAIL"), "-", msg)
    if not cond:
        fails.append(msg)


def shows(op, key):
    return json.dumps(op.get(key, ""), ensure_ascii=False)


print("== counts ==")
check(len(paths) == 54, "path count is 54 (actual %d)" % len(paths))
check(len(schemas) == 14, "schema count is 14 (actual %d)" % len(schemas))

print("== no invented prefixes ==")
bad = sorted(p for p in paths if re.match(r"^/(internal/v1|management)", p))
check(not bad, "no /internal/v1 or /management path (found %r)" % bad)
any_mgmt = sorted(p for p in paths if "management" in p)
check(not any_mgmt, "no path containing 'management' (found %r)" % any_mgmt)

print("== /api/v1/admin/actions ==")
check("/api/v1/admin/actions" in paths, "admin actions path present")
if "/api/v1/admin/actions" in paths:
    act = paths["/api/v1/admin/actions"]
    check(set(act) == {"post"}, "admin actions is POST only (methods %r)" % sorted(act))
    op = act.get("post", {})
    resps = op.get("responses", {})
    check("405" in resps, "405 documented for non-POST")
    check("non-post" in shows(resps.get("405"), "description").lower(),
          "405 description names non-POST: %r" % shows(resps.get("405"), "description"))
    check("404" in resps, "404 documented for unknown action")
    check(re.search(r"[Uu]nknown action", shows(resps.get("404"), "description")) is not None,
          "404 description names unknown action: %r" % shows(resps.get("404"), "description"))
    check("503" in resps, "503 documented for unavailable composition")
    header_names = [p.get("name") for p in op.get("parameters", [])]
    check("idempotency-key" in header_names, "idempotency-key header documented")
    req = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
    check(req.get("required") == ["action"], "request body requires action")
    src = io.open(ADMIN_SRC, encoding="utf-8").read()
    check("if (pathname === '/api/v1/admin/actions')" in src, "actions route exists in admin.ts")
    guard_src = io.open("du-rework/services/orchestrator/src/modules/admin-actions/rbac.ts", encoding="utf-8").read()
    check("method !== 'POST'" in guard_src, "method guard answers 405 for non-POST")
    disp = io.open("du-rework/services/orchestrator/src/modules/admin-actions/dispatcher.ts", encoding="utf-8").read()
    check("status: 404" in disp and "unsupported admin action" in disp, "dispatcher answers 404 for unknown action")

print("== platform capabilities are composition booleans ==")
if "/api/v1/admin/connectors/capabilities" in paths:
    cap = paths["/api/v1/admin/connectors/capabilities"]
    check(set(cap) == {"get"}, "capabilities is GET only (methods %r)" % sorted(cap))
    capop = cap.get("get", {})
    s = capop.get("responses", {}).get("200", {}).get("content", {}).get("application/json", {}).get("schema", {})
    check(s.get("required") == ["management", "credentialWorkflow", "test"],
          "capabilities required keys are management/credentialWorkflow/test: %r" % s.get("required"))
    props = s.get("properties", {})
    check(all(props.get(k) == {"type": "boolean"} for k in ("management", "credentialWorkflow", "test")),
          "all three capabilities are plain booleans: %r" % props)
    check(not any(k in json.dumps(props) for k in ("enum", "default", "const", "config")),
          "capabilities carry no config value/enum/default: %r" % json.dumps(props, ensure_ascii=False))
    adminsrc = io.open(ADMIN_SRC, encoding="utf-8").read()
    check("management: !!ctx.connectorManagement" in adminsrc
          and "credentialWorkflow: !!ctx.credentialWorkflow" in adminsrc
          and "test: !!ctx.connectorManagement" in adminsrc,
          "admin.ts derives the three booleans by composition")
else:
    check(False, "platform capabilities path present")

print("== admin connector block ==")
for p, methods in [("/api/v1/admin/connectors", {"get"}),
                   ("/api/v1/admin/connectors/{id}/revisions/{rev}", {"get"})]:
    check(p in paths and set(paths.get(p, {})) == methods,
          "%s is %r (actual %r)" % (p, sorted(methods), sorted(paths.get(p, {}))))
check("503" in paths.get("/api/v1/admin/connectors", {}).get("get", {}).get("responses", {}),
      "admin connectors list documents 503 when store absent")
rev_resps = paths.get("/api/v1/admin/connectors/{id}/revisions/{rev}", {}).get("get", {}).get("responses", {})
check("404" in rev_resps, "admin revision read documents 404")

print("== real Connector router ==")
conn_expected = {
    "/health/live": {"get": None},
    "/health/ready": {"get": None},
    "/capabilities": {"get": "connector:invoke"},
    "/connectors": {"get": "connector:manage", "post": "connector:manage"},
    "/connectors/{id}/revisions": {"post": "connector:manage"},
    "/connectors/{id}/revisions/bootstrap": {"post": "connector:manage"},
    "/connectors/{id}/revisions/{revision}/activate": {"post": "connector:manage"},
    "/connectors/{id}/revisions/{revision}/retire": {"post": "connector:manage"},
    "/connectors/{id}/revisions/current": {"get": "connector:manage"},
    "/connectors/{id}/revisions/{revision}": {"get": "connector:manage"},
    "/invocations": {"post": "connector:invoke"},
    "/invocations/{id}": {"get": "connector:invoke"},
    "/invocations/{id}/cancel": {"post": "connector:invoke"},
    "/connectors/{id}/credentials/rotate": {"post": "connector:manage"},
    "/connectors/{id}/disable": {"post": "connector:manage"},
    "/connectors/{id}/test": {"post": "connector:manage"},
}
root_paths = sorted(p for p in paths if not p.startswith("/api"))
missing = sorted(p for p in conn_expected if p not in paths)
# /health is the Orchestrator liveness alias (server.ts), not a Connector route;
# every Connector root path carries the localhost:8080 servers override.
extra_root = sorted(p for p in root_paths if p not in conn_expected and p != "/health")
check(not missing, "every real Connector route is in docs21 (missing %r)" % missing)
check(not extra_root, "no extra root path beyond the real Connector routes (extra %r)" % extra_root)
for p, methods in sorted(conn_expected.items()):
    if p not in paths:
        continue
    check(set(paths[p]) == set(methods),
          "connector path %s methods %r (actual %r)" % (p, sorted(methods), sorted(paths[p])))
    for m, scope in sorted(methods.items()):
        op = paths[p][m]
        if scope is None:
            check(op.get("security") == [], "%s %s is unauthenticated health" % (m, p))
            continue
        check(op.get("x-required-service-scope") == scope,
              "%s %s scope %s (actual %r)" % (m, p, scope, op.get("x-required-service-scope")))
        check(op.get("security") == [{"Svc": []}], "%s %s security Svc[]" % (m, p))
        check("401" in op.get("responses", {}) and "403" in op.get("responses", {}),
              "%s %s documents 401 and 403" % (m, p))
        servers = op.get("servers") or []
        check(any(s.get("url") == "http://localhost:8080" for s in servers),
              "%s %s pins internal Connector origin" % (m, p))

src = io.open(CONN_SRC, encoding="utf-8").read()
check("path.startsWith('/connectors') ? 'connector:manage' : 'connector:invoke'" in src,
      "real router scope selector matches docs")
check("url.pathname" in src and "const path = url.pathname" in src,
      "real router uses root pathname without prefix")
fragments = [
    "method === 'GET' && path === '/health/live'",
    "method === 'GET' && path === '/health/ready'",
    "path === '/capabilities'",
    "method === 'GET' && path === '/connectors'",
    "method === 'POST' && path === '/connectors'",
    "const pending =",
    "const bootstrapped =",
    "const activated =",
    "const retired =",
    "const current =",
    "const one =",
    "method === 'POST' && path === '/invocations'",
    "path.startsWith('/invocations/')",
    "path.endsWith('/cancel')",
    "path.endsWith('/credentials/rotate')",
    "path.endsWith('/disable')",
    "path.endsWith('/test')",
]
for f in fragments:
    check(f in src, "router handler fragment present: %s" % f)
method_path_pairs = re.findall(r"method === '(\w+)' && path === '([^']+)'", src)
print("literal method+path handlers in server.ts:", sorted(method_path_pairs))
regex_handlers = re.findall(r"\^\\/connectors\\\/\(\[\^\/\]\+\)\\\/([\w-]+)", src)
print("regex connector subroutes in server.ts:", sorted(set(regex_handlers)))

print("== admin real routes vs docs21 (two-way) ==")
admin_literals = sorted(set(re.findall(r"pathname === '(/api/v1/admin/connectors[^']*)'", ADMIN_TEXT)))
print("admin literal connector routes:", admin_literals)
for route in admin_literals:
    check(route in paths, "admin literal route %s has a docs21 entry" % route)
cred_lines = [ln.strip() for ln in ADMIN_TEXT.splitlines()
              if "credentials$" in ln and "connectors" in ln.replace("\\/", "/")]
regex_cred = any("credentials$" in ln for ln in cred_lines)
print("credentials route source lines:", cred_lines)
if regex_cred and "/api/v1/admin/connectors/{id}/credentials" not in paths:
    print("GAP - real admin route /api/v1/admin/connectors/{id}/credentials (GET/POST, admin.ts:247) is NOT in docs21")
elif regex_cred:
    check("/api/v1/admin/connectors/{id}/credentials" in paths, "credentials route documented")

print("== docs21 API paths: source-literal heuristic scan ==")
import os
ort_files = []
for root, dirs, files in os.walk("du-rework/services/orchestrator/src"):
    for f in files:
        if f.endswith(".ts"):
            ort_files.append(os.path.join(root, f))
ort_src = "\n".join(io.open(f, encoding="utf-8", errors="replace").read() for f in ort_files)
for p in sorted(paths):
    if not p.startswith("/api"):
        continue
    static = p.split("{")[0].rstrip("/")
    if static not in ort_src and static.replace("/", "\\/") not in ort_src:
        print("NO-LITERAL-ORCHESTRATOR", p)

print("== all docs21 paths ==")
for p in sorted(paths):
    print("%-58s %s" % (p, "+".join(sorted(paths[p]))))

print("== result ==")
print("FAILURES:", len(fails))
for f in fails:
    print("FAIL:", f)
raise SystemExit(1 if fails else 0)

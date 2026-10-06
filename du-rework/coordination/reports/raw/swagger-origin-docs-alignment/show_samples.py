"""Print representative per-family operations from the regenerated docs21."""
import io
import json

spec = json.load(io.open("du-rework/docs/21-openapi.json", encoding="utf-8"))
samples = [
    ("/api/v1/operations", "get"),
    ("/api/v1/usage/events", "get"),
    ("/api/v1/admin/actions", "post"),
    ("/api/v1/admin/connectors/capabilities", "get"),
    ("/api/runtime/v1/tasks/{id}/claim", "post"),
    ("/capabilities", "get"),
    ("/connectors", "post"),
    ("/invocations/{id}", "get"),
]
print("top-level servers:", json.dumps(spec["servers"], ensure_ascii=False))
print("top-level tags:", json.dumps(spec["tags"], ensure_ascii=False))
print("info.version:", spec["info"]["version"])
for path, method in samples:
    op = spec["paths"][path][method]
    print("%-6s %-48s family=%-9s tags=%s" % (
        method.upper(), path, op.get("x-api-family"), op.get("tags")))
    print("        servers=%s" % json.dumps(op.get("servers"), ensure_ascii=False))

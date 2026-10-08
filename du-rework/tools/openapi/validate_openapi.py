"""Validate docs/21-openapi.json examples against @du/contracts zod schemas.

Usage: python du-rework/tools/openapi/validate_openapi.py
Exit 0 iff the spec parses, required paths exist, and every example passes.
Covers: submit, operations poll page, submit-ack, result envelope,
artifact upload/finalize/access requests, invocation grant + request,
usage event batch, admin profile-bindings body, connector test outcome,
runtime registration/claim/heartbeat/step/children/wait/complete/fail,
connector invocation request. Docs-only: node safeParse, no DB.
"""
import io, json, subprocess, sys
from pathlib import Path
import os
import argparse

os.chdir(Path(__file__).resolve().parents[3])

SPEC = "du-rework/docs/21-openapi.json"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', default=SPEC, help='Artifact to validate (absolute path supported for temporary generation).')
    spec = json.load(io.open(parser.parse_args().spec, encoding="utf-8"))
    assert spec.get("openapi") == "3.0.3", "openapi version"
    paths = spec.get("paths", {})
    need = ["/api/v1/businesses/{id}/actions/{action}", "/api/v1/operations",
            "/api/v1/operations/{id}", "/api/v1/operations/{id}/result",
            "/api/v1/operations/{id}/cancel", "/api/v1/operations/{id}/resume",
            "/api/v1/usage/summary", "/api/v1/connectors/{id}/test",
            "/api/v1/admin/businesses/{id}/versions/{version}/enable",
            "/api/v1/admin/businesses/{id}/versions/{version}/activate",
            "/api/v1/admin/businesses/{id}/versions/{version}/deactivate",
            "/api/v1/admin/profile-bindings",
            "/api/runtime/v1/businesses/{id}/versions/{version}",
            "/api/runtime/v1/tasks/{id}/claim",
            "/api/runtime/v1/tasks/{id}/invocation-grants",
            "/api/runtime/v1/tasks/{id}/children",
            "/api/runtime/v1/tasks/{id}/wait-input",
            "/api/runtime/v1/tasks/{id}/artifacts",
            "/api/runtime/v1/artifacts/{id}/finalize",
            "/api/runtime/v1/artifacts/{id}/access",
            "/invocations", "/health/ready"]
    missing = [p for p in need if p not in paths]
    assert not missing, "missing paths: %s" % missing
    for workflow_path, selector in [('/api/v1/docs/workflows', 'process'),
                                     ('/api/v1/docs/workflows/schema', 'schemaSlug')]:
        workflow = paths[workflow_path]['post']
        assert workflow['security'] == [{'ApiKey': []}], 'Workflow auth drift'
        assert workflow['x-api-family'] == 'public', 'Workflow ingress drift'
        form = workflow['requestBody']['content']['multipart/form-data']['schema']
        assert form['required'] == [selector], 'Workflow selector contract drift'
        assert all(field in form['properties'] for field in ['files[]', 'source_file', 'target_file', 'file']), 'Workflow file fields missing'
        assert 'Operation-Location' in workflow['responses']['202']['headers'], 'Workflow poll header missing'
        assert '200' not in workflow['responses'], 'Legacy workflows are always async'
        assert {'400', '401', '403', '404', '413', '422', '503'}.issubset(workflow['responses']), 'Workflow errors missing'
    assert paths['/api/v1/docs/workflows']['post']['requestBody']['content']['multipart/form-data']['schema']['properties']['process']['enum'] == ['disbursement', 'lc-checker', 'doc-compare']
    print('WORKFLOW-FACADE-CONTRACTS-VALIDATED routes=2 runtime-acceptance=separate')
    assert isinstance(spec.get("x-absent"), list) and len(spec["x-absent"]) >= 5, "x-absent"
    print("paths=%d x-absent=%d" % (len(paths), len(spec["x-absent"])))
    projection = subprocess.run(['node', 'du-rework/tools/openapi/catalog_callback_schemas.cjs'],
                                capture_output=True, text=True, check=True)
    canonical = json.loads(projection.stdout)
    assert all(spec['components']['schemas'].get(name) == schema for name, schema in canonical.items()), 'SC/CB canonical schema drift'
    create = paths['/admin/api/secrets']['post']
    assert create['requestBody']['required'] is True, 'POST create DTO missing'
    body = create['requestBody']['content']['application/json']['schema']
    assert body['properties'] == canonical['SecretCatalogCreate']['properties'], 'create fields drifted'
    assert body['required'] == [key for key in canonical['SecretCatalogCreate']['required'] if key != 'tenantId'], 'BFF tenant-injection requirements drifted'
    assert 'x-planned-request-schema' not in create, 'obsolete unreachable-create marker'
    assert {'401', '403', '404', '405', '413', '422', '503'}.issubset(create['responses']), 'create error/availability contract drifted'
    assert any(p['name'] == 'x-csrf-token' and p.get('required') for p in create['parameters']), 'mutation CSRF missing'
    for path in ['/admin/api/secrets', '/admin/api/secrets/{secretId}/rotate',
                 '/admin/api/secrets/{secretId}/disable', '/admin/api/secrets/{secretId}/test']:
        assert path in paths, 'missing BFF route: ' + path
        for operation in paths[path].values():
            assert operation['x-api-family'] == 'admin'
            assert operation['security'] == [{'PortalSession': []}]
    def check_refs(value):
        if isinstance(value, dict):
            if '$ref' in value:
                assert value['$ref'].startswith('#/'), 'unexpected external ref'
                resolved = spec
                for key in value['$ref'][2:].split('/'):
                    resolved = resolved[key.replace('~1', '/').replace('~0', '~')]
            for child in value.values(): check_refs(child)
        elif isinstance(value, list):
            for child in value: check_refs(child)
    check_refs(spec)
    ids = [operation['operationId'] for item in paths.values() for operation in item.values() if 'operationId' in operation]
    assert len(ids) == len(set(ids)), 'duplicate operationId'
    print('SC-CB-CANONICAL-SCHEMAS-VALIDATED count=%d refs=resolved operationIds=unique' % len(canonical))
    probe = open(__import__("os").path.join("du-rework", "tools", "openapi", "probe_cases.js"), encoding="utf-8").read()
    r = subprocess.run(["node", "-e", probe], capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        sys.stdout.write(r.stderr[-1000:])
        raise SystemExit("contract example validation failed")
    print("OPENAPI-EXAMPLES-VALIDATED")

if __name__ == "__main__":
    main()

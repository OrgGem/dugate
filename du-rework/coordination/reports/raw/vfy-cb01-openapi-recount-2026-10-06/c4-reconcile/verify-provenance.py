"""C4-PROV-01 close-out: validate temporary generation before canonical regeneration."""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[5]
raw = Path(__file__).resolve().parent
os.chdir(root)
artifact = Path('docs/21-openapi.json')
before_bytes = artifact.read_bytes()
before = json.loads(before_bytes)
methods = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'}
def ops(doc):
    return {(path, method) for path, item in doc['paths'].items() for method in item if method in methods}

def run(name, command):
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
    (raw / (name + '.log')).write_text(result.stdout + result.stderr, encoding='utf-8')
    (raw / (name + '.exit.txt')).write_text(str(result.returncode), encoding='utf-8')
    assert result.returncode == 0, name
    return result.stdout

sys.path.insert(0, str(Path(os.environ['TEMP']) / 'du-openapi-validator-sc04'))
from openapi_spec_validator import OpenAPIV30SpecValidator
import openapi_spec_validator
with tempfile.TemporaryDirectory(prefix='du-c4-reconcile-') as temporary:
    target = Path(temporary) / 'spec.json'
    target.write_bytes(before_bytes)
    source = Path('tools/openapi/gen_openapi.py')
    tree = ast.parse(source.read_text(encoding='utf-8'))
    count = 0
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'OUT' for t in node.targets):
            node.value = ast.Constant(str(target))
            count += 1
    assert count == 1
    isolated = Path(temporary) / 'generator.py'
    isolated.write_text('__file__=' + repr(str(source.resolve())) + '\n' + ast.unparse(tree), encoding='utf-8')
    generated = run('temp-generator', [sys.executable, str(isolated)])
    assert 'NO-DROP paths=0 operations=0' in generated
    temp_doc = json.loads(target.read_text(encoding='utf-8'))
    errors = list(OpenAPIV30SpecValidator(temp_doc).iter_errors())
    (raw / 'temp-structural.log').write_text('validator=' + openapi_spec_validator.__version__ + '\nerrors=' + str(len(errors)), encoding='utf-8')
    (raw / 'temp-structural.exit.txt').write_text('1' if errors else '0', encoding='utf-8')
    assert not errors
    run('temp-validator', [sys.executable, 'tools/openapi/validate_openapi.py', '--spec', str(target)])
    assert artifact.read_bytes() == before_bytes, 'canonical artifact touched before temp validation'
    expected = target.read_bytes()
    # Canonical artifact is written only by the unmodified-output generator.
    run('canonical-generator', [sys.executable, 'tools/openapi/gen_openapi.py'])
    assert artifact.read_bytes() == expected
    run('temp-generator-repeat', [sys.executable, str(isolated)])
    assert target.read_bytes() == expected, 'non-deterministic generation'
run('canonical-validator', [sys.executable, 'tools/openapi/validate_openapi.py'])
after = json.loads(artifact.read_text(encoding='utf-8'))
assert (len(after['paths']), len(ops(after)), len(after['components']['schemas'])) == (58, 62, 51)
changed_ops = sorted((path, method) for path, method in ops(before) & ops(after)
                     if before['paths'][path][method] != after['paths'][path][method])
assert changed_ops == [('/admin/api/secrets', 'post')], changed_ops
assert before['components']['schemas'] == after['components']['schemas']
head = run('head', ['git', 'rev-parse', 'HEAD']).strip()
summary = {
    'counts': [58, 62, 51], 'version': after['info']['version'], 'head': head,
    'beforeArtifactSha256': hashlib.sha256(before_bytes).hexdigest(),
    'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
    'tempGeneratorExit': 0, 'canonicalGeneratorExit': 0, 'validatorExit': 0,
    'structuralErrors': 0, 'noDropPaths': len(set(before['paths']) - set(after['paths'])),
    'noDropOperations': len(ops(before) - ops(after)),
    'noDropSchemas': len(set(before['components']['schemas']) - set(after['components']['schemas'])),
    'changedOperations': changed_ops, 'repeatByteIdentical': True, 'tempMatchesCanonical': True,
}
assert summary['noDropPaths'] == summary['noDropOperations'] == summary['noDropSchemas'] == 0
(raw / 'run-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
files = [Path(f) for f in ['tools/openapi/gen_openapi.py', 'tools/openapi/validate_openapi.py',
    'tools/openapi/catalog_callback_schemas.cjs', 'services/orchestrator/src/app/admin/bff/secrets.ts', 'docs/21-openapi.json']]
files += [p for p in raw.iterdir() if p.name != 'SHA256SUMS.txt']
(raw / 'SHA256SUMS.txt').write_text('\n'.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.as_posix() for p in files) + '\n', encoding='utf-8')
print(json.dumps(summary))

"""Offline receipt runner; run from du-rework. Optional validator in TEMP."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[4]
raw = Path(__file__).resolve().parent
os.chdir(root)

def run(name, command):
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
    (raw / (name + '.log')).write_text(result.stdout + result.stderr, encoding='utf-8')
    (raw / (name + '.exit.txt')).write_text(str(result.returncode), encoding='utf-8')
    assert result.returncode == 0, name
    return result.stdout

run('generator', [sys.executable, 'tools/openapi/gen_openapi.py'])
artifact = Path('docs/21-openapi.json')
first = hashlib.sha256(artifact.read_bytes()).hexdigest()
run('generator-repeat', [sys.executable, 'tools/openapi/gen_openapi.py'])
assert first == hashlib.sha256(artifact.read_bytes()).hexdigest(), 'non-deterministic artifact'
run('validator', [sys.executable, 'tools/openapi/validate_openapi.py'])
sys.path.insert(0, str(Path(os.environ['TEMP']) / 'du-openapi-validator-sc04'))
from openapi_spec_validator import OpenAPIV30SpecValidator
import openapi_spec_validator
doc = json.loads(artifact.read_text(encoding='utf-8'))
errors = list(OpenAPIV30SpecValidator(doc).iter_errors())
(raw / 'structural.log').write_text('openapi-spec-validator=' + openapi_spec_validator.__version__ + '\nerrors=' + str(len(errors)) + '\n' + '\n'.join(map(str, errors)), encoding='utf-8')
(raw / 'structural.exit.txt').write_text('1' if errors else '0', encoding='utf-8')
assert not errors, errors
summary = {
    'cwd': str(root), 'offline': True, 'artifactSha256': first,
    'paths': len(doc['paths']),
    'operations': sum(len(item) for item in doc['paths'].values()),
    'schemas': len(doc['components']['schemas']),
    'generatorExit': 0, 'validatorExit': 0, 'structuralExit': 0,
    'repeatUnchanged': True, 'droppedPaths': 0, 'droppedOperations': 0,
}
(raw / 'run-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
files = ['tools/openapi/gen_openapi.py', 'tools/openapi/validate_openapi.py',
         'tools/openapi/catalog_callback_schemas.cjs', 'docs/21-openapi.json',
         'docs/08-connector-api.md', 'docs/40-du-platform-architecture.md']
(raw / 'SHA256SUMS.txt').write_text('\n'.join(hashlib.sha256(Path(f).read_bytes()).hexdigest() + '  ' + f for f in files) + '\n', encoding='utf-8')
print(json.dumps(summary))

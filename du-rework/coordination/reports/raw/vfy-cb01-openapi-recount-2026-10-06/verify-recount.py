"""Read-only independent recount, isolated output regeneration, applied-state probe."""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[4]
raw = Path(__file__).resolve().parent
os.chdir(root)

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def run(name, command, input_text=None, required=True):
    result = subprocess.run(command, input=input_text, capture_output=True, text=True, encoding='utf-8')
    (raw / (name + '.log')).write_text(result.stdout + result.stderr, encoding='utf-8')
    (raw / (name + '.exit.txt')).write_text(str(result.returncode), encoding='utf-8')
    if required:
        assert result.returncode == 0, name
    return result.stdout

methods = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'}
def operations(doc):
    return {(path, method) for path, item in doc['paths'].items() for method in item if method in methods}

artifact = Path('docs/21-openapi.json')
original_hash = digest(artifact)
doc = json.loads(artifact.read_text(encoding='utf-8'))
head = run('head', ['git', 'rev-parse', 'HEAD']).strip()
baseline_bytes = subprocess.run(['git', 'show', 'HEAD:du-rework/docs/21-openapi.json'], capture_output=True, check=True).stdout
baseline = json.loads(baseline_bytes)
source = Path('tools/openapi/gen_openapi.py')
with tempfile.TemporaryDirectory(prefix='du-c4-recount-') as temporary:
    target = Path(temporary) / 'openapi.json'
    target.write_bytes(artifact.read_bytes())
    tree = ast.parse(source.read_text(encoding='utf-8'))
    replacements = 0
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'OUT' for t in node.targets):
            node.value = ast.Constant(str(target))
            replacements += 1
    assert replacements == 1
    isolated = Path(temporary) / 'gen-isolated.py'
    # __file__ stays canonical for script-relative input resolution. Only OUT
    # is redirected in an in-memory AST; canonical generator is never edited.
    isolated.write_text("__file__=" + repr(str(source.resolve())) + "\n" + ast.unparse(tree), encoding='utf-8')
    output = run('generator-isolated', [sys.executable, str(isolated)], required=False)
    generator_exit = int((raw / 'generator-isolated.exit.txt').read_text())
    generator_matches = generator_exit == 0 and target.read_bytes() == artifact.read_bytes()
run('canonical-validator', [sys.executable, 'tools/openapi/validate_openapi.py'])
sys.path.insert(0, str(Path(os.environ['TEMP']) / 'du-openapi-validator-sc04'))
from openapi_spec_validator import OpenAPIV30SpecValidator
import openapi_spec_validator
errors = list(OpenAPIV30SpecValidator(doc).iter_errors())
(raw / 'structural.log').write_text('version=' + openapi_spec_validator.__version__ + '\nerrors=' + str(len(errors)), encoding='utf-8')
assert not errors
assert (len(doc['paths']), len(operations(doc)), len(doc['components']['schemas'])) == (58, 62, 51)
delta = {
    'baseline': 'HEAD:' + head + ':du-rework/docs/21-openapi.json',
    'baselineSha256': hashlib.sha256(baseline_bytes).hexdigest(),
    'baselineCounts': [len(baseline['paths']), len(operations(baseline)), len(baseline['components']['schemas'])],
    'addedPaths': sorted(set(doc['paths']) - set(baseline['paths'])),
    'droppedPaths': sorted(set(baseline['paths']) - set(doc['paths'])),
    'addedOperations': sorted(operations(doc) - operations(baseline)),
    'droppedOperations': sorted(operations(baseline) - operations(doc)),
    'addedSchemas': sorted(set(doc['components']['schemas']) - set(baseline['components']['schemas'])),
    'droppedSchemas': sorted(set(baseline['components']['schemas']) - set(doc['components']['schemas'])),
    'semanticEqual': doc == baseline,
}
assert not delta['droppedPaths'] and not delta['droppedOperations'] and not delta['droppedSchemas']
(raw / 'baseline-diff.json').write_text(json.dumps(delta, indent=2), encoding='utf-8')
container = 'arch-phase-b-20261006-postgres-1'
run('stack-attribution', ['docker', 'inspect', '--format', '{{.Name}} {{.Config.Image}} {{.Image}}',
                         container, 'arch-phase-b-20261006-orchestrator-1'])
sql = """BEGIN READ ONLY;
SELECT max(sequence) AS max_sequence, count(*) AS applied_count FROM schema_migrations;
SELECT sequence, filename FROM schema_migrations WHERE sequence >= 34 ORDER BY sequence;
SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
WHERE table_schema='public' AND ((table_name='operations' AND column_name='callback_policy') OR
(table_name='webhook_deliveries' AND column_name IN ('mode','callback_policy')));
COMMIT;
"""
(raw / 'applied-state.sql').write_text(sql, encoding='utf-8')
run('applied-state', ['docker', 'exec', '-i', container, 'sh', '-c',
    'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], sql)
assert digest(artifact) == original_hash, 'artifact changed during read-only verification'
summary = {'artifactVersion': doc['info']['version'], 'counts': [58, 62, 51],
    'artifactSha256': original_hash, 'generatorExit': generator_exit, 'generatorOutputMatches': generator_matches,
    'freshGeneratorNoDrop': [0, 0] if generator_exit == 0 else None,
    'baselineDroppedPaths': len(delta['droppedPaths']), 'baselineDroppedOperations': len(delta['droppedOperations']),
    'structuralErrors': len(errors), 'baselineSemanticEqual': delta['semanticEqual'],
    'head': head, 'productArtifactUnchanged': True,
    'generatorSha256': digest(source), 'projectionSha256': digest('tools/openapi/catalog_callback_schemas.cjs'),
    'migration0035Sha256': digest('services/orchestrator/migrations/0035_webhook_result_delivery.sql')}
(raw / 'run-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps(summary))

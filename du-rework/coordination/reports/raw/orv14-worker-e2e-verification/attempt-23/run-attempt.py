import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

repo = pathlib.Path('/workspace/dugate/du-rework')
orchestrator = repo / 'orchestrator'
raw = repo / 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-23'
node = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node'
jest = str(repo / 'businesses/document-core/node_modules/jest/bin/jest.js')
name_pattern = 'Gemini and OpenAI-compatible AI model defaults reach native provider tests and real Worker calls, with immutable old/new pins and Profile precedence'
cmd = [node, jest, '--config', 'tests/workflow-api/jest.config.cjs', '--runInBand',
       '--runTestsByPath', 'tests/workflow-api/orv14-vfy-core31.test.ts', '--testNamePattern', name_pattern]
reference = raw.parent / 'attempt-17/dependency-inputs-before.sha256'
relative_paths = sorted({line.strip().split('  ', 1)[1] for line in reference.read_text().splitlines() if '  ' in line})
contracts_source = raw / 'backend-service-runtime-bootid-contracts-src.sha256'
contracts_dist = raw / 'backend-service-runtime-bootid-contracts-dist.sha256'

def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha256_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

def write_snapshot(destination):
    lines = []
    missing = []
    for relative in relative_paths:
        path = repo / relative
        if not path.is_file():
            missing.append(relative)
            continue
        lines.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}\n')
    (raw / f'{destination}.sha256').write_text(''.join(lines))
    (raw / f'{destination}.sha256.missing').write_text(''.join(f'{p}\n' for p in missing))
    return {'sha256': hashlib.sha256(''.join(lines).encode()).hexdigest(), 'files': len(lines), 'missing': missing}

def verify_manifest(path):
    rows = path.read_text().splitlines()
    mismatches = []
    for row in rows:
        expected, relative = row.split('  ', 1)
        live = orchestrator / relative
        actual = sha256_file(live) if live.is_file() else None
        if actual != expected:
            mismatches.append({'path': relative, 'expected': expected, 'actual': actual})
    return {
        'path': str(path.relative_to(repo)),
        'aggregateSha256': sha256_file(path),
        'entries': len(rows),
        'mismatches': mismatches,
    }

source_paths = {
    'workerVerifierCore31Test': 'tests/workflow-api/orv14-vfy-core31.test.ts',
    'workflowImportContractSource': 'orchestrator/packages/contracts/src/workflow-import.ts',
    'legacyWorkflowContractSource': 'orchestrator/packages/contracts/src/legacy-workflow.ts',
    'workflowImportContractDist': 'orchestrator/packages/contracts/dist/workflow-import.js',
    'legacyWorkflowContractDist': 'orchestrator/packages/contracts/dist/legacy-workflow.js',
    'contractsIndexDist': 'orchestrator/packages/contracts/dist/index.js',
    'legacyWorkflowDecoder': 'orchestrator/services/orchestrator/src/compat/legacy-workflow-decoders.ts',
    'workflowImportPreview': 'orchestrator/services/orchestrator/src/modules/workflow-import/preview.ts',
    'internalWorkflowImportRoute': 'orchestrator/services/orchestrator/src/http/routes/internal-workflow-import.ts',
    'adminActionsRoute': 'orchestrator/services/orchestrator/src/http/routes/admin.ts',
    'adminActionDispatcher': 'orchestrator/services/orchestrator/src/modules/admin-actions/dispatcher.ts',
    'workflowSchemaCatalog': 'orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas.ts',
    'orchestratorCreateApp': 'orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts',
    'orchestratorServer': 'orchestrator/services/orchestrator/src/server.ts',
    'documentCoreWorker': 'businesses/document-core/src/worker.ts',
    'documentCoreMain': 'businesses/document-core/src/main.ts',
    'documentCoreLegacyWorkflowRuntime': 'businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts',
    'documentCoreManifest': 'businesses/document-core/src/manifest/document-core.manifest.ts',
    'workerSdkTaskContextSource': 'orchestrator/packages/worker-sdk/src/task-context.ts',
    'workerSdkTaskContextDist': 'orchestrator/packages/worker-sdk/dist/task-context.js',
    'workerSdkTaskContextTypesDist': 'orchestrator/packages/worker-sdk/dist/task-context.d.ts',
    'workerSdkIndexDist': 'orchestrator/packages/worker-sdk/dist/index.js',
    'workerSdkIndexTypesDist': 'orchestrator/packages/worker-sdk/dist/index.d.ts',
    'observabilitySource': 'orchestrator/packages/observability/src/log-metadata.ts',
    'observabilityDist': 'orchestrator/packages/observability/dist/log-metadata.js',
    'connectorComposition': 'orchestrator/services/connector/src/composition.ts',
    'connectorEntrypoint': 'orchestrator/services/connector/src/entrypoint.ts',
    'connectorServices': 'orchestrator/services/connector/src/services.ts',
    'connectorRepository': 'orchestrator/services/connector/src/db/repository.ts',
    'connectorCostControlClient': 'orchestrator/services/connector/src/cost-control-client.ts',
    'connectorContractGrants': 'orchestrator/services/connector/src/contract-grants.ts',
    'connectorRuntimeControls': 'orchestrator/services/connector/src/db/replica-runtime-controls.ts',
    'connectorHttpServer': 'orchestrator/services/connector/src/http/server.ts',
    'globalSettingsService': 'orchestrator/services/orchestrator/src/modules/global-settings/service.ts',
    'internalGlobalSettingsRoute': 'orchestrator/services/orchestrator/src/http/routes/internal-global-settings.ts',
    'providerTestService': 'orchestrator/services/orchestrator/src/modules/connectors/provider-test.ts',
    'connectorManagementStore': 'orchestrator/services/orchestrator/src/modules/connectors/connector-management-store.ts',
    'internalCostControlRoute': 'orchestrator/services/orchestrator/src/http/routes/internal-cost-control.ts',
    'costControlService': 'orchestrator/services/orchestrator/src/modules/cost-control/service.ts',
    'ordinaryGrantProducer': 'orchestrator/services/orchestrator/src/modules/grants/grants.ts',
    'ordinaryGrantCostContextProducer': 'orchestrator/services/orchestrator/src/modules/cost-control/cost-context.ts',
    'ownedMinioHelper': 'tests/workflow-api/orv14-vfy-worker/owned-minio.ts',
    'privateHttpsHelper': 'tests/workflow-api/orv14-vfy-worker/private-https-fixture.ts',
}
source_pins = {name: sha256_file(repo / relative) for name, relative in source_paths.items()}
contracts_pins = {
    'source': verify_manifest(contracts_source),
    'dist': verify_manifest(contracts_dist),
}
if contracts_pins['source']['aggregateSha256'] != 'd33d0ce970a4f7620dde4854b0df2ddb272d824baf3efda84bafb36d99cde916':
    raise RuntimeError('Contracts source manifest differs from the current bootId contract checkpoint.')
if contracts_pins['dist']['aggregateSha256'] != '27cb417f246da2c9b31820af54d310163aaf8d657532c6cacb21b6c9a722c91a':
    raise RuntimeError('Contracts dist manifest differs from the current bootId contract checkpoint.')
if contracts_pins['source']['entries'] != 46 or contracts_pins['dist']['entries'] != 184:
    raise RuntimeError('Contracts manifest entry count differs from the recorded source/dist snapshot.')
if contracts_pins['source']['mismatches'] or contracts_pins['dist']['mismatches']:
    raise RuntimeError('Contracts live source/dist differs from the recorded manifest checkpoint.')

before = write_snapshot('dependency-inputs-before')
if before['missing']:
    raise RuntimeError(f'Input snapshot has missing files: {before["missing"]}')
inspect = subprocess.run(['docker', 'inspect', 'orv14-vfy-20261011-a1-postgres-1'], check=True, capture_output=True, text=True)
container = json.loads(inspect.stdout)[0]
container_env = dict(item.split('=', 1) for item in container.get('Config', {}).get('Env', []) if '=' in item)
password = container_env.get('POSTGRES_PASSWORD')
if not password:
    raise RuntimeError('Synthetic PostgreSQL container has no configured password')
user = container_env.get('POSTGRES_USER', 'orv14_vfy')
database = container_env.get('POSTGRES_DB', 'orv14_vfy')
db_url = 'postgresql://{}:{}@127.0.0.1:25414/{}'.format(
    urllib.parse.quote(user, safe=''), urllib.parse.quote(password, safe=''), urllib.parse.quote(database, safe=''))

run_context = {
    'attempt': '23',
    'cwd': str(repo),
    'startedAtUtc': utc_now(),
    'command': cmd,
    'node': node,
    'nodeVersion': subprocess.run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip(),
    'jest': jest,
    'testNamePattern': name_pattern,
    'environment': {
        'WFA_DATABASE_URL': 'postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy',
        'WFA_REDIS_URL': 'redis://127.0.0.1:26414/2 (per-run database index and namespace prefix allocated by test isolation)',
        'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
        'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
        'ORV14_WORKER_E2E_RAW_DIR': str(raw),
        'HTTP(S)_PROXY': 'inherited unchanged',
    },
    'composeProject': 'orv14-vfy-20261011-a1',
    'sourceScope': 'native tenant AI settings revisions through real typed Connector drafts and real HTTP provider-test/cost-control with actual OpenAI-compatible and Gemini fixture observations; publish old/new immutable AI defaults, execute actual document-core Worker calls, and verify locked Profile model precedence; capture bounded Orchestrator/Connector state on failure',
    'sourcePinsBefore': source_pins,
    'contractsSourceManifest': contracts_pins['source'],
    'contractsDistManifest': contracts_pins['dist'],
    'dependencyInputs': before,
    'composeImages': {
        'postgres': subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', 'orv14-vfy-20261011-a1-postgres-1'], check=True, capture_output=True, text=True).stdout.strip(),
        'redis': subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', 'orv14-vfy-20261011-a1-redis-1'], check=True, capture_output=True, text=True).stdout.strip(),
        'ownedMinio': {
            'tag': 'orv14-vfy/minio:RELEASE-2025-09-07',
            'imageId': subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'orv14-vfy/minio:RELEASE-2025-09-07'], check=True, capture_output=True, text=True).stdout.strip(),
        },
    },
}
(raw / 'run-context.json').write_text(json.dumps(run_context, indent=2) + '\n')
(raw / 'command.txt').write_text(
    'UTC start captured in run-context.json\n'
    f'CWD: {repo}\n'
    f'Pinned Node: {node} ({run_context["nodeVersion"]})\n'
    'Command: ' + ' '.join(cmd) + '\n'
    'Environment: WFA_DATABASE_URL=postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy; WFA_REDIS_URL=redis://127.0.0.1:26414/2 (test allocates unique DB/prefix); NODE_PATH=<document-core node_modules>; NODE_EXTRA_CA_CERTS=<fixture runner trust bundle>; ORV14_WORKER_E2E_RAW_DIR=<attempt-23>; proxy environment inherited unchanged\n'
    f'Input manifest: {before["files"]} files, SHA-256={before["sha256"]}; source pins={json.dumps(source_pins, sort_keys=True)}; contracts source/dist manifests SHA-256={contracts_pins["source"]["aggregateSha256"]}/{contracts_pins["dist"]["aggregateSha256"]}\n'
)

start = utc_now()
env = os.environ.copy()
env.update({
    'WFA_DATABASE_URL': db_url,
    'WFA_REDIS_URL': 'redis://127.0.0.1:26414/2',
    'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
    'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
    'ORV14_WORKER_E2E_RAW_DIR': str(raw),
})
with (raw / 'jest-stdout.txt').open('wb') as stdout, (raw / 'jest-stderr.txt').open('wb') as stderr:
    completed = subprocess.run(cmd, cwd=repo, env=env, stdout=stdout, stderr=stderr, check=False)
finish = utc_now()
(raw / 'exit-code.txt').write_text(f'{completed.returncode}\n')
(raw / 'run-times.txt').write_text(f'startedAtUtc={start}\nfinishedAtUtc={finish}\nexitCode={completed.returncode}\n')
after = write_snapshot('dependency-inputs-after')
source_pins_after = {name: sha256_file(repo / relative) for name, relative in source_paths.items()}
before_map = {line.split('  ', 1)[1]: line.split('  ', 1)[0] for line in (raw / 'dependency-inputs-before.sha256').read_text().splitlines()}
after_map = {line.split('  ', 1)[1]: line.split('  ', 1)[0] for line in (raw / 'dependency-inputs-after.sha256').read_text().splitlines()}
changed = [{'path': path, 'before': before_map.get(path), 'after': after_map.get(path)}
           for path in sorted(before_map.keys() | after_map.keys()) if before_map.get(path) != after_map.get(path)]
(raw / 'source-delta-summary.json').write_text(json.dumps({
    'dependencyInputsBefore': before,
    'dependencyInputsAfter': after,
    'sourcePinsBefore': source_pins,
    'sourcePinsAfter': source_pins_after,
    'contractsSourceManifestSha256': contracts_pins['source']['aggregateSha256'],
    'contractsDistManifestSha256': contracts_pins['dist']['aggregateSha256'],
    'changedInputs': changed,
}, indent=2) + '\n')
print(f'Run finished at {finish}; exit={completed.returncode}; inputs {before["sha256"]} -> {after["sha256"]}; source pins stable={source_pins == source_pins_after}; changed inputs={len(changed)}')
sys.exit(completed.returncode)

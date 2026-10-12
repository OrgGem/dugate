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
raw = repo / 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-11'
node = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node'
jest = str(repo / 'businesses/document-core/node_modules/jest/bin/jest.js')
name_pattern = 'browser uploads a document and submits workflow.test to real worker, then polls success'
cmd = [node, jest, '--config', 'tests/workflow-api/jest.config.cjs', '--runInBand',
       '--runTestsByPath', 'tests/workflow-api/orv14-vfy-core31.test.ts', '--testNamePattern', name_pattern]
reference = raw.parent / 'attempt-10/dependency-inputs-before.sha256'
relative_paths = sorted({line.strip().split('  ', 1)[1] for line in reference.read_text().splitlines() if '  ' in line})
contracts_source = raw / 'contracts-source-2026-10-12T015454Z.sha256'
contracts_dist = raw / 'contracts-dist-2026-10-12T015454Z.sha256'

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

def sha(path):
    return sha256_file(orchestrator / path)

before = write_snapshot('dependency-inputs-before')
create_app = 'services/orchestrator/src/app/bootstrap/create-app.ts'
ingestion_storage = 'services/orchestrator/src/modules/operations/ingestion-storage-s3.ts'
ingestion_consumer = 'services/orchestrator/src/modules/operations/ingestion-consumer.ts'
source_paths = {
    'createApp': create_app,
    'ingestionStorageS3': ingestion_storage,
    'ingestionConsumer': ingestion_consumer,
}
source_pins = {name: sha(path) for name, path in source_paths.items()}
contracts_pins = {
    'source': verify_manifest(contracts_source),
    'dist': verify_manifest(contracts_dist),
}
if contracts_pins['source']['aggregateSha256'] != 'f251c25ce1a8edc555c9d2fb9242f8785c7a0915a9a6396844fef93cc71243e1':
    raise RuntimeError('Unexpected 01:54:54 contracts source manifest digest.')
if contracts_pins['dist']['aggregateSha256'] != '70464110d8397c141235e132d5d0c951ce72bb07f83d65c765fbd0f2276ec255':
    raise RuntimeError('Unexpected 01:54:54 contracts dist manifest digest.')
if contracts_pins['source']['entries'] != 46 or contracts_pins['dist']['entries'] != 184:
    raise RuntimeError('The current contracts manifests do not have the recorded 46/184 file counts.')
if contracts_pins['source']['mismatches'] or contracts_pins['dist']['mismatches']:
    raise RuntimeError('Current contracts source/dist do not match the recorded 01:54:54 snapshot.')

inspect = subprocess.run(['docker', 'inspect', 'orv14-vfy-20261011-a1-postgres-1'], check=True, capture_output=True, text=True)
container = json.loads(inspect.stdout)[0]
container_env = dict(item.split('=', 1) for item in container.get('Config', {}).get('Env', []) if '=' in item)
password = container_env.get('POSTGRES_PASSWORD')
if not password:
    raise RuntimeError('Synthetic PostgreSQL container password was not available in its own configuration')
user = container_env.get('POSTGRES_USER', 'orv14_vfy')
database = container_env.get('POSTGRES_DB', 'orv14_vfy')
db_url = 'postgresql://{}:{}@127.0.0.1:25414/{}'.format(
    urllib.parse.quote(user, safe=''), urllib.parse.quote(password, safe=''), urllib.parse.quote(database, safe=''))

run_context = {
    'attempt': '11',
    'cwd': str(repo),
    'startedAtUtc': utc_now(),
    'command': cmd,
    'node': node,
    'nodeVersion': subprocess.run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip(),
    'jest': jest,
    'testNamePattern': name_pattern,
    'environment': {
        'WFA_DATABASE_URL': 'postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy',
        'WFA_REDIS_URL': 'redis://127.0.0.1:26414/2 (per-run DB index and namespace prefix allocated by test isolation)',
        'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
        'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
        'ORV14_WORKER_E2E_RAW_DIR': str(raw),
        'HTTP(S)_PROXY': 'inherited unchanged',
    },
    'composeProject': 'orv14-vfy-20261011-a1',
    'sourceScope': 'one previously-red browser workflow upload case only; normal Secret Catalog credential and stage/test/activate of isolated encrypted S3 generation, then actual upload, worker operation, decrypted public download, and cross-tenant ACL checks',
    'sourcePinsBefore': source_pins,
    'contractsSourceManifest': contracts_pins['source'],
    'contractsDistManifest': contracts_pins['dist'],
    'dependencyInputs': before,
    'composeImages': {
        'postgres': subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', 'orv14-vfy-20261011-a1-postgres-1'], check=True, capture_output=True, text=True).stdout.strip(),
        'redis': subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', 'orv14-vfy-20261011-a1-redis-1'], check=True, capture_output=True, text=True).stdout.strip(),
    },
}
(raw / 'run-context.json').write_text(json.dumps(run_context, indent=2) + '\n')
(raw / 'command.txt').write_text(
    'UTC start captured in run-context.json\n'
    f'CWD: {repo}\n'
    f'Pinned Node: {node} ({run_context["nodeVersion"]})\n'
    'Command: ' + ' '.join(cmd) + '\n'
    'Environment: WFA_DATABASE_URL=postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy; WFA_REDIS_URL=redis://127.0.0.1:26414/2 (test allocates unique DB/prefix); NODE_PATH=<document-core node_modules>; NODE_EXTRA_CA_CERTS=<fixture runner trust bundle>; ORV14_WORKER_E2E_RAW_DIR=<attempt-11>; proxy environment inherited unchanged\n'
    f'Input manifest: {before["files"]} files, SHA-256={before["sha256"]}; source pins={json.dumps(source_pins, sort_keys=True)}; contracts source/dist manifests SHA-256={contracts_pins["source"]["aggregateSha256"]}/{contracts_pins["dist"]["aggregateSha256"]}\n'
)
(raw / 'compose-resource-scope.json').write_text(json.dumps({
    'composeProject': 'orv14-vfy-20261011-a1',
    'postgresHostPort': 25414,
    'redisHostPort': 26414,
    'postgresSchema': 'created uniquely at test startup and dropped by exact name at cleanup',
    'redis': 'test isolation allocates a random DB index and per-run Redis/key/queue prefixes; no FLUSHDB or global key deletion',
    'minio': 'new uniquely labeled ephemeral container, loopback dynamic port, unique versioned bucket, tmpfs-only data, synthetic per-run credentials',
    'test': 'one previously-red browser workflow upload case only',
    'foreignResources': 'untouched',
    'composeStack': 'left running',
}, indent=2) + '\n')

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
source_pins_after = {name: sha(path) for name, path in source_paths.items()}
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

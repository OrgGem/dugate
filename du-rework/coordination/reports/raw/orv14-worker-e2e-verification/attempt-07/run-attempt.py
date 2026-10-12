import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

repo = pathlib.Path('/workspace/dugate/du-rework')
raw = repo / 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-07'
node = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node'
jest = str(repo / 'businesses/document-core/node_modules/jest/bin/jest.js')
name_pattern = 'configured Worker receives exact private HTTPS policy|parallel branch children|a resumed HITL workflow|tenant schema approval blocks|operator list and tenant pin intersect'
cmd = [node, jest, '--config', 'tests/workflow-api/jest.config.cjs', '--runInBand', '--runTestsByPath', 'tests/workflow-api/orv14-vfy-core31.test.ts', '--testNamePattern', name_pattern]

reference = raw.parent / 'attempt-06/dependency-inputs-before.sha256'
relative_paths = sorted({line.strip().split('  ', 1)[1] for line in reference.read_text().splitlines() if '  ' in line})

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

def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha256_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

before = write_snapshot('dependency-inputs-before')
create_app = repo / 'orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts'
create_app_before = sha256_file(create_app)
contracts_source = raw / 'contracts-source-2026-10-12T010823Z.sha256'
contracts_dist = raw / 'contracts-dist-2026-10-12T010823Z.sha256'

inspect = subprocess.run(['docker', 'inspect', 'orv14-vfy-20261011-a1-postgres-1'], check=True, capture_output=True, text=True)
container = json.loads(inspect.stdout)[0]
container_env = dict(item.split('=', 1) for item in container.get('Config', {}).get('Env', []) if '=' in item)
password = container_env.get('POSTGRES_PASSWORD')
if not password:
    raise RuntimeError('synthetic PostgreSQL container password was not available in its own configuration')
user = container_env.get('POSTGRES_USER', 'orv14_vfy')
database = container_env.get('POSTGRES_DB', 'orv14_vfy')
password_url = urllib.parse.quote(password, safe='')
db_url = f'postgresql://{urllib.parse.quote(user, safe="")}:{password_url}@127.0.0.1:25414/{urllib.parse.quote(database, safe="")}'

run_context = {
    'attempt': '07',
    'cwd': str(repo),
    'startedAtUtc': utc_now(),
    'command': cmd,
    'node': node,
    'nodeVersion': subprocess.run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip(),
    'jest': jest,
    'testNamePattern': name_pattern,
    'environment': {
        'WFA_DATABASE_URL': 'postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy',
        'WFA_REDIS_URL': 'redis://127.0.0.1:26414/2',
        'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
        'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
        'ORV14_WORKER_E2E_RAW_DIR': str(raw),
        'HTTP(S)_PROXY': 'inherited unchanged',
    },
    'composeProject': 'orv14-vfy-20261011-a1',
    'sourceScope': 'targeted corrected private HTTPS positives and tenant/operator policy fences; no whole-app freeze implied',
    'createAppSourceSha256Before': create_app_before,
    'contractsSourceManifestSha256': sha256_file(contracts_source),
    'contractsDistManifestSha256': sha256_file(contracts_dist),
    'dependencyInputs': before,
}
(raw / 'run-context.json').write_text(json.dumps(run_context, indent=2) + '\n')
(raw / 'command.txt').write_text(
    'UTC start captured in run-context.json\n'
    f'CWD: {repo}\n'
    f'Pinned Node: {node} ({run_context["nodeVersion"]})\n'
    'Command: ' + ' '.join(cmd) + '\n'
    'Environment: WFA_DATABASE_URL=postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy; WFA_REDIS_URL=redis://127.0.0.1:26414/2; NODE_PATH=<document-core node_modules>; NODE_EXTRA_CA_CERTS=<fixture runner trust bundle>; ORV14_WORKER_E2E_RAW_DIR=<attempt-07>; proxy environment inherited unchanged\n'
    f'Input manifest: {before["files"]} files, SHA-256={before["sha256"]}; create-app.ts SHA-256 before={create_app_before}; contracts source/dist manifests SHA-256={run_context["contractsSourceManifestSha256"]}/{run_context["contractsDistManifestSha256"]}\n'
)
(raw / 'compose-resource-scope.json').write_text(json.dumps({
    'composeProject': 'orv14-vfy-20261011-a1',
    'postgresPort': 25414,
    'redisPort': 26414,
    'test': 'five corrected private HTTPS and policy slices only; does not repeat 31 legacy variants',
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
create_app_after = sha256_file(create_app)
before_map = {line.split('  ', 1)[1]: line.split('  ', 1)[0] for line in (raw / 'dependency-inputs-before.sha256').read_text().splitlines()}
after_map = {line.split('  ', 1)[1]: line.split('  ', 1)[0] for line in (raw / 'dependency-inputs-after.sha256').read_text().splitlines()}
changed = [{'path': path, 'before': before_map.get(path), 'after': after_map.get(path)} for path in sorted(before_map.keys() | after_map.keys()) if before_map.get(path) != after_map.get(path)]
(raw / 'source-delta-summary.json').write_text(json.dumps({
    'dependencyInputsBefore': before,
    'dependencyInputsAfter': after,
    'createAppSha256Before': create_app_before,
    'createAppSha256After': create_app_after,
    'contractsSourceManifestSha256': run_context['contractsSourceManifestSha256'],
    'contractsDistManifestSha256': run_context['contractsDistManifestSha256'],
    'changedInputs': changed,
}, indent=2) + '\n')
print(f'Run finished at {finish}; exit={completed.returncode}; dependency input SHA before={before["sha256"]} after={after["sha256"]}; create-app stable={create_app_before == create_app_after}; changed inputs={len(changed)}')
sys.exit(completed.returncode)

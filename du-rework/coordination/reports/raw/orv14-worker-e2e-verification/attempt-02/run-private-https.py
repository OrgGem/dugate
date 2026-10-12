from datetime import datetime, timezone
from pathlib import Path
import json
import os
import subprocess
from urllib.parse import quote

repo = Path('/workspace/dugate/du-rework')
raw = repo / 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-02'
node = Path('/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node')
jest = repo / 'businesses/document-core/node_modules/jest/bin/jest.js'
container = 'orv14-vfy-20261011-a1-postgres-1'
inspect = subprocess.check_output(['docker', 'inspect', container], text=True)
container_config = json.loads(inspect)[0]['Config']
container_env = dict(item.split('=', 1) for item in container_config['Env'] if '=' in item)
user = container_env['POSTGRES_USER']
password = container_env['POSTGRES_PASSWORD']
database = container_env['POSTGRES_DB']
database_url = f'postgresql://{quote(user, safe="")}:{quote(password, safe="")}@127.0.0.1:25414/{quote(database, safe="")}'

command = [
    str(node), str(jest),
    '--config', 'tests/workflow-api/jest.config.cjs',
    '--runInBand', '--runTestsByPath', 'tests/workflow-api/orv14-vfy-core31.test.ts',
    '--testNamePattern', 'configured Worker private HTTPS',
]
env = os.environ.copy()
env.update({
    'WFA_DATABASE_URL': database_url,
    'WFA_REDIS_URL': 'redis://127.0.0.1:26414/2',
    'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
    'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
    'ORV14_WORKER_E2E_RAW_DIR': str(raw),
})
started = datetime.now(timezone.utc).isoformat()
context = {
    'cwd': str(repo),
    'startedAtUtc': started,
    'command': command,
    'node': str(node),
    'jest': str(jest),
    'environment': {
        'WFA_DATABASE_URL': 'postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy',
        'WFA_REDIS_URL': env['WFA_REDIS_URL'],
        'NODE_PATH': env['NODE_PATH'],
        'NODE_EXTRA_CA_CERTS': env['NODE_EXTRA_CA_CERTS'],
        'ORV14_WORKER_E2E_RAW_DIR': env['ORV14_WORKER_E2E_RAW_DIR'],
        'HTTP(S)_PROXY': 'inherited unchanged',
    },
    'composeProject': 'orv14-vfy-20261011-a1',
    'sourceScope': 'DocCore and linked package source snapshot pinned by dependency-inputs-before.sha256; contracts source/dist manifests copied to this attempt',
}
(raw / 'run-context.json').write_text(json.dumps(context, indent=2) + '\n')
(raw / 'command.txt').write_text(
    'UTC start: ' + started + '\n'
    'CWD: ' + str(repo) + '\n'
    'Pinned Node: ' + str(node) + '\n'
    'Command: ' + ' '.join(command) + '\n'
    'Environment: WFA_DATABASE_URL=postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy; '
    'WFA_REDIS_URL=redis://127.0.0.1:26414/2; NODE_PATH=' + env['NODE_PATH'] + '; NODE_EXTRA_CA_CERTS=' + env['NODE_EXTRA_CA_CERTS'] + '; '
    'ORV14_WORKER_E2E_RAW_DIR=' + str(raw) + '\n'
    'Proxy environment inherited unchanged. No dependency install or shared build.\n'
)
with (raw / 'jest-stdout.txt').open('wb') as stdout, (raw / 'jest-stderr.txt').open('wb') as stderr:
    result = subprocess.run(command, cwd=repo, env=env, stdout=stdout, stderr=stderr, check=False)
finished = datetime.now(timezone.utc).isoformat()
(raw / 'exit-code.txt').write_text(str(result.returncode) + '\n')
(raw / 'run-times.txt').write_text(f'startedAtUtc={started}\nfinishedAtUtc={finished}\nexitCode={result.returncode}\n')
print(f'Jest finished: exit={result.returncode}; started={started}; finished={finished}')

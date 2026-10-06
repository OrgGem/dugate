"""Read-only Compose checks using an empty env file and synthetic values."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
env = dict(os.environ)
for key in [
    'DATABASE_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
    'ORCHESTRATOR_PORT', 'CONNECTOR_PORT', 'SERVICE_IDENTITY_SECRET',
    'INVOCATION_GRANT_SECRET', 'CONNECTOR_ENCRYPTION_KEY', 'AUTO_MIGRATE',
]:
    env.pop(key, None)
env.update({
    'RUNTIME_TOKEN': 'review-runtime-placeholder',
    'ADMIN_TOKEN': 'review-admin-placeholder',
    'RUNTIME_URL': 'http://orchestrator:3000/api/runtime/v1',
    'CONNECTOR_URL': 'http://connector:8080',
    'CONNECTOR_SERVICE_TOKEN': 'review-service-placeholder',
    'REDIS_URL': 'redis://valkey:6379',
})
files = [
    'docker-compose.yml',
    'services/orchestrator/docker-compose.yml',
    'services/connector/docker-compose.yml',
    'businesses/document-core/docker-compose.yml',
    'businesses/lc-checker/docker-compose.yml',
    'businesses/example-review/docker-compose.yml',
    'infra/docker-compose.yml',
    'infra/docker-compose.live.yml',
]
results = []
with tempfile.NamedTemporaryFile(mode='w', suffix='.env', delete=False) as handle:
    empty_env = handle.name
for file in files:
    command = ['docker', 'compose', '--env-file', empty_env, '-f', file, 'config', '-q']
    result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
    results.append({'file': file, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
for file, service, key, port in [
    ('services/orchestrator/docker-compose.yml', 'orchestrator', 'ORCHESTRATOR_PORT', '3100'),
    ('services/connector/docker-compose.yml', 'connector', 'CONNECTOR_PORT', '8188'),
]:
    command = ['docker', 'compose', '--env-file', empty_env, '-f', file, 'config', '--format', 'json']
    result = subprocess.run(command, cwd=root, env={**env, key: port}, capture_output=True, text=True)
    if result.returncode == 0:
        data = json.loads(result.stdout)['services'][service]
        results.append({'file': file, 'override': {key: port}, 'exit': 0,
                        'processPort': data['environment']['PORT'], 'publishedPorts': data['ports'],
                        'healthcheck': data['healthcheck']['test']})
    else:
        results.append({'file': file, 'override': key, 'exit': result.returncode, 'stderr': result.stderr})
output = json.dumps(results, indent=2)
(root / 'coordination/reports/build-deploy-review-2026-10-05-compose-results.json').write_text(output, encoding='utf-8')
print(output)

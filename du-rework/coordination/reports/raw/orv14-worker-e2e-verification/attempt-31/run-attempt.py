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
raw = repo / 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-31'
node = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node'
jest = str(repo / 'businesses/document-core/node_modules/jest/bin/jest.js')
redis_container = 'orv14-vfy-20261011-a1-redis-1'
postgres_container = 'orv14-vfy-20261011-a1-postgres-1'
command = [node, jest, '--config', 'tests/workflow-api/jest.config.cjs', '--runInBand',
           '--runTestsByPath', 'tests/workflow-api/http-worker.integration.test.ts']
contracts_source = raw / 'contracts-source-2026-10-12T050015Z.sha256'
contracts_dist = raw / 'contracts-dist-2026-10-12T050015Z.sha256'

source_paths = {
    'workerE2ETest': 'tests/workflow-api/http-worker.integration.test.ts',
    'workflowApiIsolation': 'tests/workflow-api/isolation.ts',
    'testIsolationNamespace': 'tests/isolation/namespace.ts',
    'privateHttpsFixture': 'tests/workflow-api/orv14-vfy-worker/private-https-fixture.ts',
    'privateHttpsRunnerTrustBundle': 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem',
    'ownedMinioHelper': 'tests/workflow-api/orv14-vfy-worker/owned-minio.ts',
    'orchestratorCreateApp': 'orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts',
    'orchestratorServer': 'orchestrator/services/orchestrator/src/server.ts',
    'orchestratorPublicArtifactRoute': 'orchestrator/services/orchestrator/src/http/routes/public.ts',
    'orchestratorArtifactReadDecrypt': 'orchestrator/services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts',
    'orchestratorRuntimeControlRoute': 'orchestrator/services/orchestrator/src/http/routes/internal-service-runtime.ts',
    'orchestratorPublicRuntimeRoute': 'orchestrator/services/orchestrator/src/http/routes/runtime.ts',
    'orchestratorSubmission': 'orchestrator/services/orchestrator/src/modules/operations/submission.ts',
    'orchestratorWorkflowRecipePins': 'orchestrator/services/orchestrator/src/modules/global-settings/workflow-recipe-pins.ts',
    'orchestratorRecipeCompiler': 'orchestrator/services/orchestrator/src/modules/connectors/recipe-compiler.ts',
    'orchestratorWorkflowSchemaCatalog': 'orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas.ts',
    'orchestratorOrdinaryGrants': 'orchestrator/services/orchestrator/src/modules/grants/grants.ts',
    'orchestratorCostContext': 'orchestrator/services/orchestrator/src/modules/cost-control/cost-context.ts',
    'orchestratorSecretCatalogStore': 'orchestrator/services/orchestrator/src/modules/secrets/secret-catalog-store.ts',
    'orchestratorCostControlService': 'orchestrator/services/orchestrator/src/modules/cost-control/service.ts',
    'connectorComposition': 'orchestrator/services/connector/src/composition.ts',
    'connectorEntrypoint': 'orchestrator/services/connector/src/entrypoint.ts',
    'connectorRuntimeControlEnvironment': 'orchestrator/services/connector/src/runtime-control-environment.ts',
    'connectorGrants': 'orchestrator/services/connector/src/grants.ts',
    'connectorInvocationServices': 'orchestrator/services/connector/src/services.ts',
    'connectorInvocationRepository': 'orchestrator/services/connector/src/db/repository.ts',
    'connectorRuntimeControls': 'orchestrator/services/connector/src/db/replica-runtime-controls.ts',
    'connectorHttpServer': 'orchestrator/services/connector/src/http/server.ts',
    'connectorCostControlClient': 'orchestrator/services/connector/src/cost-control-client.ts',
    'connectorRecipeAdapter': 'orchestrator/services/connector/src/adapters/recipe.ts',
    'documentCoreWorker': 'businesses/document-core/src/worker.ts',
    'documentCoreMain': 'businesses/document-core/src/main.ts',
    'documentCoreLegacyWorkflowRuntime': 'businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts',
    'documentCoreManifest': 'businesses/document-core/src/manifest/document-core.manifest.ts',
    'lcCheckerWorker': 'businesses/lc-checker/src/worker.ts',
    'lcCheckerManifest': 'businesses/lc-checker/src/manifest.ts',
    'workerSdkTaskContextSource': 'orchestrator/packages/worker-sdk/src/task-context.ts',
    'workerSdkTaskContextDist': 'orchestrator/packages/worker-sdk/dist/task-context.js',
    'workerSdkTaskContextTypesDist': 'orchestrator/packages/worker-sdk/dist/task-context.d.ts',
    'workerSdkIndexDist': 'orchestrator/packages/worker-sdk/dist/index.js',
    'workerSdkIndexTypesDist': 'orchestrator/packages/worker-sdk/dist/index.d.ts',
    'observabilitySource': 'orchestrator/packages/observability/src/log-metadata.ts',
    'observabilityDist': 'orchestrator/packages/observability/dist/log-metadata.js',
    'contractsConnectorSource': 'orchestrator/packages/contracts/src/connector.ts',
    'contractsIndexSource': 'orchestrator/packages/contracts/src/index.ts',
    'contractsLegacyWorkflowSource': 'orchestrator/packages/contracts/src/legacy-workflow.ts',
    'contractsWorkflowImportSource': 'orchestrator/packages/contracts/src/workflow-import.ts',
    'contractsConnectorDist': 'orchestrator/packages/contracts/dist/connector.js',
    'contractsLegacyWorkflowDist': 'orchestrator/packages/contracts/dist/legacy-workflow.js',
    'contractsWorkflowImportDist': 'orchestrator/packages/contracts/dist/workflow-import.js',
    'contractsIndexDist': 'orchestrator/packages/contracts/dist/index.js',
    'connectorRuntimeBootAckMigration': 'orchestrator/services/connector/src/db/migrations/016_replica_runtime_boot_ack.sql',
    'connectorBackupFenceMigration': 'orchestrator/services/connector/src/db/migrations/015_backup_effect_fences.sql',
}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def write_dependency_snapshot(label):
    previous = raw.parent / 'attempt-29/dependency-inputs-before.sha256'
    relative_paths = {line.strip().split('  ', 1)[1] for line in previous.read_text().splitlines() if '  ' in line}
    relative_paths.update({
        'tests/workflow-api/http-worker.integration.test.ts',
        'orchestrator/services/connector/src/runtime-control-environment.ts',
    })
    lines = []
    missing = []
    for relative in sorted(relative_paths):
        path = repo / relative
        if path.is_file():
            lines.append(f'{sha256_file(path)}  {relative}\n')
        else:
            missing.append(relative)
    manifest_text = ''.join(lines)
    (raw / f'dependency-inputs-{label}.sha256').write_text(manifest_text)
    (raw / f'dependency-inputs-{label}.sha256.missing').write_text(''.join(f'{path}\n' for path in missing))
    return {
        'path': f'dependency-inputs-{label}.sha256',
        'sha256': hashlib.sha256(manifest_text.encode()).hexdigest(),
        'files': len(lines),
        'missing': missing,
    }


def source_pins():
    return {name: sha256_file(repo / relative) for name, relative in source_paths.items()}


def verify_manifest(path, root):
    rows = path.read_text().splitlines()
    mismatches = []
    for row in rows:
        expected, relative = row.split('  ', 1)
        target = root / relative
        actual = sha256_file(target) if target.is_file() else None
        if actual != expected:
            mismatches.append({'path': relative, 'expected': expected, 'actual': actual})
    return {
        'path': str(path.relative_to(repo)),
        'aggregateSha256': sha256_file(path),
        'entries': len(rows),
        'mismatches': mismatches,
    }


def redis_command(*args):
    return subprocess.run(
        ['docker', 'exec', redis_container, 'redis-cli', '-n', '8', *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def read_postgres_config():
    result = subprocess.run(['docker', 'inspect', postgres_container], check=True, capture_output=True, text=True)
    config = json.loads(result.stdout)[0]
    variables = dict(item.split('=', 1) for item in config.get('Config', {}).get('Env', []) if '=' in item)
    password = variables.get('POSTGRES_PASSWORD')
    if not password:
        raise RuntimeError('Synthetic PostgreSQL container has no configured password')
    user = variables.get('POSTGRES_USER', 'orv14_vfy')
    database = variables.get('POSTGRES_DB', 'orv14_vfy')
    url = 'postgresql://{}:{}@127.0.0.1:25414/{}'.format(
        urllib.parse.quote(user, safe=''), urllib.parse.quote(password, safe=''),
        urllib.parse.quote(database, safe=''))
    return url, password, user, database


def prepare():
    if not raw.is_dir():
        raise RuntimeError('Attempt-30 raw directory is missing')
    if subprocess.run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip() != 'v24.21.0':
        raise RuntimeError('Attempt-30 requires the pinned Node 24.21.0 binary')
    node_version = subprocess.run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip()
    node_sha = sha256_file(node)
    jest_sha = sha256_file(jest)
    source_before = source_pins()
    dependency_before = write_dependency_snapshot('before')
    contracts_source_snapshot = verify_manifest(contracts_source, orchestrator)
    contracts_dist_snapshot = verify_manifest(contracts_dist, orchestrator)
    if dependency_before['missing']:
        raise RuntimeError('Dependency manifest contains missing input files')
    if contracts_source_snapshot['aggregateSha256'] != '7a7fee71282164f812d5875291b68f70c6a22af199339b0d44ca79c238cd477c' or contracts_source_snapshot['entries'] != 46 or contracts_source_snapshot['mismatches']:
        raise RuntimeError('Current contracts source differs from the post-restore-observation source46 snapshot')
    if contracts_dist_snapshot['aggregateSha256'] != 'c381966b1947e5e075dfa822bc798a23a7a4fa7920be5dbaea387a297a40d349' or contracts_dist_snapshot['entries'] != 184 or contracts_dist_snapshot['mismatches']:
        raise RuntimeError('Current contracts dist differs from the post-restore-observation dist184 snapshot')
    if source_before['connectorEntrypoint'] != '75ce40e4c1bd21520c8546b355eed41ddccade8f5d5e276ff292c37bf438b7ee' or source_before['connectorRuntimeControlEnvironment'] != '8cba31e94429323f59499ca007a01e97b07d3ffa2367c97fca0c3a37fec5af8e':
        raise RuntimeError('Connector boot identity source does not match Host frozen checkpoint')
    if source_before['orchestratorCreateApp'] != '16aaf9a89daf8b35016dcd1709978d450241c8d289e6caf66513621a6df15736' or source_before['orchestratorOrdinaryGrants'] != '9f5108d99f0bb59105ba71bc752ff6014a69fe9f1c6babc149e7e861dd3f5f62':
        raise RuntimeError('Orchestrator WFA source does not match Backend frozen checkpoint')
    redis_pre = int(redis_command('DBSIZE'))
    if redis_pre != 0:
        raise RuntimeError(f'Reserved Redis DB8 was not empty before run: {redis_pre}')
    redis_info = redis_command('INFO', 'keyspace')
    if redis_info and 'db8:' in redis_info:
        raise RuntimeError('Redis INFO reports a nonempty DB8 keyspace despite the DB size preflight')
    db_url, password, user, database = read_postgres_config()
    images = {
        'postgresImageId': subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', postgres_container], check=True, capture_output=True, text=True).stdout.strip(),
        'redisImageId': subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', redis_container], check=True, capture_output=True, text=True).stdout.strip(),
    }
    context = {
        'attempt': '31',
        'preparedAtUtc': utc_now(),
        'cwd': str(repo),
        'node': node,
        'nodeVersion': node_version,
        'nodeBinarySha256': node_sha,
        'jestEntry': jest,
        'jestEntrySha256': jest_sha,
        'command': command,
        'testSourceSha256': source_before['workerE2ETest'],
        'sourcePinsBefore': source_before,
        'dependencyInputsBefore': dependency_before,
        'contractsSourceManifest': contracts_source_snapshot,
        'contractsDistManifest': contracts_dist_snapshot,
        'composeProject': 'orv14-vfy-20261011-a1',
        'composeImages': images,
        'namespaceLease': {
            'postgres': 'synthetic Compose host port 25414; per-run Orchestrator and Connector schemas created by the test',
            'redis': {'host': '127.0.0.1', 'port': '26414', 'database': 8, 'preRunDbSize': redis_pre, 'preRunInfoKeyspace': redis_info or 'empty'},
            'rawDirectory': str(raw),
            'provider': 'in-process TLS listener on RFC1918 loopback-interface address with fixture SAN and runner CA',
        },
        'testScope': 'full 15-case WFA real HTTP admission, PG outbox, Redis worker, typed immutable Connector workflow, private HTTPS provider, HITL/result, authorization, recovery/cancel, encrypted artifact upload/download suite',
        'workerExecutionMode': 'Jest/ts-jest imports Document Core and LC Checker source; Worker SDK and contracts resolve through current package dist outputs. This run is not a compiled Document Core dist consumer run.',
        'environment': {
            'WFA_DATABASE_URL': f'postgresql://{user}:<synthetic Compose password omitted>@127.0.0.1:25414/{database}',
            'WFA_REDIS_URL': 'redis://127.0.0.1:26414/8',
            'ORV14_WORKER_E2E_REDIS_DB': '8',
            'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
            'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
            'ORV14_WORKER_E2E_RAW_DIR': str(raw),
            'HTTP_PROXY/HTTPS_PROXY/NO_PROXY': 'inherited unchanged',
        },
    }
    (raw / 'run-context.json').write_text(json.dumps(context, indent=2) + '\n')
    (raw / 'command.txt').write_text(
        f'CWD: {repo}\nNode: {node} ({node_version}); binary SHA-256 {node_sha}\n'
        + 'Command: ' + ' '.join(command) + '\n'
        + 'Environment: WFA_DATABASE_URL=postgresql://orv14_vfy:<synthetic Compose password omitted>@127.0.0.1:25414/orv14_vfy; '
        + 'WFA_REDIS_URL=redis://127.0.0.1:26414/8; ORV14_WORKER_E2E_REDIS_DB=8; '
        + f'NODE_PATH={repo / "businesses/document-core/node_modules"}; '
        + f'NODE_EXTRA_CA_CERTS={repo / "tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem"}; '
        + f'ORV14_WORKER_E2E_RAW_DIR={raw}; proxy environment inherited unchanged\n'
        + f'Pre-run DB8 size={redis_pre}; contract source/dist manifest aggregates={contracts_source_snapshot["aggregateSha256"]}/{contracts_dist_snapshot["aggregateSha256"]}\n'
    )
    print(json.dumps({
        'preparedAtUtc': context['preparedAtUtc'],
        'nodeVersion': node_version,
        'dependencyFiles': dependency_before['files'],
        'dependencyManifestSha256': dependency_before['sha256'],
        'testSourceSha256': source_before['workerE2ETest'],
        'contractsSourceDist': [contracts_source_snapshot['aggregateSha256'], contracts_dist_snapshot['aggregateSha256']],
        'redisDb8Preflight': redis_pre,
        'namespace': 'attempt-31, no database/password values emitted',
    }, sort_keys=True))
    return db_url, password, user, database


def run():
    context_path = raw / 'run-context.json'
    context = json.loads(context_path.read_text())
    source_before = context['sourcePinsBefore']
    dependency_before = context['dependencyInputsBefore']
    dependency_pre_path = raw / dependency_before['path']
    live_pre_hash = sha256_file(dependency_pre_path)
    if live_pre_hash != dependency_before['sha256']:
        raise RuntimeError('Prepared source manifest changed before test launch')
    db_url, password, user, database = read_postgres_config()
    env = os.environ.copy()
    env.update({
        'WFA_DATABASE_URL': db_url,
        'WFA_REDIS_URL': 'redis://127.0.0.1:26414/8',
        'ORV14_WORKER_E2E_REDIS_DB': '8',
        'NODE_PATH': str(repo / 'businesses/document-core/node_modules'),
        'NODE_EXTRA_CA_CERTS': str(repo / 'tests/workflow-api/orv14-vfy-worker/https-fixture/runner-trust-bundle.pem'),
        'ORV14_WORKER_E2E_RAW_DIR': str(raw),
    })
    start = utc_now()
    context['startedAtUtc'] = start
    context['startMarker'] = 'full WFA15 Jest command launched after empty DB8 and exact source/contract preflight'
    context['postgresPasswordExposure'] = 'loaded from the owned synthetic Compose container into child env; omitted from all saved fields and stdout'
    context_path.write_text(json.dumps(context, indent=2) + '\n')
    print(json.dumps({'startedAtUtc': start, 'attempt': '31', 'test': 'full WFA15', 'rawDirectory': str(raw), 'redisDb8': 'reserved exclusive lease'}), flush=True)
    completed = subprocess.run(command, cwd=repo, env=env, capture_output=True, check=False)
    stdout = completed.stdout.replace(password.encode(), b'<synthetic-password-redacted>')
    stderr = completed.stderr.replace(password.encode(), b'<synthetic-password-redacted>')
    postgres_url = env['WFA_DATABASE_URL'].encode()
    stdout = stdout.replace(postgres_url, b'postgresql://orv14_vfy:<synthetic-password-redacted>@127.0.0.1:25414/orv14_vfy')
    stderr = stderr.replace(postgres_url, b'postgresql://orv14_vfy:<synthetic-password-redacted>@127.0.0.1:25414/orv14_vfy')
    (raw / 'jest-stdout.txt').write_bytes(stdout)
    (raw / 'jest-stderr.txt').write_bytes(stderr)
    finish = utc_now()
    (raw / 'exit-code.txt').write_text(f'{completed.returncode}\n')
    (raw / 'run-times.txt').write_text(f'startedAtUtc={start}\nfinishedAtUtc={finish}\nexitCode={completed.returncode}\n')

    namespace_path = raw / 'namespace.json'
    namespace = json.loads(namespace_path.read_text()) if namespace_path.is_file() else None
    redis_before_cleanup = {'patterns': {}, 'totalDbSize': int(redis_command('DBSIZE'))}
    owned_patterns = []
    if namespace:
        owned_patterns.extend([
            f'{namespace["redis"]["connectorQuotaKeyPrefix"]}*',
            f'{namespace["redis"]["keyPrefix"]}*',
        ])
        owned_patterns.extend(f'bull:{name}:*' for name in namespace['redis']['businessQueueNames'])
    owned_keys = set()
    for pattern in owned_patterns:
        keys = redis_command('--scan', '--pattern', pattern).splitlines()
        redis_before_cleanup['patterns'][pattern] = len(keys)
        owned_keys.update(keys)
    (raw / 'redis-owned-keys-before-cleanup.txt').write_text(''.join(f'{key}\n' for key in sorted(owned_keys)))
    removed = []
    key_list = sorted(owned_keys)
    for offset in range(0, len(key_list), 100):
        chunk = key_list[offset:offset + 100]
        if chunk:
            result = redis_command('UNLINK', *chunk)
            removed.append({'requested': len(chunk), 'reply': result})
    redis_after_cleanup = {'patterns': {}, 'totalDbSize': int(redis_command('DBSIZE'))}
    for pattern in owned_patterns:
        redis_after_cleanup['patterns'][pattern] = len(redis_command('--scan', '--pattern', pattern).splitlines())
    redis_cleanup = {
        'preRunDbSize': 0,
        'beforeCleanup': redis_before_cleanup,
        'ownedKeyCount': len(owned_keys),
        'unlinkCalls': removed,
        'afterCleanup': redis_after_cleanup,
        'ownedPatternsClear': all(value == 0 for value in redis_after_cleanup['patterns'].values()),
    }
    (raw / 'redis-cleanup.json').write_text(json.dumps(redis_cleanup, indent=2) + '\n')

    schema_cleanup = {'checked': False, 'remainingOwnedSchemas': None}
    if namespace:
        schema_names = [namespace['postgresSchema'], namespace['connectorPostgresSchema']]
        sql_names = ','.join("'" + name.replace("'", "''") + "'" for name in schema_names)
        psql = subprocess.run(
            ['docker', 'exec', postgres_container, 'psql', '-U', user, '-d', database, '-At', '-c',
             f"SELECT nspname FROM pg_namespace WHERE nspname IN ({sql_names}) ORDER BY nspname"],
            capture_output=True, text=True, check=False,
        )
        schema_cleanup = {
            'checked': psql.returncode == 0,
            'exitCode': psql.returncode,
            'remainingOwnedSchemas': psql.stdout.splitlines() if psql.returncode == 0 else [],
            'safeError': psql.stderr.strip()[:500] if psql.returncode else '',
        }
    artifact_cleanup = {}
    if namespace:
        for name in ['artifactDirectory', 'connectorArtifactDirectory']:
            path = (repo / namespace[name]).resolve()
            allowed_roots = [(repo / 'tests/workflow-api/.scratch/artifacts').resolve(),
                             (repo / 'tests/workflow-api/.scratch/connector-artifacts').resolve()]
            if not any(path == root or root in path.parents for root in allowed_roots):
                artifact_cleanup[name] = {'path': str(path), 'removed': False, 'error': 'outside owned artifact roots'}
                continue
            existed = path.exists()
            if existed:
                import shutil
                shutil.rmtree(path)
            artifact_cleanup[name] = {'path': str(path.relative_to(repo)), 'existedAfterTest': existed, 'removed': existed, 'existsAfterCleanup': path.exists()}
    (raw / 'resource-cleanup.json').write_text(json.dumps({
        'postgresOwnedSchemas': schema_cleanup,
        'artifactDirectories': artifact_cleanup,
        'redis': redis_cleanup,
        'historicalOtherPublicFootprint': 'not inspected or modified by this attempt',
    }, indent=2) + '\n')

    source_after = source_pins()
    dependency_after = write_dependency_snapshot('after')
    before_map = {line.split('  ', 1)[1]: line.split('  ', 1)[0] for line in dependency_pre_path.read_text().splitlines()}
    after_path = raw / dependency_after['path']
    after_map = {line.split('  ', 1)[1]: line.split('  ', 1)[0] for line in after_path.read_text().splitlines()}
    changed = [{'path': path, 'before': before_map.get(path), 'after': after_map.get(path)}
               for path in sorted(before_map.keys() | after_map.keys()) if before_map.get(path) != after_map.get(path)]
    delta = {
        'sourcePinsBefore': source_before,
        'sourcePinsAfter': source_after,
        'dependencyInputsBefore': dependency_before,
        'dependencyInputsAfter': dependency_after,
        'changedInputs': changed,
        'contractsSourceManifestSha256': context['contractsSourceManifest']['aggregateSha256'],
        'contractsDistManifestSha256': context['contractsDistManifest']['aggregateSha256'],
        'redisCleanup': redis_cleanup,
        'resourceCleanupFile': 'resource-cleanup.json',
    }
    (raw / 'source-delta-summary.json').write_text(json.dumps(delta, indent=2) + '\n')
    context['finishedAtUtc'] = finish
    context['exitCode'] = completed.returncode
    context['sourcePinsAfter'] = source_after
    context['dependencyInputsAfter'] = dependency_after
    context_path.write_text(json.dumps(context, indent=2) + '\n')
    print(json.dumps({
        'finishedAtUtc': finish,
        'exitCode': completed.returncode,
        'dependencyManifestBeforeAfter': [dependency_before['sha256'], dependency_after['sha256']],
        'changedInputs': len(changed),
        'ownedRedisKeys': len(owned_keys),
        'ownedRedisPatternsClear': redis_cleanup['ownedPatternsClear'],
        'redisDb8Remaining': redis_cleanup['afterCleanup']['totalDbSize'],
        'postgresOwnedSchemasRemaining': schema_cleanup.get('remainingOwnedSchemas'),
        'rawDirectory': str(raw),
    }, sort_keys=True))
    sys.exit(completed.returncode)


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in {'--prepare', '--run'}:
        raise SystemExit('Usage: run-attempt.py --prepare|--run')
    if sys.argv[1] == '--prepare':
        prepare()
    else:
        run()

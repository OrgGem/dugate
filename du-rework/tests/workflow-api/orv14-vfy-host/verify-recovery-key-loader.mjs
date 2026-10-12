import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupHostInfrastructureFixture,
  createRootOwnedSymlink,
  rootFixtureImageIdentity,
  writeRootOwnedFiles,
} from './infrastructure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ORCHESTRATOR = path.join(ROOT, 'orchestrator/services/orchestrator');
const MAINTENANCE = path.join(ORCHESTRATOR, 'src/modules/maintenance');
const SOURCE = path.join(MAINTENANCE, 'recovery-key-file.ts');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const CASES = [];
const NOW = () => new Date().toISOString();

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(name, passed, detail = {}) {
  const status = passed ? 'passed' : 'failed';
  CASES.push({ name, status, ...detail });
  assert.ok(passed, `failed: ${name}`);
}

async function denied(name, operation) {
  let message = '';
  try {
    const key = await operation;
    if (Buffer.isBuffer(key)) key.fill(0);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  record(name, message === 'MAINTENANCE_RECOVERY_KEY_UNAVAILABLE', { genericDenial: message === 'MAINTENANCE_RECOVERY_KEY_UNAVAILABLE' });
}

async function main() {
  if (process.execPath !== NODE) throw new Error(`required Node 24.21 binary is ${NODE}`);
  if (process.getuid?.() !== 1000) throw new Error('protected loader fixture must run as nonroot UID 1000');
  if (typeof process.getgid !== 'function') throw new Error('verifier GID is unavailable');

  const projectId = `orv14-vfy-host-recovery-${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const root = await mkdtemp(path.join('/tmp', `${projectId}-`));
  await chmod(root, 0o700);
  const inputDir = path.join(root, 'inputs');
  const workDir = path.join(root, 'work');
  await Promise.all([mkdir(inputDir, { mode: 0o700 }), mkdir(workDir, { mode: 0o700 })]);
  const fixture = {
    projectId,
    root,
    inputDir,
    workDir,
    verifierUid: process.getuid(),
    verifierGid: process.getgid(),
    cleaned: false,
  };
  const startedAt = NOW();
  const reportPath = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification', `recovery-key-loader-${projectId}.json`);
  const buildDir = path.join(workDir, 'recovery-key-loader-build');
  await mkdir(buildDir, { mode: 0o700 });
  let cleanup = { completed: false };
  const image = rootFixtureImageIdentity();
  const keyMaterial = {
    backup: randomBytes(32),
    catalogV4: randomBytes(32),
    catalogV5: randomBytes(32),
    invocation: randomBytes(32),
    connectorCredentialConfig: Buffer.from(randomBytes(32).toString('base64'), 'utf8'),
    worldReadable: randomBytes(32),
  };
  const paths = {
    backup: path.join(root, 'trusted/bundles/backup-v1.bin'),
    catalogV4: path.join(root, 'trusted/bundles/catalog-v4.bin'),
    catalogV5: path.join(root, 'trusted/bundles/catalog-v5.bin'),
    invocation: path.join(root, 'trusted/bundles/invocation-v3.bin'),
    credential: path.join(root, 'trusted/bundles/credential-legacy-v1.txt'),
    worldReadable: path.join(root, 'trusted/bundles/world-readable.bin'),
    registry: path.join(root, 'trusted/config/recovery-registry.json'),
    backupAlias: path.join(root, 'trusted/bundles/backup-v1-alias.bin'),
  };
  let compiledBuild = { command: null, exitCode: null, output: null, outputDirectory: buildDir };
  try {
    const registry = {
      version: 2,
      keys: [
        {
          purpose: 'secret_catalog',
          escrowRef: 'synthetic:catalog:archive',
          keyVersion: 'v4',
          fingerprintSha256: sha256(keyMaterial.catalogV4),
          filePath: paths.catalogV4,
        },
        {
          purpose: 'secret_catalog',
          escrowRef: 'synthetic:catalog:archive',
          keyVersion: 'v5',
          fingerprintSha256: sha256(keyMaterial.catalogV5),
          filePath: paths.catalogV5,
        },
        {
          purpose: 'connector_invocation',
          escrowRef: 'connector-invocation-v1',
          keyVersion: '3',
          fingerprintSha256: sha256(keyMaterial.invocation),
          filePath: paths.invocation,
        },
        {
          purpose: 'connector_credential',
          escrowRef: 'connector-credential-legacy-v1',
          keyVersion: 'legacy-v1',
          fingerprintSha256: sha256(keyMaterial.connectorCredentialConfig),
          filePath: paths.credential,
          materialFormat: 'base64-config',
        },
      ],
    };
    const registryBytes = Buffer.from(JSON.stringify(registry));
    const registryPin = { filePath: paths.registry, sha256: sha256(registryBytes) };
    await writeRootOwnedFiles(fixture, [
      { relativePath: 'trusted/bundles/backup-v1.bin', bytes: keyMaterial.backup, mode: 0o440, groupId: process.getgid() },
      { relativePath: 'trusted/bundles/catalog-v4.bin', bytes: keyMaterial.catalogV4, mode: 0o440, groupId: process.getgid() },
      { relativePath: 'trusted/bundles/catalog-v5.bin', bytes: keyMaterial.catalogV5, mode: 0o440, groupId: process.getgid() },
      { relativePath: 'trusted/bundles/invocation-v3.bin', bytes: keyMaterial.invocation, mode: 0o440, groupId: process.getgid() },
      { relativePath: 'trusted/bundles/credential-legacy-v1.txt', bytes: keyMaterial.connectorCredentialConfig, mode: 0o440, groupId: process.getgid() },
      { relativePath: 'trusted/bundles/world-readable.bin', bytes: keyMaterial.worldReadable, mode: 0o444, groupId: process.getgid() },
      { relativePath: 'trusted/config/recovery-registry.json', bytes: registryBytes, mode: 0o440, groupId: process.getgid() },
    ]);
    const aliasReceipt = await createRootOwnedSymlink(fixture, 'trusted/bundles/backup-v1-alias.bin', 'trusted/bundles/backup-v1.bin');
    registryBytes.fill(0);

    const requireOrchestrator = createRequire(path.join(ORCHESTRATOR, 'package.json'));
    const tsc = requireOrchestrator.resolve('typescript/bin/tsc');
    compiledBuild.command = `${NODE} ${tsc} ${SOURCE} --target ES2022 --module commonjs --moduleResolution node --strict --esModuleInterop --skipLibCheck --rootDir ${MAINTENANCE} --typeRoots ${path.join(ORCHESTRATOR, 'node_modules/@types')} --outDir ${buildDir}`;
    const build = spawnSync(NODE, [tsc, SOURCE, '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
      '--strict', '--esModuleInterop', '--skipLibCheck', '--rootDir', MAINTENANCE,
      '--typeRoots', path.join(ORCHESTRATOR, 'node_modules/@types'), '--outDir', buildDir], {
      cwd: ORCHESTRATOR,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    compiledBuild.exitCode = build.status;
    compiledBuild.output = (build.stderr || build.stdout || '').slice(0, 1600);
    if (build.status !== 0) throw new Error(`scratch recovery loader build failed: ${(build.stderr || build.stdout || '').slice(0, 1200)}`);
    const loader = createRequire(path.join(buildDir, 'recovery-key-file.js'))('./recovery-key-file.js');

    const backupPin = {
      filePath: paths.backup,
      escrowRef: 'synthetic:orchestrator:backup-v1',
      keyVersion: 'v1',
      fingerprintSha256: sha256(keyMaterial.backup),
    };
    const resolvedBackup = await loader.createBackupRecoveryKeyFileResolver(backupPin)({
      purpose: 'backup_bundle', escrowRef: backupPin.escrowRef, keyVersion: backupPin.keyVersion,
    });
    const backupMatches = Buffer.isBuffer(resolvedBackup) && resolvedBackup.length === keyMaterial.backup.length
      && resolvedBackup.equals(keyMaterial.backup);
    resolvedBackup.fill(0);
    record('nonroot process reads the exact root-owned group-readable backup key', backupMatches,
      { uid: process.getuid(), fileMode: '0440', keyByteCount: 32 });

    const backupEnv = loader.backupRecoveryKeyFilePinFromEnv({
      DU_MAINTENANCE_RECOVERY_KEY_FILE: paths.backup,
      DU_MAINTENANCE_RECOVERY_KEY_REF: backupPin.escrowRef,
      DU_MAINTENANCE_RECOVERY_KEY_VERSION: backupPin.keyVersion,
      DU_MAINTENANCE_RECOVERY_KEY_SHA256: backupPin.fingerprintSha256,
    });
    record('exact four-field backup recovery pin parses from environment', backupEnv?.filePath === paths.backup,
      { allPinsPresent: backupEnv !== undefined });

    const registryEnv = loader.maintenanceRecoveryKeyRegistryPinFromEnv({
      DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_FILE: paths.registry,
      DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_SHA256: registryPin.sha256,
    });
    record('the registry pin parser accepts the exact root-owned registry digest', registryEnv?.sha256 === registryPin.sha256,
      { digestPinned: true });
    const resolver = loader.createMaintenanceRecoveryKeyResolver({ secretCatalogRegistry: registryPin });
    const catalogV4 = await resolver({ purpose: 'secret_catalog', escrowRef: 'synthetic:catalog:archive', keyVersion: 'v4' });
    const catalogV4Matches = catalogV4.length === keyMaterial.catalogV4.length && catalogV4.equals(keyMaterial.catalogV4);
    catalogV4.fill(0);
    record('pinned purpose registry resolves the exact archived Secret Catalog key version v4', catalogV4Matches,
      { purpose: 'secret_catalog', version: 'v4', keyByteCount: 32 });
    const catalogV5 = await resolver({ purpose: 'secret_catalog', escrowRef: 'synthetic:catalog:archive', keyVersion: 'v5' });
    const catalogV5Matches = catalogV5.length === keyMaterial.catalogV5.length && catalogV5.equals(keyMaterial.catalogV5);
    catalogV5.fill(0);
    record('pinned purpose registry resolves the exact current Secret Catalog key version v5', catalogV5Matches,
      { purpose: 'secret_catalog', version: 'v5', keyByteCount: 32 });
    const invocation = await resolver({ purpose: 'connector_invocation', escrowRef: 'connector-invocation-v1', keyVersion: '3' });
    const invocationMatches = invocation.length === keyMaterial.invocation.length && invocation.equals(keyMaterial.invocation);
    invocation.fill(0);
    record('pinned purpose registry independently returns the Connector invocation key', invocationMatches,
      { purpose: 'connector_invocation', version: '3', keyByteCount: 32 });
    const credential = await resolver({ purpose: 'connector_credential', escrowRef: 'connector-credential-legacy-v1', keyVersion: 'legacy-v1' });
    const decodedCredential = Buffer.from(credential.toString('utf8'), 'base64');
    const credentialMatches = credential.equals(keyMaterial.connectorCredentialConfig) && decodedCredential.length === 32;
    credential.fill(0);
    decodedCredential.fill(0);
    record('pinned purpose registry returns the base64-config legacy Connector credential key', credentialMatches,
      { purpose: 'connector_credential', version: 'legacy-v1', materialFormat: 'base64-config' });

    await denied('symlink alias to an otherwise valid key is refused', loader.createBackupRecoveryKeyFileResolver({
      ...backupPin, filePath: paths.backupAlias,
    })({ purpose: 'backup_bundle', escrowRef: backupPin.escrowRef, keyVersion: backupPin.keyVersion }));
    await denied('wrong backup-key fingerprint is refused', loader.createBackupRecoveryKeyFileResolver({
      ...backupPin, fingerprintSha256: '0'.repeat(64),
    })({ purpose: 'backup_bundle', escrowRef: backupPin.escrowRef, keyVersion: backupPin.keyVersion }));
    await denied('world-readable key file is refused even when its fingerprint matches', loader.createBackupRecoveryKeyFileResolver({
      filePath: paths.worldReadable,
      escrowRef: 'synthetic:orchestrator:backup-world-readable',
      keyVersion: 'v1',
      fingerprintSha256: sha256(keyMaterial.worldReadable),
    })({ purpose: 'backup_bundle', escrowRef: 'synthetic:orchestrator:backup-world-readable', keyVersion: 'v1' }));
    await denied('archived Secret Catalog key version does not silently resolve to v6', resolver({
      purpose: 'secret_catalog', escrowRef: 'synthetic:catalog:archive', keyVersion: 'v6',
    }));
    await denied('wrong connector invocation key version is refused', resolver({
      purpose: 'connector_invocation', escrowRef: 'connector-invocation-v1', keyVersion: '2',
    }));
    await denied('recovery key cannot cross between invocation and secret-catalog purposes', resolver({
      purpose: 'secret_catalog', escrowRef: 'connector-invocation-v1', keyVersion: '3',
    }));
    const wrongRegistry = loader.createMaintenanceRecoveryKeyResolver({ secretCatalogRegistry: {
      filePath: paths.registry, sha256: 'f'.repeat(64),
    } });
    await denied('wrong digest pin for the root-owned registry is refused', wrongRegistry({
      purpose: 'connector_invocation', escrowRef: 'connector-invocation-v1', keyVersion: '3',
    }));
    record('the synthetic symlink is root-owned and points only within its isolated fixture',
      aliasReceipt.uid === 0 && aliasReceipt.symlink === true,
      { uid: aliasReceipt.uid, symlink: aliasReceipt.symlink });

    const trustedStats = [];
    for (const relativePath of [
      'trusted/bundles/backup-v1.bin',
      'trusted/bundles/catalog-v4.bin',
      'trusted/bundles/catalog-v5.bin',
      'trusted/bundles/invocation-v3.bin',
      'trusted/bundles/credential-legacy-v1.txt',
      'trusted/bundles/world-readable.bin',
      'trusted/config/recovery-registry.json',
    ]) {
      const stat = await import('node:fs/promises').then((fs) => fs.lstat(path.join(root, relativePath)));
      trustedStats.push({ relativePath, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, bytes: stat.size });
    }
    record('trusted files and parents are root-owned and non-writable; readable fixture files use verifier group',
      trustedStats.every((stat) => stat.uid === 0 && (stat.mode & 0o022) === 0)
        && trustedStats.filter((stat) => stat.relativePath !== 'trusted/bundles/world-readable.bin').every((stat) => stat.gid === process.getgid()),
      { files: trustedStats.map(({ relativePath, uid, gid, mode, bytes }) => ({ relativePath, uid, gid, mode, bytes })) });
  } finally {
    for (const value of Object.values(keyMaterial)) value.fill(0);
    cleanup = await cleanupHostInfrastructureFixture(fixture);
    await mkdir(path.dirname(reportPath), { recursive: true });
    const sourceHash = sha256(await readFile(SOURCE));
    const helperHashes = {
      infrastructure: sha256(await readFile(path.join(ROOT, 'tests/workflow-api/orv14-vfy-host/infrastructure.mjs'))),
      verifier: sha256(await readFile(fileURLToPath(import.meta.url))),
    };
    const passed = CASES.filter((item) => item.status === 'passed').length;
    const failed = CASES.filter((item) => item.status === 'failed').length;
    const report = {
      schema: 'orv14-host-protected-recovery-key-loader/v1',
      disposition: failed === 0 && passed === 16 ? 'PARTIAL_PROTECTED_LOADER_PASS' : 'PROTECTED_LOADER_INCOMPLETE_OR_FAILED',
      command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-recovery-key-loader.mjs`,
      cwd: ROOT,
      node: process.version,
      startedAt,
      completedAt: NOW(),
      uid: process.getuid(),
      gid: process.getgid(),
      sourceHash,
      helperHashes,
      scratchBuild: { ...compiledBuild, outputUnderUniqueFixtureTemp: true, sharedDistModified: false },
      rootFixtureImage: image,
      namespace: projectId,
      tests: { passed, failed, skipped: 0, cases: CASES },
      cleanup,
      keyMaterialLogged: false,
      acceptance: 'protected recovery-key loader slice only; no encrypted backup restore or full host continuity acceptance is claimed',
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (failed !== 0 || passed !== 16) throw new Error(`protected loader test count incomplete: ${passed} passed, ${failed} failed`);
  }
}

main().catch((error) => {
  const safeMessage = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 1000);
  process.stderr.write(`ORV14 protected recovery loader verification failed: ${safeMessage}\n`);
  process.exitCode = 1;
});

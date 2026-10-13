import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { handleRuntimeRoutes } from '../src/http/routes/runtime';
import type { RouteContext } from '../src/http/route-context';
import { runtimeGrantBaseUrlFromEnv } from '../src/main';
import { TrustedRolloutManifestSchema } from '../src/modules/maintenance/trusted-rollout-manifest';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const composeRoot = path.join(repositoryRoot, 'compose');
const hostPath = (...parts: string[]): string => path.resolve(os.tmpdir(), 'orv15-vfy-host-paths', ...parts);
const gitBash = path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const itWithNativeSymlinks = process.platform === 'win32' ? it.skip : it;
const availabilityPath = path.join(composeRoot, 'availability.yml');
const releasePath = path.join(composeRoot, 'availability', 'slot-release.example.yml');
const selectorPath = path.join(composeRoot, 'ingress', 'reload-selector');
const nginxPath = path.join(composeRoot, 'ingress', 'nginx.conf');

function posixPath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):\/(.*)$/, (_match, drive: string, rest: string) => `/${drive.toLowerCase()}/${rest}`);
}

function shellInvocation(script: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: script, args };
  if (!existsSync(gitBash)) throw new Error('Git Bash is required to run the POSIX selector fixture on Windows');
  return {
    command: gitBash,
    args: [posixPath(script), ...args.map((argument) => /^[A-Za-z]:[\\/]/.test(argument) ? posixPath(argument) : argument)],
  };
}

function runBounded(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repositoryRoot,
) {
  const invocation = command === process.execPath ? { command, args } : shellInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 128 * 1024,
  });
}

function topLevelSection(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function extractBootstrap(source: string): string {
  const lines = source.split(/\r?\n/);
  const anchor = lines.findIndex((line) => line === '    entrypoint: &secret_bootstrap');
  expect(anchor).toBeGreaterThanOrEqual(0);
  const scalar = lines.findIndex((line, index) => index > anchor && line === '      - >-');
  expect(scalar).toBeGreaterThan(anchor);
  const script: string[] = [];
  for (let index = scalar + 1; index < lines.length && lines[index]!.startsWith('        '); index += 1) {
    script.push(lines[index]!.slice(8));
  }
  expect(script.length).toBeGreaterThan(10);
  return script.join(' ');
}

function selectorTreeState(root: string): string[] {
  const result: string[] = [];
  const visit = (current: string, relative = '') => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = path.join(current, entry);
      const name = relative ? `${relative}/${entry}` : entry;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) result.push(`${name}:link:${readlinkSync(absolute)}:${stat.mode & 0o777}`);
      else if (stat.isDirectory()) {
        result.push(`${name}:dir:${stat.mode & 0o777}`);
        visit(absolute, name);
      } else {
        const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        result.push(`${name}:file:${stat.mode & 0o777}:${digest}`);
      }
    }
  };
  visit(root);
  return result;
}

function expectedUpstream(orchestrator: 'blue' | 'green', connector: 'blue' | 'green'): string {
  return [
    `map $host $du_orchestrator_api_upstream { default orchestrator-${orchestrator}-http:3000; }`,
    `map $host $du_orchestrator_admin_upstream { default orchestrator-${orchestrator}-http:3001; }`,
    `map $host $du_orchestrator_control_upstream { default orchestrator-${orchestrator}-control:3002; }`,
    `map $host $du_connector_upstream { default connector-${connector}-http:8080; }`,
    `map $host $du_connector_control_upstream { default connector-${connector}-control:8080; }`,
    '',
  ].join('\n');
}

function nginxBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open).toBeGreaterThan(start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated Nginx block: ${marker}`);
}

function bindMounts(service: string): Array<{ source: string; target: string; readOnly: boolean }> {
  const lines = service.split(/\r?\n/);
  const mounts: Array<{ source: string; target: string; readOnly: boolean }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim() !== '- type: bind') continue;
    let source: string | undefined;
    let target: string | undefined;
    let readOnly = false;
    for (let cursor = index + 1; cursor < lines.length && /^\s{8}/.test(lines[cursor]!); cursor += 1) {
      const field = /^\s{8}(source|target|read_only):\s*(.+)$/.exec(lines[cursor]!);
      if (!field) continue;
      if (field[1] === 'source') source = field[2]!.trim();
      if (field[1] === 'target') target = field[2]!.trim();
      if (field[1] === 'read_only') readOnly = field[2]!.trim() === 'true';
    }
    if (source && target) mounts.push({ source, target, readOnly });
  }
  return mounts;
}

function manifestTarget(service: 'orchestrator' | 'connector' | 'worker') {
  const identity = (slot: 'blue' | 'green') => `${service}-${slot}-orv15`;
  const controlUrl = (slot: 'blue' | 'green') => service === 'orchestrator'
    ? `http://127.0.0.1:${slot === 'blue' ? '3302' : '3303'}`
    : `http://127.0.0.1:${slot === 'blue' ? '38080' : '38081'}`;
  const imageDigest = `registry.example.invalid/du/${service}@sha256:${'a'.repeat(64)}`;
  const target = {
    service,
    slots: {
      blue: {
        projectName: 'du-availability-blue',
        serviceId: service === 'worker' ? 'document-core' : service,
        runtimeIdentity: identity('blue'), revision: 'orv15-r1', imageDigest,
        ...(service === 'worker' ? { workerBusinessId: 'document-core' } : { controlBaseUrl: controlUrl('blue') }),
      },
      green: {
        projectName: 'du-availability-green',
        serviceId: service === 'worker' ? 'document-core' : service,
        runtimeIdentity: identity('green'), revision: 'orv15-r1', imageDigest,
        ...(service === 'worker' ? { workerBusinessId: 'document-core' } : { controlBaseUrl: controlUrl('green') }),
      },
    },
    releases: [{
      revision: 'orv15-r1',
      slots: {
        blue: { composeFiles: [
          { path: hostPath('releases', 'availability.yml'), sha256: 'b'.repeat(64) },
          { path: hostPath('releases', `${service}-blue.yml`), sha256: 'c'.repeat(64) },
        ], imageDigest },
        green: { composeFiles: [
          { path: hostPath('releases', 'availability.yml'), sha256: 'b'.repeat(64) },
          { path: hostPath('releases', `${service}-green.yml`), sha256: 'd'.repeat(64) },
        ], imageDigest },
      },
    }],
  };
  if (service !== 'worker') {
    Object.assign(target, {
      selectorFile: hostPath('availability', 'selectors', service),
      fixedIngressProbeUrl: `http://127.0.0.1:18081/${service}/identity`,
      reloadExecutable: hostPath('sbin', 'reload-selector'),
      reloadExecutableSha256: 'e'.repeat(64),
      reloadArgs: ['--context', 'du-production', service],
    });
  }
  return target;
}

function trustedManifest() {
  return {
    schemaVersion: 1,
    hostId: 'du-host-orv15',
    dockerBinary: hostPath('usr', 'bin', 'docker'),
    dockerSha256: 'f'.repeat(64),
    dockerContext: 'du-production',
    workingDirectory: hostPath('du'),
    homeDirectory: hostPath('root'),
    dockerConfigDirectory: hostPath('root', '.docker'),
    targets: [manifestTarget('orchestrator'), manifestTarget('connector'), manifestTarget('worker')],
  };
}

describe('VFY-ORV15-HA availability package contract', () => {
  it('renders all four selector combinations exactly and leaves selectors/includes untouched on success and rejection', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orv15-vfy-ha-selector-'));
    try {
      const selectorDir = path.join(root, 'selectors');
      const ingressDir = path.join(root, 'ingress');
      mkdirSync(selectorDir);
      mkdirSync(ingressDir);
      const orchestratorSelector = path.join(selectorDir, 'orchestrator');
      const connectorSelector = path.join(selectorDir, 'connector');
      const selectedInclude = path.join(ingressDir, 'selected-upstream.conf');
      writeFileSync(orchestratorSelector, 'blue\n', { mode: 0o640 });
      writeFileSync(connectorSelector, 'blue\n', { mode: 0o640 });
      writeFileSync(selectedInclude, '# fixture previous contents\n', { mode: 0o644 });

      for (const orchestrator of ['blue', 'green'] as const) {
        for (const connector of ['blue', 'green'] as const) {
          writeFileSync(orchestratorSelector, `${orchestrator}\n`);
          writeFileSync(connectorSelector, `${connector}\n`);
          const before = selectorTreeState(root);
          const result = runBounded(selectorPath, ['--render-only', root], {
            PATH: '/usr/bin:/bin', DU_AVAILABILITY_TEST_MODE: '1',
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stderr).toBe('');
          expect(result.stdout).toBe(expectedUpstream(orchestrator, connector));
          expect(selectorTreeState(root)).toEqual(before);
        }
      }

      const invalidCases: Array<() => void> = [
        () => writeFileSync(connectorSelector, 'purple\n'),
        () => writeFileSync(orchestratorSelector, 'green\ngreen\n'),
      ];
      for (const prepare of invalidCases) {
        rmSync(connectorSelector, { force: true });
        rmSync(orchestratorSelector, { force: true });
        writeFileSync(orchestratorSelector, 'blue\n');
        writeFileSync(connectorSelector, 'green\n');
        prepare();
        const before = selectorTreeState(root);
        const rejected = runBounded(selectorPath, ['--render-only', root], {
          PATH: '/usr/bin:/bin', DU_AVAILABILITY_TEST_MODE: '1',
        });
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).toBe(65);
        expect(rejected.stdout).toBe('');
        expect(selectorTreeState(root)).toEqual(before);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithNativeSymlinks('rejects a symlink selector without modifying the selected include', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orv15-vfy-ha-symlink-'));
    try {
      const selectorDir = path.join(root, 'selectors');
      const ingressDir = path.join(root, 'ingress');
      mkdirSync(selectorDir);
      mkdirSync(ingressDir);
      const orchestratorSelector = path.join(selectorDir, 'orchestrator');
      const connectorSelector = path.join(selectorDir, 'connector');
      const selectedInclude = path.join(ingressDir, 'selected-upstream.conf');
      writeFileSync(orchestratorSelector, 'blue\n');
      writeFileSync(connectorSelector, 'green\n');
      writeFileSync(selectedInclude, '# fixture previous contents\n');
      symlinkSync(orchestratorSelector, connectorSelector);

      const before = selectorTreeState(root);
      const rejected = runBounded(selectorPath, ['--render-only', root], {
        PATH: '/usr/bin:/bin', DU_AVAILABILITY_TEST_MODE: '1',
      });
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).toBe(65);
      expect(rejected.stdout).toBe('');
      expect(selectorTreeState(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies the production selector when the shell reports non-root despite legacy test mode', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orv15-vfy-ha-nonroot-'));
    try {
      const availabilityRoot = path.join(root, 'availability');
      const bin = path.join(root, 'bin');
      const bashEnv = path.join(root, 'bash-env');
      const privateScript = path.join(root, 'reload-selector');
      const fakeDocker = path.join(root, 'docker-stub');
      mkdirSync(bin);
      const source = readFileSync(selectorPath, 'utf8')
        .replace('root=/etc/du/availability', `root=${posixPath(availabilityRoot)}`)
        .replace('docker=/usr/bin/docker', `docker=${posixPath(fakeDocker)}`);
      expect(source).not.toBe(readFileSync(selectorPath, 'utf8'));
      writeFileSync(privateScript, source, { mode: 0o700 });
      writeFileSync(path.join(bin, 'id'), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o700 });
      writeFileSync(fakeDocker, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(bashEnv, 'PATH="$TEST_BIN:$PATH"\nexport PATH\n');
      const result = runBounded(privateScript, ['--context', 'du-synthetic-context', 'orchestrator'], {
        PATH: `${posixPath(bin)}:/usr/bin:/bin`,
        TEST_BIN: posixPath(bin),
        BASH_ENV: process.platform === 'win32' ? posixPath(bashEnv) : bashEnv,
        DU_AVAILABILITY_TEST_MODE: 'true',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(77);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('reload-selector requires root');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects wrong runtime-config hashes and forbidden identity overrides before spawning a service', () => {
    const script = extractBootstrap(readFileSync(availabilityPath, 'utf8'));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'orv15-vfy-ha-bootstrap-'));
    const configPath = path.join(directory, 'runtime.json');
    try {
      const validConfig = JSON.stringify({
        schemaVersion: 1,
        service: 'orchestrator',
        environment: { PORT: '3000' },
      });
      writeFileSync(configPath, validConfig, { mode: 0o600 });
      const validHash = createHash('sha256').update(validConfig).digest('hex');
      const commonEnv = {
        PATH: '/usr/bin:/bin',
        DU_RUNTIME_SERVICE: 'orchestrator',
        DU_RUNTIME_CONFIG_PATH: configPath,
      };

      const wrongHash = runBounded(process.execPath, ['-e', script], {
        ...commonEnv,
        DU_RUNTIME_CONFIG_SHA256: '0'.repeat(64),
      });
      expect(wrongHash.error).toBeUndefined();
      expect(wrongHash.status).toBe(78);
      expect(wrongHash.stderr).toContain('DU_RUNTIME_CONFIG_INVALID');

      const forbiddenValue = 'DO_NOT_ECHO_OR_SPAWN_SENTINEL';
      const forbiddenConfig = JSON.stringify({
        schemaVersion: 1,
        service: 'orchestrator',
        environment: { DU_ORCHESTRATOR_RUNTIME_IDENTITY: forbiddenValue },
      });
      writeFileSync(configPath, forbiddenConfig, { mode: 0o600 });
      const forbidden = runBounded(process.execPath, ['-e', script], {
        ...commonEnv,
        DU_RUNTIME_CONFIG_SHA256: createHash('sha256').update(forbiddenConfig).digest('hex'),
      });
      expect(forbidden.error).toBeUndefined();
      expect(forbidden.status).toBe(78);
      expect(forbidden.stderr).toContain('DU_RUNTIME_CONFIG_INVALID');
      expect(forbidden.stderr).not.toContain(forbiddenValue);
      expect(forbidden.stdout).toBe('');
      expect(validHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds Worker artifact grant URLs from the private ingress origin used by the actual grant handler', async () => {
    const availability = readFileSync(availabilityPath, 'utf8');
    const orchestrator = topLevelSection(availability, 'orchestrator');
    const configuredOrigin = /^\s+ORCHESTRATOR_INTERNAL_BASE_URL:\s*(\S+)\s*$/m.exec(orchestrator)?.[1];
    expect(configuredOrigin).toBeDefined();

    const runtimeBaseUrl = runtimeGrantBaseUrlFromEnv({
      NODE_ENV: 'production',
      ORCHESTRATOR_INTERNAL_BASE_URL: configuredOrigin,
    });
    expect(runtimeBaseUrl).toBe('http://du-availability-ingress:8080');

    const requestUpload = jest.fn(async () => ({
      artifactId: 'orv15-artifact',
      uploadUrl: '/api/runtime/v1/artifacts/blob/orv15-key?grant=synthetic-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const context = {
      ingressAudience: 'runtime',
      method: 'POST',
      pathname: '/api/runtime/v1/tasks/orv15-task/artifacts',
      searchParams: new URLSearchParams(),
      headers: { authorization: 'Bearer synthetic-platform-token' },
      body: { leaseEpoch: 1 },
      rawBody: Buffer.alloc(0),
      correlationId: 'orv15-vfy-ha-grant-url',
      host: 'client.invalid',
      db: { query: jest.fn() },
      config: { runtimeToken: 'synthetic-platform-token', runtimeBaseUrl },
      artifacts: { requestUpload },
    } as unknown as RouteContext;

    const response = await handleRuntimeRoutes(context);
    expect(response?.status).toBe(201);
    expect(requestUpload).toHaveBeenCalledWith('orv15-task', 1, { leaseEpoch: 1 });
    expect((response?.body as { uploadUrl: string }).uploadUrl)
      .toBe('http://du-availability-ingress:8080/api/runtime/v1/artifacts/blob/orv15-key?grant=synthetic-token');

    const privateWorkerServer = nginxBlock(readFileSync(nginxPath, 'utf8'), '  server {\n    listen 8080;');
    const privateArtifactRoute = nginxBlock(privateWorkerServer, 'location ^~ /api/runtime/v1/');
    expect(privateWorkerServer).toContain('allow 172.31.0.0/24;');
    expect(privateWorkerServer).toContain('deny all;');
    expect(privateArtifactRoute).toContain('proxy_pass http://$du_orchestrator_api_upstream;');
  });

  it('keeps six trusted slot pins, Worker without ports, ingress mounts narrow, and Admin/control routes separated', () => {
    const parsed = TrustedRolloutManifestSchema.parse(trustedManifest());
    const slots = parsed.targets.flatMap((target) => [target.slots.blue, target.slots.green]);
    expect(new Set(slots.map((slot) => slot.runtimeIdentity)).size).toBe(6);
    expect(new Set(slots.map((slot) => slot.projectName))).toEqual(new Set(['du-availability-blue', 'du-availability-green']));
    for (const target of parsed.targets) {
      for (const slotName of ['blue', 'green'] as const) {
        const slot = target.slots[slotName];
        expect(slot.imageDigest).toMatch(/^.+@sha256:[a-f0-9]{64}$/);
        const release = target.releases[0]!.slots[slotName];
        expect(release.composeFiles).toHaveLength(2);
        expect(release.composeFiles.every((pin) => /^[a-f0-9]{64}$/.test(pin.sha256))).toBe(true);
        expect(release.imageDigest).toBe(slot.imageDigest);
      }
    }
    const worker = parsed.targets.find((target) => target.service === 'worker')!;
    expect(worker.slots.blue.serviceId).toBe('document-core');
    expect(worker.slots.green.serviceId).toBe('document-core');
    expect(worker.slots.blue.workerBusinessId).toBe('document-core');
    expect(worker.slots.green.workerBusinessId).toBe('document-core');
    expect(worker.slots.blue.controlBaseUrl).toBeUndefined();
    expect(worker.slots.green.controlBaseUrl).toBeUndefined();
    expect(worker.fixedIngressProbeUrl).toBeUndefined();

    const release = readFileSync(releasePath, 'utf8');
    const workerService = topLevelSection(release, 'document-core');
    expect(workerService).not.toMatch(/^\s*ports:/m);
    expect(workerService).toContain('du-worker-api-net');
    expect(workerService).not.toContain('du-control-net');

    const availability = readFileSync(availabilityPath, 'utf8');
    const ingressService = topLevelSection(availability, 'ingress');
    expect(bindMounts(ingressService)).toEqual([
      {
        source: '/etc/du/availability/ingress',
        target: '/etc/du/availability/ingress',
        readOnly: true,
      },
      {
        source: '/etc/du/availability/tls',
        target: '/etc/nginx/tls',
        readOnly: true,
      },
    ]);
    expect(ingressService).toContain("'127.0.0.1:18081:8081'");

    const nginx = readFileSync(nginxPath, 'utf8');
    const publicServer = nginxBlock(nginx, '  server {\n    listen 443 ssl default_server;');
    for (const route of ['/api/internal/', '/api/runtime/v1/', '/internal/', '/connector/internal/']) {
      expect(nginxBlock(publicServer, `location ^~ ${route}`)).toContain('return 404;');
    }
    const adminBff = nginxBlock(publicServer, 'location ^~ /admin/api/');
    expect(adminBff).toContain('proxy_pass http://$du_orchestrator_admin_upstream;');
    expect(adminBff).toContain('proxy_set_header Authorization $http_authorization;');
    const connectorApi = nginxBlock(publicServer, 'location ^~ /connector/ {');
    expect(connectorApi).toContain('rewrite ^/connector/(.*)$ /$1 break;');
    expect(connectorApi).toContain('proxy_pass http://$du_connector_upstream;');

    const privateControlServer = nginxBlock(nginx, '  server {\n    listen 8081;');
    expect(privateControlServer).toContain('allow 127.0.0.1;');
    expect(privateControlServer).toContain('allow 172.30.0.0/24;');
    expect(privateControlServer).toContain('deny all;');
    const orchestratorIdentity = nginxBlock(privateControlServer, 'location = /orchestrator/identity');
    expect(orchestratorIdentity).toContain('/api/internal/service-runtime/identity');
    expect(orchestratorIdentity).toContain('proxy_set_header Authorization $http_authorization;');
    const connectorIdentity = nginxBlock(privateControlServer, 'location = /connector/identity');
    expect(connectorIdentity).toContain('/internal/admin/runtime-control/observe');
    expect(connectorIdentity).toContain('proxy_set_header Authorization $http_authorization;');

    const invalidWorker = trustedManifest();
    Object.assign(invalidWorker.targets[2]!, { fixedIngressProbeUrl: 'http://127.0.0.1:18081/worker/identity' });
    expect(TrustedRolloutManifestSchema.safeParse(invalidWorker).success).toBe(false);
    const invalidPin = trustedManifest();
    invalidPin.targets[1]!.releases[0]!.slots.green.composeFiles[1]!.sha256 = 'not-a-sha';
    expect(TrustedRolloutManifestSchema.safeParse(invalidPin).success).toBe(false);
  });
});

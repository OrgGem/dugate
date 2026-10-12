import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { TrustedRolloutManifestSchema } from '../src/modules/maintenance/trusted-rollout-manifest';
import { absoluteGrantUrl } from '../src/server';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const composeRoot = path.join(repositoryRoot, 'compose');

function digest(value: string): string {
  return `${value}@sha256:${'a'.repeat(64)}`;
}

function runtimeTarget(service: 'orchestrator' | 'connector' | 'worker') {
  const imageDigest = digest(`registry.example/${service}`);
  const target = {
    service,
    slots: {
      blue: {
        projectName: 'du-availability-blue', serviceId: service === 'worker' ? 'document-core' : service,
        runtimeIdentity: `${service}-blue-r15`, revision: 'r15.1', imageDigest,
        ...(service === 'worker' ? { workerBusinessId: 'document-core' } : {
          controlBaseUrl: service === 'orchestrator'
            ? 'http://127.0.0.1:3302/api/internal/service-runtime'
            : 'http://127.0.0.1:38080/internal/admin/runtime-control',
        }),
      },
      green: {
        projectName: 'du-availability-green', serviceId: service === 'worker' ? 'document-core' : service,
        runtimeIdentity: `${service}-green-r15`, revision: 'r15.1', imageDigest,
        ...(service === 'worker' ? { workerBusinessId: 'document-core' } : {
          controlBaseUrl: service === 'orchestrator'
            ? 'http://127.0.0.1:3303/api/internal/service-runtime'
            : 'http://127.0.0.1:38081/internal/admin/runtime-control',
        }),
      },
    },
    releases: [{
      revision: 'r15.1',
      slots: {
        blue: { composeFiles: [
          { path: '/srv/du/releases/availability.yml', sha256: 'a'.repeat(64) },
          { path: `/srv/du/releases/${service}-blue-r15.1.yml`, sha256: 'b'.repeat(64) },
        ], imageDigest },
        green: { composeFiles: [
          { path: '/srv/du/releases/availability.yml', sha256: 'a'.repeat(64) },
          { path: `/srv/du/releases/${service}-green-r15.1.yml`, sha256: 'c'.repeat(64) },
        ], imageDigest },
      },
    }],
  };
  if (service !== 'worker') {
    Object.assign(target, {
      selectorFile: `/etc/du/availability/selectors/${service}`,
      fixedIngressProbeUrl: `http://127.0.0.1:18081/${service}/identity`,
      reloadExecutable: '/usr/local/sbin/reload-selector',
      reloadExecutableSha256: 'd'.repeat(64),
      reloadArgs: ['--context', 'production', service],
    });
  }
  return target;
}

function trustedManifest() {
  return {
    schemaVersion: 1,
    hostId: 'du-host-prod-a',
    dockerBinary: '/usr/bin/docker',
    dockerSha256: 'e'.repeat(64),
    dockerContext: 'production',
    workingDirectory: '/srv/du',
    homeDirectory: '/root',
    dockerConfigDirectory: '/root/.docker',
    targets: [runtimeTarget('orchestrator'), runtimeTarget('connector'), runtimeTarget('worker')],
  };
}

function section(source: string, name: string): string {
  const start = source.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^  [A-Za-z0-9_-]+:/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function secretBootstrap(source: string): string {
  const lines = source.split(/\r?\n/);
  const marker = lines.indexOf('    entrypoint: &secret_bootstrap');
  expect(marker).toBeGreaterThanOrEqual(0);
  const scalar = lines.indexOf('      - >-', marker);
  expect(scalar).toBeGreaterThan(marker);
  const body: string[] = [];
  for (let index = scalar + 1; index < lines.length && lines[index]!.startsWith('        '); index += 1) {
    body.push(lines[index]!.slice(8));
  }
  expect(body.length).toBeGreaterThan(3);
  return body.join(' ');
}

function createSelectorProcessHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orv15-ha-lock-'));
  const availabilityRoot = path.join(root, 'availability');
  const selectors = path.join(availabilityRoot, 'selectors');
  const ingress = path.join(availabilityRoot, 'ingress');
  const bin = path.join(root, 'bin');
  mkdirSync(selectors, { recursive: true });
  mkdirSync(ingress, { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(selectors, 'orchestrator'), 'blue\n');
  writeFileSync(path.join(selectors, 'connector'), 'blue\n');
  const selected = path.join(ingress, 'selected-upstream.conf');
  writeFileSync(selected, 'initial-selector-snapshot\n');

  const source = readFileSync(path.join(composeRoot, 'ingress', 'reload-selector'), 'utf8');
  const privateHelper = path.join(root, 'reload-selector');
  const dockerStub = path.join(root, 'docker-stub');
  const lockPath = path.join(availabilityRoot, '.reload-selector.lock');
  const dockerLog = path.join(root, 'docker.log');
  const rmdirLog = path.join(root, 'rmdir.log');
  const privateSource = source
    .replace('root=/etc/du/availability', `root=${availabilityRoot}`)
    .replace('docker=/usr/bin/docker', `docker=${dockerStub}`);
  expect(privateSource).not.toBe(source);
  expect(privateSource).toContain(`root=${availabilityRoot}`);
  expect(privateSource).toContain(`docker=${dockerStub}`);
  writeFileSync(privateHelper, privateSource, { mode: 0o700 });
  writeFileSync(dockerStub, [
    '#!/bin/sh',
    'set -eu',
    'printf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"',
    'case "$*" in *"nginx -s reload"*) case "${TEST_DOCKER_SIGNAL-}" in HUP|INT|TERM) kill -"$TEST_DOCKER_SIGNAL" "$PPID" ;; esac ;; esac',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'id'), '#!/bin/sh\n[ "${1-}" = -u ] || exit 1\nprintf "0\\n"\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'mkdir'), [
    '#!/bin/sh',
    'set -eu',
    'if [ "${1-}" = "${TEST_LOCK_PATH-}" ]; then',
    '  case "${TEST_LOCK_MODE-}" in',
    '    before) : > "$TEST_LOCK_REACHED"; while [ ! -f "$TEST_LOCK_RELEASE" ]; do /bin/sleep 0.01; done ;;',
    '    after) /usr/bin/mkdir "$@"; : > "$TEST_LOCK_REACHED"; while [ ! -f "$TEST_LOCK_RELEASE" ]; do /bin/sleep 0.01; done; exit 0 ;;',
    '  esac',
    'fi',
    'exec /usr/bin/mkdir "$@"',
  ].join('\n') + '\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'rmdir'), [
    '#!/bin/sh',
    'set -eu',
    'if [ "${1-}" = "${TEST_LOCK_PATH-}" ]; then printf "called\\n" >> "$TEST_RMDIR_LOG"; fi',
    'exec /usr/bin/rmdir "$@"',
  ].join('\n') + '\n', { mode: 0o700 });

  return {
    root, availabilityRoot, selectors, selected, privateHelper, lockPath, dockerLog, rmdirLog,
    env(mode: 'before' | 'after' | 'normal', reached = '', signal = ''): NodeJS.ProcessEnv {
      return {
        PATH: `${bin}:/usr/bin:/bin`,
        TEST_LOCK_PATH: lockPath,
        TEST_LOCK_MODE: mode === 'normal' ? '' : mode,
        TEST_LOCK_REACHED: reached,
        TEST_LOCK_RELEASE: path.join(root, 'release-lock'),
        TEST_DOCKER_LOG: dockerLog,
        TEST_DOCKER_SIGNAL: signal,
        TEST_RMDIR_LOG: rmdirLog,
      };
    },
    release(): void { writeFileSync(path.join(root, 'release-lock'), 'release\n'); },
    cleanup(): void { rmSync(root, { recursive: true, force: true }); },
  };
}

async function waitForMarker(marker: string, child: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return;
    if (child.exitCode !== null) throw new Error(`selector helper exited before barrier (${child.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('selector helper did not reach its deterministic barrier');
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('selector helper exceeded its bounded subprocess timeout'));
    }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });
}

describe('ORV15 two-slot Compose package', () => {
  it('accepts six distinct slot identities with exact digest-pinned compose releases and private control/probe paths', () => {
    const parsed = TrustedRolloutManifestSchema.parse(trustedManifest());
    expect(parsed.targets).toHaveLength(3);

    const identities = parsed.targets.flatMap((target) => [target.slots.blue, target.slots.green]);
    expect(new Set(identities.map((slot) => slot.runtimeIdentity)).size).toBe(6);
    expect(new Set(identities.map((slot) => slot.projectName)).size).toBe(2);
    expect(new Set(parsed.targets.map((target) => target.slots.blue.projectName)).size).toBe(1);
    expect(new Set(parsed.targets.map((target) => target.slots.green.projectName)).size).toBe(1);
    for (const target of parsed.targets) {
      expect(target.slots.blue.serviceId).toBe(target.slots.green.serviceId);
      const release = target.releases[0]!;
      for (const slot of ['blue', 'green'] as const) {
        expect(release.slots[slot].composeFiles[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(release.slots[slot].composeFiles).toHaveLength(2);
        expect(release.slots[slot].imageDigest).toMatch(/@sha256:[a-f0-9]{64}$/);
      }
      if (target.service === 'worker') {
        expect(target.slots.blue.controlBaseUrl).toBeUndefined();
        expect(target.slots.green.controlBaseUrl).toBeUndefined();
        expect(target.fixedIngressProbeUrl).toBeUndefined();
      } else {
        expect(target.slots.blue.controlBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(target.slots.green.controlBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(target.fixedIngressProbeUrl).toMatch(/^http:\/\/127\.0\.0\.1:18081\//);
      }
    }
    expect(parsed.targets.find((target) => target.service === 'worker')?.slots.blue.serviceId).toBe('document-core');
  });

  it('rejects slot aliasing and any worker HTTP/control surface', () => {
    const aliasedProject = trustedManifest();
    aliasedProject.targets[0]!.slots.green.projectName = aliasedProject.targets[0]!.slots.blue.projectName;
    expect(TrustedRolloutManifestSchema.safeParse(aliasedProject).success).toBe(false);

    const workerWithIngress = trustedManifest();
    Object.assign(workerWithIngress.targets[2]!, { fixedIngressProbeUrl: 'http://worker.internal/identity' });
    expect(TrustedRolloutManifestSchema.safeParse(workerWithIngress).success).toBe(false);
  });

  it('ships explicit, non-runnable examples with no implicit env file, include, or build path', () => {
    const availability = readFileSync(path.join(composeRoot, 'availability.yml'), 'utf8');
    const release = readFileSync(path.join(composeRoot, 'availability', 'slot-release.example.yml'), 'utf8');
    const envExample = readFileSync(path.join(composeRoot, 'availability-slot.env.example'), 'utf8');

    for (const source of [availability, release]) {
      expect(source).not.toMatch(/^\s*(?:include|env_file|build):/m);
      expect(source).not.toContain('${');
      expect(source).toMatch(/example\.invalid/);
      expect(source).toMatch(/@sha256:0{64}/);
    }
    expect(`${availability}\n${release}`).toMatch(/profiles:\s*\[slot\]/);
    expect(`${availability}\n${release}`).toMatch(/profiles:\s*\[edge\]/);
    expect(envExample).toMatch(/NOT_FOR_COMPOSE/);
    expect(envExample).toMatch(/ORCHESTRATOR_RUNTIME_IDENTITY/);
    expect(envExample).toMatch(/CONNECTOR_RUNTIME_IDENTITY/);
    expect(envExample).toMatch(/WORKER_INSTANCE_ID/);
    expect(envExample).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it('keeps the Worker private and routes public API, Admin, Connector, and authenticated probes separately', () => {
    const availability = readFileSync(path.join(composeRoot, 'availability.yml'), 'utf8');
    const release = readFileSync(path.join(composeRoot, 'availability', 'slot-release.example.yml'), 'utf8');
    const ingress = readFileSync(path.join(composeRoot, 'ingress', 'nginx.conf'), 'utf8');
    const worker = section(release, 'document-core');
    const ingressService = section(availability, 'ingress');

    expect(worker).not.toMatch(/^\s*ports:/m);
    expect(worker).toContain('du-worker-api-net');
    expect(worker).not.toContain('du-control-net');
    expect(availability).toContain('container_name: du-availability-ingress');
    expect(availability).toContain("127.0.0.1:18081:8081");
    expect(ingressService).toContain('source: /etc/du/availability/ingress');
    expect(ingressService).not.toContain('source: /etc/du/availability\n');
    expect(ingressService).not.toContain('source: /etc/du/availability/secrets');
    expect(ingress).toContain('/admin/api/');
    expect(ingress).toContain('/admin/');
    expect(ingress).toContain('/connector/');
    expect(ingress).toContain('/api/internal/');
    expect(ingress).toContain('/api/runtime/v1/');
    expect(ingress).toContain('listen 8081');
    expect(ingress).toContain('allow 127.0.0.1');
    expect(ingress).toContain('include /etc/du/availability/ingress/selected-upstream.conf');
    expect(ingress).toContain('proxy_set_header Authorization $http_authorization');
    expect(ingress).toContain('deny all');
    const adminBff = /location \^~ \/admin\/api\/ \{([\s\S]*?)\n    \}/.exec(ingress)?.[1] ?? '';
    expect(adminBff).toContain('proxy_pass http://$du_orchestrator_admin_upstream');
    const connectorIdentity = /location = \/connector\/identity \{([\s\S]*?)\n    \}/.exec(ingress)?.[1] ?? '';
    expect(connectorIdentity).toContain('/internal/admin/runtime-control/observe');
  });

  it('gives Worker artifact grants a reachable private ingress origin and keeps host probes DNAT-aware', () => {
    const availability = readFileSync(path.join(composeRoot, 'availability.yml'), 'utf8');
    const ingress = readFileSync(path.join(composeRoot, 'ingress', 'nginx.conf'), 'utf8');
    const selected = readFileSync(path.join(composeRoot, 'ingress', 'selected-upstream.conf'), 'utf8');
    const workerListener = /server\s*\{\s*listen 8080;([\s\S]*?)\n  \}/.exec(ingress)?.[1] ?? '';
    const controlListener = /server\s*\{\s*listen 8081;([\s\S]*?)\n  \}/.exec(ingress)?.[1] ?? '';
    const ingressService = section(availability, 'ingress');
    const runtimeOrigin = 'http://du-availability-ingress:8080';
    const grantPath = '/api/runtime/v1/artifacts/blob/storage-key?grant=opaque';

    expect(availability).toContain(`ORCHESTRATOR_INTERNAL_BASE_URL: ${runtimeOrigin}`);
    expect(absoluteGrantUrl('untrusted.invalid', grantPath, { publicBaseUrl: runtimeOrigin }))
      .toBe(`${runtimeOrigin}${grantPath}`);
    expect(workerListener).toContain('allow 172.31.0.0/24;');
    expect(workerListener).toContain('deny all;');
    expect(workerListener).not.toContain('172.30.0.0/24');
    expect(workerListener).not.toContain('172.32.0.0/24');
    expect(workerListener).toContain('location ^~ /api/runtime/v1/');
    expect(workerListener).toContain('proxy_pass http://$du_orchestrator_api_upstream;');
    expect(selected).toContain('default orchestrator-blue-http:3000;');
    expect(ingressService).not.toMatch(/^\s*- ['"]?8080:/m);

    // A host-published loopback port is not proof that the packet reaches
    // Nginx from loopback after Docker DNAT. The configured ACL permits only
    // loopback and the dedicated control subnet; live source visibility still
    // requires deployment verification.
    expect(ingressService).toContain("127.0.0.1:18081:8081");
    expect(controlListener).toContain('allow 127.0.0.1;');
    expect(controlListener).toContain('allow 172.30.0.0/24;');
    expect(controlListener).toContain('deny all;');
  });

  it('sets an explicit bounded body limit compatible with legacy API and Admin upload handlers', () => {
    const ingress = readFileSync(path.join(composeRoot, 'ingress', 'nginx.conf'), 'utf8');
    const http = /^http \{([\s\S]*?)^\}/m.exec(ingress)?.[1] ?? '';

    expect(http).toContain('client_max_body_size 64m;');
    expect(ingress).not.toContain('client_max_body_size 256m;');
  });

  it('serializes both-selector snapshots across overlapping service switches', async () => {
    const harness = createSelectorProcessHarness();
    let first: ReturnType<typeof spawn> | undefined;
    let second: ReturnType<typeof spawn> | undefined;
    try {
      // A models Connector's per-service selector write before invoking Nginx.
      writeFileSync(path.join(harness.selectors, 'connector'), 'green\n');
      const reached = path.join(harness.root, 'first-before-lock');
      first = spawn(harness.privateHelper, ['--context', 'unit', 'connector'], {
        env: harness.env('before', reached), stdio: 'ignore',
      });
      await waitForMarker(reached, first);

      // An independent Orchestrator cutover commits while A is stopped just
      // before the global helper lock. A must read this newer sibling value.
      writeFileSync(path.join(harness.selectors, 'orchestrator'), 'green\n');
      second = spawn(harness.privateHelper, ['--context', 'unit', 'orchestrator'], {
        env: harness.env('normal'), stdio: 'ignore',
      });
      expect(await waitForExit(second)).toBe(0);
      expect(readFileSync(harness.selected, 'utf8')).toContain('orchestrator-green-http:3000');

      harness.release();
      expect(await waitForExit(first)).toBe(0);
      const finalInclude = readFileSync(harness.selected, 'utf8');
      expect(finalInclude).toContain('orchestrator-green-http:3000');
      expect(finalInclude).toContain('connector-green-http:8080');
    } finally {
      harness.release();
      if (first && first.exitCode === null) first.kill('SIGKILL');
      if (second && second.exitCode === null) second.kill('SIGKILL');
      harness.cleanup();
    }
  });

  it('holds the global lock before reading selectors and retries a blocked sibling safely', async () => {
    const harness = createSelectorProcessHarness();
    let first: ReturnType<typeof spawn> | undefined;
    let blocked: ReturnType<typeof spawn> | undefined;
    let retry: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(path.join(harness.selectors, 'connector'), 'green\n');
      const reached = path.join(harness.root, 'first-after-lock');
      first = spawn(harness.privateHelper, ['--context', 'unit', 'connector'], {
        env: harness.env('after', reached), stdio: 'ignore',
      });
      await waitForMarker(reached, first);

      writeFileSync(path.join(harness.selectors, 'orchestrator'), 'green\n');
      blocked = spawn(harness.privateHelper, ['--context', 'unit', 'orchestrator'], {
        env: harness.env('normal'), stdio: 'ignore',
      });
      expect(await waitForExit(blocked)).toBe(75);
      expect(readFileSync(harness.selected, 'utf8')).toBe('initial-selector-snapshot\n');
      expect(existsSync(harness.lockPath)).toBe(true);

      harness.release();
      expect(await waitForExit(first)).toBe(0);
      const firstInclude = readFileSync(harness.selected, 'utf8');
      expect(firstInclude).toContain('orchestrator-green-http:3000');
      expect(firstInclude).toContain('connector-green-http:8080');

      retry = spawn(harness.privateHelper, ['--context', 'unit', 'orchestrator'], {
        env: harness.env('normal'), stdio: 'ignore',
      });
      expect(await waitForExit(retry)).toBe(0);
      expect(readFileSync(harness.selected, 'utf8')).toContain('orchestrator-green-http:3000');
    } finally {
      harness.release();
      for (const child of [first, blocked, retry]) {
        if (child && child.exitCode === null) child.kill('SIGKILL');
      }
      harness.cleanup();
    }
  });

  it.each([['HUP', 129], ['INT', 130], ['TERM', 143]] as const)(
    'exits on SIG%s with the conventional code and performs lock cleanup once', async (signal, expectedCode) => {
      const harness = createSelectorProcessHarness();
      try {
        writeFileSync(path.join(harness.selectors, 'orchestrator'), 'green\n');
        const child = spawn(harness.privateHelper, ['--context', 'unit', 'orchestrator'], {
          env: harness.env('normal', '', signal), stdio: 'ignore',
        });
        expect(await waitForExit(child)).toBe(expectedCode);
        expect(existsSync(harness.lockPath)).toBe(false);
        const cleanupCalls = existsSync(harness.rmdirLog)
          ? readFileSync(harness.rmdirLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
          : 0;
        expect(cleanupCalls).toBe(1);
      } finally {
        harness.release();
        harness.cleanup();
      }
    },
  );

  it('executes the actual inline runtime bootstrap and rejects a forbidden secret override without echoing it', () => {
    const availability = readFileSync(path.join(composeRoot, 'availability.yml'), 'utf8');
    const script = secretBootstrap(availability);
    const root = mkdtempSync(path.join(os.tmpdir(), 'orv15-ha-bootstrap-'));
    try {
      const config = JSON.stringify({
        schemaVersion: 1,
        service: 'orchestrator',
        environment: { NODE_OPTIONS: 'SECRET_SENTINEL_NOT_LOGGED' },
      });
      const configPath = path.join(root, 'runtime.json');
      writeFileSync(configPath, config, { mode: 0o600 });
      const hash = createHash('sha256').update(config).digest('hex');
      const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DU_RUNTIME_SERVICE: 'orchestrator',
          DU_RUNTIME_CONFIG_PATH: configPath,
          DU_RUNTIME_CONFIG_SHA256: hash,
        },
      });
      expect(result.status).toBe(78);
      expect(result.stderr).toContain('DU_RUNTIME_CONFIG_INVALID');
      expect(result.stderr).not.toContain('SECRET_SENTINEL_NOT_LOGGED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed for invalid selectors and renders only the selected blue/green targets', () => {
    const script = path.join(composeRoot, 'ingress', 'reload-selector');
    const root = mkdtempSync(path.join(os.tmpdir(), 'orv15-ha-selector-'));
    try {
      const selectors = path.join(root, 'selectors');
      const ingressDir = path.join(root, 'ingress');
      const selected = path.join(ingressDir, 'selected-upstream.conf');
      mkdirSync(selectors);
      mkdirSync(ingressDir);
      writeFileSync(path.join(selectors, 'orchestrator'), 'green\n');
      writeFileSync(path.join(selectors, 'connector'), 'blue\n');
      writeFileSync(selected, 'previous\n');

      const rendered = spawnSync(script, ['--render-only', root], { encoding: 'utf8' });
      expect(rendered.status).toBe(0);
      expect(rendered.stdout).toContain('orchestrator-green-http:3000');
      expect(rendered.stdout).toContain('connector-blue-http:8080');
      expect(readFileSync(selected, 'utf8')).toBe('previous\n');
      expect(existsSync(path.join(root, '.reload-selector.lock'))).toBe(false);

      writeFileSync(path.join(selectors, 'connector'), 'purple\n');
      const rejected = spawnSync(script, ['--render-only', root], { encoding: 'utf8' });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe('');
      expect(readFileSync(selected, 'utf8')).toBe('previous\n');

      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const production = spawnSync(script, ['--context', 'production', 'orchestrator'], { encoding: 'utf8' });
        expect(production.status).toBe(77);
      }
      const relativeRoot = spawnSync(script, ['--render-only', 'relative/path'], { encoding: 'utf8' });
      expect(relativeRoot.status).toBe(64);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

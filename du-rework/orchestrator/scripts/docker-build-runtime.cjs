'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKSPACE_GROUPS = ['packages', 'services', 'apps'];
const RUNTIME_PACKAGES = {
  orchestrator: {
    packageName: '@du/orchestrator',
    files: ['dist', 'migrations', 'scripts/ldba-context-provider.cjs'],
  },
  connector: {
    packageName: '@du/connector',
    files: ['dist'],
  },
};

function workspacePackages(root) {
  const packages = [];
  for (const group of WORKSPACE_GROUPS) {
    for (const entry of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(root, group, entry.name, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      packages.push({
        manifestPath,
        manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      });
    }
  }
  return packages;
}

function withInjectWorkspacePackages(lockfile, root) {
  const absoluteTarballs = lockfile.replace(/tarball: file:([^,}\r\n]+)/g, (_match, file) => {
    const resolved = path.resolve(root, file).split(path.sep).join('/');
    return `tarball: file:${resolved}`;
  });
  if (/^  injectWorkspacePackages:/m.test(absoluteTarballs)) {
    return absoluteTarballs.replace(/^  injectWorkspacePackages:.*$/m, '  injectWorkspacePackages: true');
  }
  if (!/^settings:\r?\n/m.test(absoluteTarballs)) {
    throw new Error('pnpm lockfile settings are missing');
  }
  return absoluteTarballs.replace(/^settings:\r?\n/m, 'settings:\n  injectWorkspacePackages: true\n');
}

function runPnpm(root, args) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`);
  }
}

function packageFilesFor(name, runtime) {
  return name === runtime.packageName ? runtime.files : ['dist'];
}

function buildRuntime(service, root, output) {
  const runtime = RUNTIME_PACKAGES[service];
  if (!runtime) throw new Error('service must be orchestrator or connector');

  const workspaceRoot = path.resolve(root);
  const outputRoot = path.resolve(output);
  const outputPackage = path.join(outputRoot, service);
  const lockfile = path.join(workspaceRoot, 'pnpm-lock.yaml');
  const manifests = workspacePackages(workspaceRoot);
  const originals = new Map(manifests.map(({ manifestPath }) => [manifestPath, fs.readFileSync(manifestPath)]));
  const originalLockfile = fs.readFileSync(lockfile);

  try {
    for (const { manifestPath, manifest } of manifests) {
      fs.writeFileSync(manifestPath, `${JSON.stringify({
        ...manifest,
        files: packageFilesFor(manifest.name, runtime),
      }, null, 2)}\n`);
    }
    fs.writeFileSync(lockfile, withInjectWorkspacePackages(originalLockfile.toString('utf8'), workspaceRoot));
    fs.rmSync(outputPackage, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });

    runPnpm(workspaceRoot, [
      '--filter', runtime.packageName,
      '--prod',
      '--offline',
      '--config.inject-workspace-packages=true',
      'deploy',
      outputPackage,
    ]);

    if (service === 'orchestrator') {
      const adminWebDist = path.join(workspaceRoot, 'apps', 'admin-web', 'dist');
      if (!fs.existsSync(path.join(adminWebDist, 'index.html'))) {
        throw new Error('Admin Portal build output is missing; build @du/admin-web before packaging Orchestrator.');
      }
      fs.cpSync(adminWebDist, path.join(outputPackage, 'admin-web'), { recursive: true });
    }
  } finally {
    for (const [manifestPath, contents] of originals) fs.writeFileSync(manifestPath, contents);
    fs.writeFileSync(lockfile, originalLockfile);
  }
}

if (require.main === module) {
  const [service, output, ...extra] = process.argv.slice(2);
  if (!service || !output || extra.length > 0) {
    process.stderr.write('Usage: node scripts/docker-build-runtime.cjs <orchestrator|connector> <output-directory>\n');
    process.exitCode = 2;
  } else {
    try {
      buildRuntime(service, path.resolve(__dirname, '..'), output);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Runtime packaging failed.'}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { buildRuntime, packageFilesFor, withInjectWorkspacePackages, workspacePackages };

/** Builds only runtime workspace dependencies, then creates a portable deploy. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICES = {
  orchestrator: 'orchestrator/services/orchestrator',
  connector: 'orchestrator/services/connector',
  'document-core': 'businesses/document-core',
  'lc-checker': 'businesses/lc-checker',
  'example-review': 'businesses/example-review',
};

function workspaceManifests(root) {
  const entries = new Map();
  const standaloneWorkspace = fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))
    && fs.existsSync(path.join(root, 'vendor'));
  const groups = standaloneWorkspace
    ? ['.', 'vendor']
    : ['orchestrator/packages', 'orchestrator/services', 'orchestrator/apps'];
  for (const group of groups) {
    if (group === '.') {
      const file = path.join(root, 'package.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      entries.set(manifest.name, { dir: root, file, manifest });
      continue;
    }
    if (!fs.existsSync(path.join(root, group))) continue;
    for (const dir of fs.readdirSync(path.join(root, group))) {
      const file = path.join(root, group, dir, 'package.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      entries.set(manifest.name, { dir: path.dirname(file), file, manifest });
    }
  }
  return entries;
}

function buildPlan(entries, name) {
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(current) {
    if (visited.has(current)) return;
    if (visiting.has(current)) throw new Error(`Runtime dependency cycle: ${current}`);
    const entry = entries.get(current);
    if (!entry) throw new Error(`Missing workspace dependency: ${current}`);
    visiting.add(current);
    for (const [dependency, version] of Object.entries(entry.manifest.dependencies ?? {})) {
      if (version.startsWith('workspace:')) visit(dependency);
    }
    visiting.delete(current);
    visited.add(current);
    order.push(current);
  }
  visit(name);
  return order;
}

// CR10-01: `registerLdb03ContextProvider()` runs at boot and resolves
// `<root>/scripts/ldba-context-provider.cjs` (relative to the compiled bootstrap
// module, so `<deploy>/scripts/...` in the image). The deploy `files` allowlist
// below packs only dist + migrations, so the default image shipped without the
// provider and every boot refused. Ship exactly that one file instead of
// relaxing the allowlist to `scripts`: that directory also holds migration CLIs
// and test harnesses which must stay out of the runtime image.
const RUNTIME_EXTRA_FILES = {
  orchestrator: ['scripts/ldba-context-provider.cjs'],
};

function copyRuntimeExtraFiles(service, packageDirectory, output) {
  for (const relative of RUNTIME_EXTRA_FILES[service] ?? []) {
    const source = path.join(packageDirectory, relative);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing runtime artifact for ${service}: ${relative}`);
    }
    const destination = path.join(output, service, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function run(root, args) {
  let command = 'pnpm';
  let commandArgs = args;
  if (process.platform === 'win32') {
    // Node does not execute pnpm.cmd directly without a shell. Resolve the
    // Corepack JS entry point from the installed Windows shim instead, keeping
    // arguments out of a shell command string.
    const where = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8', windowsHide: true });
    const shims = where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean) : [];
    const cli = shims
      .map((shim) => path.resolve(path.dirname(shim), 'node_modules/corepack/dist/pnpm.js'))
      .find((candidate) => fs.existsSync(candidate));
    if (!cli) throw new Error('Could not locate the pnpm Corepack entry point on Windows.');
    command = process.execPath;
    commandArgs = [cli, ...args];
  }
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed (exit ${result.status ?? 'unknown'})`);
}

function deploymentLockfile(lock, root = process.cwd()) {
  // Deploy resolves local tarballs relative to its output directory. Keep the
  // pinned integrity, but point build-only resolutions at the source artifact
  // so offline deployment does not look for /deploy/<worker>/vendor.
  lock = lock.replace(/tarball: file:([^,}\r\n]+)/g, (_match, file) =>
    `tarball: file:${path.resolve(root, file).split(path.sep).join('/')}`);
  if (!/^settings:\r?\n/m.test(lock)) throw new Error('Lockfile settings are missing');
  if (/^  injectWorkspacePackages:/m.test(lock)) {
    return lock.replace(/^  injectWorkspacePackages:.*$/m, '  injectWorkspacePackages: true');
  }
  return lock.replace(/^settings:\r?\n/m, 'settings:\n  injectWorkspacePackages: true\n');
}

function buildStandaloneRuntime(service, root, output) {
  const currentRoot = path.resolve(root);
  const isWorkerWorkspace = fs.existsSync(path.join(currentRoot, 'pnpm-workspace.yaml'))
    && fs.existsSync(path.join(currentRoot, 'vendor'));
  const workspaceRoot = isWorkerWorkspace ? currentRoot : path.join(root, SERVICES[service]);
  const name = `@du/${service}`;
  const entries = workspaceManifests(workspaceRoot);
  if (!entries.has(name)) throw new Error(`Missing standalone workspace package: ${name}`);

  run(workspaceRoot, ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--prod=false']);
  // Each standalone worker's root build script already builds its vendored
  // dependency graph in order. Invoke it from the worker directory without a
  // pnpm workspace filter: when this helper runs inside the monorepo Docker
  // context, pnpm may resolve filters against the enclosing workspace and
  // silently fail to select the nested standalone worker package.
  buildPlan(entries, name); // Validate that the runtime workspace graph is complete and acyclic.
  run(workspaceRoot, ['run', 'build']);

  const originalManifests = new Map([...entries.values()].map((entry) => [entry.file, fs.readFileSync(entry.file)]));
  const stageRoot = fs.mkdtempSync(path.join(workspaceRoot, '.deploy-stage-'));
  const stageTarget = path.relative(workspaceRoot, path.join(stageRoot, service));
  try {
    // Build-container metadata only: deploy copies runtime output and leaves
    // source and test suites outside the final worker image. Restore exact host
    // bytes even if deploy fails, because this helper is also run on dev hosts.
    for (const entry of entries.values()) {
      fs.writeFileSync(entry.file, JSON.stringify({ ...entry.manifest, files: ['dist', 'migrations'] }, null, 2) + '\n');
    }
    // Worker workspaces own their lockfiles and local tarballs. Their verified
    // legacy deploy path resolves these directly; rewriting file: resolutions
    // to an absolute host path breaks Windows deploy and needlessly dirties the
    // standalone lockfile during an ordinary host-side packaging check. pnpm's
    // deploy target is also resolved relative to the workspace on Windows, so
    // deploy into a local staging directory before copying to the caller's
    // requested output location.
    run(workspaceRoot, ['--filter', name, 'deploy', '--prod', '--legacy', '--offline', stageTarget]);
    const deployedPackage = path.join(stageRoot, service);
    const outputRoot = path.resolve(output);
    const outputPackage = path.resolve(outputRoot, service);
    if (path.dirname(outputPackage) !== outputRoot || path.basename(outputPackage) !== service) {
      throw new Error('Invalid deployment output path.');
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.rmSync(outputPackage, { recursive: true, force: true });
    fs.cpSync(deployedPackage, outputPackage, { recursive: true });
  } finally {
    for (const [file, contents] of originalManifests) fs.writeFileSync(file, contents);
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

function buildRuntime(service, root = process.cwd(), output = '/deploy') {
  if (!Object.hasOwn(SERVICES, service)) throw new Error(`Unknown Docker service: ${service}`);
  if (['document-core', 'lc-checker', 'example-review'].includes(service)) {
    buildStandaloneRuntime(service, root, output);
    return;
  }
  const entries = workspaceManifests(root);
  const name = `@du/${service}`;
  for (const dependency of buildPlan(entries, name)) run(root, ['--filter', dependency, 'build']);

  if (service === 'connector') {
    const directory = entries.get(name).dir;
    fs.cpSync(path.join(directory, 'src/db/migrations'), path.join(directory, 'dist/db/migrations'), { recursive: true });
  }

  // Build-container metadata only: deploy copies dist despite repository gitignore.
  // Neither source nor test suites are shipped into the final runtime image.
  for (const entry of entries.values()) {
    fs.writeFileSync(entry.file, JSON.stringify({ ...entry.manifest, files: ['dist', 'migrations'] }, null, 2) + '\n');
  }
  fs.mkdirSync(output, { recursive: true });
  // pnpm's frozen shared-lockfile deployment requires this build-only setting.
  // No resolved versions change; createDeployFiles turns workspace links into
  // portable file snapshots. The repository lockfile is never rewritten.
  const lockfile = path.join(root, 'pnpm-lock.yaml');
  const lock = fs.readFileSync(lockfile, 'utf8');
  fs.writeFileSync(lockfile, deploymentLockfile(lock, root));
  run(root, ['--filter', name, '--prod', '--offline', '--config.inject-workspace-packages=true', 'deploy', path.join(output, service)]);
  if (service === 'orchestrator') {
    run(root, ['--filter', '@du/admin-web', 'build']);
    fs.cpSync(path.join(root, 'orchestrator/apps/admin-web/dist'), path.join(output, service, 'admin-web'), { recursive: true });
  }
  copyRuntimeExtraFiles(service, entries.get(name).dir, output);
}

module.exports = {
  SERVICES,
  workspaceManifests,
  buildPlan,
  deploymentLockfile,
  RUNTIME_EXTRA_FILES,
  copyRuntimeExtraFiles,
  buildStandaloneRuntime,
};
if (require.main === module) {
  try { buildRuntime(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

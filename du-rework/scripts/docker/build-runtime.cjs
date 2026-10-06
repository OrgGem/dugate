/** Builds only runtime workspace dependencies, then creates a portable deploy. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICES = {
  orchestrator: 'services/orchestrator',
  connector: 'services/connector',
  'document-core': 'businesses/document-core',
  'lc-checker': 'businesses/lc-checker',
  'example-review': 'businesses/example-review',
};

function workspaceManifests(root) {
  const entries = new Map();
  for (const group of ['packages', 'services', 'businesses']) {
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

function run(root, args) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed (exit ${result.status})`);
}

function deploymentLockfile(lock, root = process.cwd()) {
  // Deploy resolves local tarballs relative to its output directory. Keep the
  // pinned integrity, but point build-only resolutions at the source artifact
  // so offline worker deployment does not look for /deploy/<worker>/vendor.
  lock = lock.replace(/tarball: file:vendor\/([^,}\r\n]+)/g, (_match, file) =>
    `tarball: file:${path.join(root, 'vendor', file).split(path.sep).join('/')}`);
  if (!/^settings:\r?\n/m.test(lock)) throw new Error('Lockfile settings are missing');
  if (/^  injectWorkspacePackages:/m.test(lock)) {
    return lock.replace(/^  injectWorkspacePackages:.*$/m, '  injectWorkspacePackages: true');
  }
  return lock.replace(/^settings:\r?\n/m, 'settings:\n  injectWorkspacePackages: true\n');
}

function buildRuntime(service, root = process.cwd(), output = '/deploy') {
  if (!Object.hasOwn(SERVICES, service)) throw new Error(`Unknown Docker service: ${service}`);
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
    fs.cpSync(path.join(root, 'apps/admin-web/dist'), path.join(output, service, 'admin-web'), { recursive: true });
  }
}

module.exports = { SERVICES, workspaceManifests, buildPlan, deploymentLockfile };
if (require.main === module) {
  try { buildRuntime(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

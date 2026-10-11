/* DSH2 independent probe for CR10-01 packaging. READ-ONLY on the repo:
   writes only into os.tmpdir() and two temporary dirs inside the orchestrator
   package that are removed in finally blocks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// The ambient shell exports a half-built GIT_CONFIG_COUNT chain which makes every
// git invocation fail with 'missing config key GIT_CONFIG_KEY_0'. Sanitize it.
const GIT_ENV = { ...process.env };
for (const key of Object.keys(GIT_ENV)) {
  if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete GIT_ENV[key];
}
function git(args) {
  return execFileSync('git', ['-C', 'D:/Git/dugate', ...args], { encoding: 'utf8', env: GIT_ENV });
}

const REPO = 'D:/Git/dugate/du-rework';
const PKG = path.join(REPO, 'orchestrator/services/orchestrator');
const SCRIPT = path.join(REPO, 'scripts/docker/build-runtime.cjs');
const PROVIDER_RELATIVE = 'scripts/ldba-context-provider.cjs';
const COMPILED_BOOTSTRAP_RELATIVE = 'dist/app/bootstrap';
const REQUIRED = [
  'prepareConnector', 'resolveProfileName', 'normalizeConnectionsOverride',
  'prepareWorkflowSchema', 'readFileCacheBytes', 'artifactTokenFor', 'artifactPurposeFor',
];
const results = [];
function ok(name, detail) { results.push({ name, pass: true, detail }); }
function fail(name, error) { results.push({ name, pass: false, detail: String(error && error.message || error) }); }
function check(name, fn) { try { const d = fn(); ok(name, d === undefined ? '' : d); } catch (e) { fail(name, e); } }
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const mod = require(SCRIPT);
const source = fs.readFileSync(SCRIPT, 'utf8');

// ---- A. allowlist bounds -------------------------------------------------
check('A1 RUNTIME_EXTRA_FILES is exactly one service with exactly one file', () => {
  assert.deepEqual(Object.keys(mod.RUNTIME_EXTRA_FILES), ['orchestrator']);
  assert.deepEqual(mod.RUNTIME_EXTRA_FILES.orchestrator, [PROVIDER_RELATIVE]);
  return 'orchestrator -> [' + PROVIDER_RELATIVE + ']';
});

check('A2 the deploy allowlist literal is dist+migrations and appears once', () => {
  const hits = source.split("files: ['dist', 'migrations']").length - 1;
  assert.equal(hits, 1, 'allowlist literal count=' + hits);
  return 'files: [dist, migrations] x1';
});

check('A3 extras are copied AFTER pnpm deploy and after the admin-web copy', () => {
  const deployAt = source.indexOf("deploy', path.join(output, service)");
  const adminAt = source.indexOf("path.join(output, service, 'admin-web')");
  const copyAt = source.indexOf('copyRuntimeExtraFiles(service, entries.get(name).dir, output)');
  assert.ok(deployAt > 0 && adminAt > 0 && copyAt > 0, 'anchors missing');
  assert.ok(copyAt > deployAt && copyAt > adminAt, 'copy must run last');
  return 'deploy@' + deployAt + ' admin-web@' + adminAt + ' copy@' + copyAt;
});

check('A4 every service: only orchestrator ships an extra file', () => {
  const out = tmp('dsh2-extras-');
  const seen = {};
  try {
    for (const [service, dir] of Object.entries(mod.SERVICES)) {
      const target = path.join(REPO, dir);
      mod.copyRuntimeExtraFiles(service, target, out);
      const serviceRoot = path.join(out, service);
      const files = fs.existsSync(serviceRoot)
        ? fs.readdirSync(serviceRoot, { recursive: true }).filter((f) => fs.statSync(path.join(serviceRoot, f)).isFile())
        : [];
      seen[service] = files.map((f) => String(f).split(path.sep).join('/'));
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  assert.deepEqual(seen.orchestrator, [PROVIDER_RELATIVE]);
  for (const service of Object.keys(mod.SERVICES)) {
    if (service !== 'orchestrator') assert.deepEqual(seen[service], [], service + ' shipped ' + JSON.stringify(seen[service]));
  }
  return JSON.stringify(seen);
});

check('A5 missing provider fails loudly with the exact artifact name', () => {
  const out = tmp('dsh2-absent-');
  try {
    assert.throws(
      () => mod.copyRuntimeExtraFiles('orchestrator', path.join(out, 'absent-package'), out),
      (e) => e.message === 'Missing runtime artifact for orchestrator: ' + PROVIDER_RELATIVE,
    );
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  return 'threw with exact message';
});

check('A6 shipped provider is byte-identical to the source provider', () => {
  const out = tmp('dsh2-bytes-');
  try {
    mod.copyRuntimeExtraFiles('orchestrator', PKG, out);
    const shipped = path.join(out, 'orchestrator', PROVIDER_RELATIVE);
    assert.equal(sha(shipped), sha(path.join(PKG, PROVIDER_RELATIVE)));
    return 'sha256 ' + sha(shipped).slice(0, 16) + '…';
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ---- B. the three __dirname escapes vs the shipped bounds ---------------
check('B1 provider escape resolves inside the shipped image', () => {
  const out = tmp('dsh2-esc-');
  try {
    mod.copyRuntimeExtraFiles('orchestrator', PKG, out);
    const imageRoot = path.join(out, 'orchestrator');
    const bootstrapDir = path.join(imageRoot, COMPILED_BOOTSTRAP_RELATIVE);
    fs.mkdirSync(bootstrapDir, { recursive: true });
    const resolved = path.resolve(bootstrapDir, '..', '..', '..', PROVIDER_RELATIVE);
    assert.ok(resolved.startsWith(imageRoot), resolved);
    assert.ok(fs.existsSync(resolved), 'not shipped: ' + resolved);
    return resolved.split(path.sep).slice(-3).join('/');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

check('B2 migrations escape is inside the allowlist bound (package-root migrations/)', () => {
  const migrations = path.join(PKG, 'migrations');
  assert.ok(fs.existsSync(migrations), 'migrations dir missing');
  const sql = fs.readdirSync(migrations).filter((f) => f.endsWith('.sql'));
  assert.ok(sql.length > 0, 'no sql migrations');
  const resolvedFromDistDb = path.resolve(path.join(PKG, 'dist/db'), '..', '..', 'migrations');
  assert.equal(resolvedFromDistDb, migrations, 'dist/db escape must land on the packaged migrations dir');
  return sql.length + ' sql files at package-root migrations/';
});

check('B3 admin-web is shipped at the path the image env points to', () => {
  const dockerfile = fs.readFileSync(path.join(PKG, 'Dockerfile'), 'utf8');
  const envLine = /^ENV DU_ADMIN_WEB_DIST=(.+)$/m.exec(dockerfile);
  assert.ok(envLine, 'DU_ADMIN_WEB_DIST not set in the image');
  assert.equal(envLine[1].trim(), '/app/admin-web');
  assert.ok(/^WORKDIR \/app$/m.test(dockerfile), 'WORKDIR /app missing');
  assert.ok(/COPY --from=orchestrator-build --chown=node:node \/deploy\/orchestrator \.\//.test(dockerfile),
    'the deploy root must land at /app');
  assert.ok(source.includes("path.join(output, service, 'admin-web')"), 'build script must copy admin-web');
  return 'env=/app/admin-web, deploy root=/app, script copies <output>/<service>/admin-web';
});

// ---- C. provider loadability -------------------------------------------
check('C1 shipped provider exports every required callback', () => {
  const out = tmp('dsh2-load-');
  try {
    mod.copyRuntimeExtraFiles('orchestrator', PKG, out);
    const policy = require(path.join(out, 'orchestrator', PROVIDER_RELATIVE));
    assert.equal(typeof policy, 'object');
    assert.ok(!Array.isArray(policy));
    for (const name of REQUIRED) assert.equal(typeof policy[name], 'function', name);
    return REQUIRED.length + ' callbacks callable';
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

check('C2 provider requires only node builtins; the seam require is env-gated', () => {
  const providerSource = fs.readFileSync(path.join(PKG, PROVIDER_RELATIVE), 'utf8');
  const literals = [...providerSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const nonBuiltin = literals.filter((s) => !s.startsWith('node:'));
  assert.deepEqual(nonBuiltin, [], 'non-builtin requires: ' + JSON.stringify(nonBuiltin));
  const dynamic = [...providerSource.matchAll(/require\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(dynamic, ['modulePath'], 'unexpected dynamic requires: ' + JSON.stringify(dynamic));
  assert.ok(providerSource.includes('LDBA03_METADATA_SEAM_MODULE'), 'seam env name missing');
  assert.ok(providerSource.includes('DU_ENCRYPTION_METADATA_ENABLED'), 'metadata enable guard missing');
  assert.ok(providerSource.includes('LDBA03_METADATA_KEY_REF'), 'key ref guard missing');
  const guardAt = providerSource.indexOf("!== 'true'");
  const requireAt = providerSource.indexOf('require(modulePath)');
  assert.ok(guardAt > 0 && requireAt > guardAt, 'seam require must sit after the enable guard');
  return literals.length + ' literal requires all node:*, 1 env-gated dynamic require';
});

check('C3 provider file is a .cjs shipped verbatim (no build step required)', () => {
  const st = fs.statSync(path.join(PKG, PROVIDER_RELATIVE));
  assert.ok(st.size > 1000, 'suspiciously small');
  assert.ok(!fs.existsSync(path.join(PKG, 'dist', PROVIDER_RELATIVE)), 'must not depend on a compiled copy');
  return st.size + ' bytes';
});

// ---- D. independent compiled-boot proof --------------------------------
function imageLayout(name, withProvider) {
  const dist = path.join(PKG, 'dist');
  const deployRoot = path.join(PKG, name);
  const imageRoot = path.join(deployRoot, 'orchestrator');
  fs.rmSync(deployRoot, { recursive: true, force: true });
  fs.mkdirSync(imageRoot, { recursive: true });
  fs.cpSync(dist, path.join(imageRoot, 'dist'), { recursive: true });
  if (withProvider) mod.copyRuntimeExtraFiles('orchestrator', PKG, deployRoot);
  return { deployRoot, imageRoot };
}

check('D1 compiled bootstrap registers the provider from the packaged layout', () => {
  const { deployRoot, imageRoot } = imageLayout('.dsh2-cr10-01-image', true);
  try {
    const compiled = require(path.join(imageRoot, COMPILED_BOOTSTRAP_RELATIVE, 'create-app.js'));
    const env = {};
    const registration = compiled.registerLdb03ContextProvider(env);
    assert.equal(env.LDBA03_CONTEXT_MODULE, registration.modulePath);
    assert.ok(registration.modulePath.startsWith(imageRoot), 'resolved outside the image: ' + registration.modulePath);
    assert.equal(registration.modulePath, path.join(imageRoot, PROVIDER_RELATIVE));
    for (const name of REQUIRED) assert.equal(typeof registration.provider[name], 'function', name);
    return 'modulePath=' + registration.modulePath.split(path.sep).slice(-2).join('/') + ' env key set';
  } finally { fs.rmSync(deployRoot, { recursive: true, force: true }); }
});

check('D2 an image without the provider refuses to boot with the exact message', () => {
  const { deployRoot, imageRoot } = imageLayout('.dsh2-cr10-01-image-absent', false);
  try {
    assert.ok(!fs.existsSync(path.join(imageRoot, PROVIDER_RELATIVE)), 'provider must be absent');
    const compiled = require(path.join(imageRoot, COMPILED_BOOTSTRAP_RELATIVE, 'create-app.js'));
    assert.throws(() => compiled.registerLdb03ContextProvider({}),
      (e) => e.message === 'refusing to boot: LDBA03 context provider module could not be loaded');
    return 'threw the documented refusal';
  } finally { fs.rmSync(deployRoot, { recursive: true, force: true }); }
});

check('D3 the compiled bootstrap artifact is newer than its source', () => {
  const srcStat = fs.statSync(path.join(PKG, 'src/app/bootstrap/create-app.ts'));
  const distStat = fs.statSync(path.join(PKG, 'dist/app/bootstrap/create-app.js'));
  assert.ok(distStat.mtimeMs >= srcStat.mtimeMs, 'dist is older than src');
  return 'src ' + srcStat.mtime.toISOString() + ' <= dist ' + distStat.mtime.toISOString();
});

// ---- E. is the lockfile failure attributable to the CR10-01 diff? -------
check('E1 HEAD build-runtime.cjs reproduces the same deploymentLockfile output', () => {
  const headSource = git(['show', 'HEAD:du-rework/scripts/docker/build-runtime.cjs']);
  const headFile = path.join(tmp('dsh2-head-'), 'build-runtime.cjs');
  fs.writeFileSync(headFile, headSource);
  const headMod = require(headFile);
  const lock = fs.readFileSync(path.join(REPO, 'pnpm-lock.yaml'), 'utf8');
  const headOut = headMod.deploymentLockfile(lock, REPO);
  const workOut = mod.deploymentLockfile(lock, REPO);
  assert.equal(headOut, workOut, 'HEAD and worktree disagree on the lockfile transform');
  assert.ok(!Object.hasOwn(headMod, 'RUNTIME_EXTRA_FILES'), 'HEAD must not carry the CR10-01 extras');
  fs.rmSync(path.dirname(headFile), { recursive: true, force: true });
  return 'identical transform (len ' + workOut.length + '); HEAD has no extras export';
});

check('E2 the failing lockfile/compose inputs are unmodified vs HEAD', () => {
  const paths = ['du-rework/pnpm-lock.yaml', 'du-rework/docker-compose.yml', 'du-rework/compose',
    'du-rework/tests/deployment/docker.test.cjs'];
  const dirty = git(['status', '--porcelain', '--', ...paths]).trim();
  assert.equal(dirty, '', 'dirty inputs: ' + dirty);
  const composeFragment = fs.readFileSync(path.join(REPO, 'compose/orchestrator.yml'), 'utf8');
  assert.ok(/^\s+ORCHESTRATOR_PORT: '3000'$/m.test(composeFragment), 'expected the pre-existing ORCHESTRATOR_PORT line');
  return 'clean inputs; compose/orchestrator.yml sets ORCHESTRATOR_PORT 3000 (pre-existing)';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;

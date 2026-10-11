const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RUNTIME_EXTRA_FILES, copyRuntimeExtraFiles } = require('../../scripts/docker/build-runtime.cjs');

// CR10-01: the runtime entrypoint validates the LDBA03 context policy module at
// boot and refuses to start when it cannot be loaded. The deploy allowlist packs
// only dist + migrations, so the default image shipped without the provider and
// every boot failed. These tests pin both halves of that contract: the packaging
// ships the file, and the compiled entrypoint finds it in the image layout.

const root = path.resolve(__dirname, '../..');
const packageDirectory = path.join(root, 'orchestrator/services/orchestrator');
const PROVIDER_RELATIVE = 'scripts/ldba-context-provider.cjs';
// create-app.ts resolves three levels up from the COMPILED bootstrap module, so
// the deploy root must carry scripts/ next to dist/ for the image to boot.
const COMPILED_BOOTSTRAP_RELATIVE = 'dist/app/bootstrap';
const REQUIRED_CALLBACKS = [
  'prepareConnector',
  'resolveProfileName',
  'normalizeConnectionsOverride',
  'prepareWorkflowSchema',
  'readFileCacheBytes',
  'artifactTokenFor',
  'artifactPurposeFor',
];

function temporaryOutput() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'du-runtime-extra-'));
}

// The image layout lives inside the package so Node resolves workspace
// dependencies through the real node_modules chain while __dirname stays inside
// the simulated deploy root. A junction would defeat this: Node resolves symlinks
// to their realpath, so the module would read the source tree instead.
// copyRuntimeExtraFiles writes <output>/<service>/<relative>, so the simulated
// deploy root must carry that service directory, exactly like /deploy/<service>.
function imageLayout(name, withProvider) {
  const dist = path.join(packageDirectory, 'dist');
  assert.ok(
    fs.existsSync(path.join(dist, 'app/bootstrap/create-app.js')),
    'build the orchestrator first (tsc -p tsconfig.json in services/orchestrator); '
      + 'the boot-path proof runs the real compiled registration',
  );
  const deployRoot = path.join(packageDirectory, name);
  const imageRoot = path.join(deployRoot, 'orchestrator');
  fs.rmSync(deployRoot, { recursive: true, force: true });
  fs.mkdirSync(imageRoot, { recursive: true });
  fs.cpSync(dist, path.join(imageRoot, 'dist'), { recursive: true });
  if (withProvider) copyRuntimeExtraFiles('orchestrator', packageDirectory, deployRoot);
  return { deployRoot, imageRoot };
}

test('CR10-01: the orchestrator declares the context provider as a runtime artifact', () => {
  assert.ok(Array.isArray(RUNTIME_EXTRA_FILES.orchestrator),
    'orchestrator must declare the extra runtime artifacts it boots from');
  assert.ok(RUNTIME_EXTRA_FILES.orchestrator.includes(PROVIDER_RELATIVE),
    'orchestrator must ship ' + PROVIDER_RELATIVE + '; without it every boot refuses to start');
});

test('CR10-01: the shipped path is exactly what the compiled bootstrap module resolves', () => {
  const output = temporaryOutput();
  try {
    copyRuntimeExtraFiles('orchestrator', packageDirectory, output);
    const deployRoot = path.join(output, 'orchestrator');
    const shipped = path.join(deployRoot, PROVIDER_RELATIVE);
    assert.ok(fs.existsSync(shipped), shipped + ' must exist in the deployment output');
    const bootstrap = path.join(deployRoot, COMPILED_BOOTSTRAP_RELATIVE);
    fs.mkdirSync(bootstrap, { recursive: true });
    assert.equal(path.resolve(bootstrap, '..', '..', '..', PROVIDER_RELATIVE), shipped,
      'the deploy output layout must satisfy the bootstrap default resolution');
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('CR10-01: the shipped provider loads and exposes every required callback', () => {
  const output = temporaryOutput();
  try {
    copyRuntimeExtraFiles('orchestrator', packageDirectory, output);
    const policy = require(path.join(output, 'orchestrator', PROVIDER_RELATIVE));
    assert.equal(typeof policy, 'object');
    for (const callback of REQUIRED_CALLBACKS) {
      assert.equal(typeof policy[callback], 'function', callback + ' must stay callable');
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('CR10-01: packaging fails loudly when the provider is missing instead of shipping a broken image', () => {
  const output = temporaryOutput();
  try {
    assert.throws(
      () => copyRuntimeExtraFiles('orchestrator', path.join(output, 'absent-package'), output),
      /Missing runtime artifact for orchestrator/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('CR10-01: services without declared extras ship nothing extra', () => {
  const output = temporaryOutput();
  try {
    copyRuntimeExtraFiles('connector', packageDirectory, output);
    copyRuntimeExtraFiles('document-core', path.join(root, 'businesses/document-core'), output);
    assert.deepEqual(fs.readdirSync(output), []);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

// Boot-path proof: drive the REAL compiled registration from a simulated image
// layout, so the production failure mode is reproduced directly instead of
// being inferred from path arithmetic alone.
test('CR10-01: the packaged image layout lets the compiled entrypoint register the provider', () => {
  const { deployRoot, imageRoot } = imageLayout('.cr10-01-image-sim', true);
  try {
    const compiled = require(path.join(imageRoot, COMPILED_BOOTSTRAP_RELATIVE, 'create-app.js'));
    const env = {};
    const registration = compiled.registerLdb03ContextProvider(env);
    assert.equal(env.LDBA03_CONTEXT_MODULE, registration.modulePath,
      'registration must publish the absolute provider path for the adapter');
    for (const callback of REQUIRED_CALLBACKS) {
      assert.equal(typeof registration.provider[callback], 'function', callback + ' must be registered at boot');
    }
    assert.ok(registration.modulePath.startsWith(imageRoot),
      'the provider must resolve inside the packaged image, not the source tree');
  } finally {
    fs.rmSync(deployRoot, { recursive: true, force: true });
  }
});

test('CR10-01: an image built without the provider still refuses to boot loudly', () => {
  const { deployRoot, imageRoot } = imageLayout('.cr10-01-image-sim-absent', false);
  try {
    const compiled = require(path.join(imageRoot, COMPILED_BOOTSTRAP_RELATIVE, 'create-app.js'));
    assert.throws(() => compiled.registerLdb03ContextProvider({}),
      /refusing to boot: LDBA03 context provider module could not be loaded/);
  } finally {
    fs.rmSync(deployRoot, { recursive: true, force: true });
  }
});

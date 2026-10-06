const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'du-dev-check-'));
const envFile = path.join(temp, 'config with space=local.env');
const runner = path.join(root, 'scripts/dev.cjs');
let count = 0;
async function run(args) {
  const env = { ...process.env };
  for (const key of ['RUNTIME_URL','CONNECTOR_URL','ORCHESTRATOR_PORT','ORCHESTRATOR_INTERNAL_PORT','ADMIN_SHELL_PORT','CONNECTOR_PORT','ORCHESTRATOR_INTERNAL_BASE_URL']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, `--env-file=${envFile}`, ...args], { cwd: os.tmpdir(), env });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}
async function check(name, args, code, pattern) {
  const result = await run(args);
  assert.equal(result.code, code, name + ': ' + result.output);
  assert.match(result.output, pattern);
  console.log('PASS ' + name); count++;
}
(async () => {
  fs.writeFileSync(envFile, '');
  await check('side-effect-free topology from any cwd and path with spaces/equal', ['--check'], 0, /Internal API: http:\/\/127.0.0.1:3002/);
  await check('all three workers by default', ['--check'], 0, /Workers: document-core, lc-checker, example-review/);
  await check('single worker', ['--check','--workers=lc-checker'], 0, /Workers: lc-checker/);
  await check('no workers', ['--check','--workers=none'], 0, /Workers: none/);
  await check('reject unknown worker', ['--check','--workers=unknown'], 1, /Invalid worker/);
  await check('reject typo flag', ['--unknown'], 1, /Unknown dev/);
  fs.writeFileSync(envFile, 'RUNTIME_URL=http://127.0.0.1:3000/api/runtime/v1\n');
  await check('reject legacy public Runtime URL', ['--check'], 1, /RUNTIME_URL points/);
  fs.writeFileSync(envFile, 'CONNECTOR_PORT=3002\n');
  await check('reject conflicting listener configuration', ['--check'], 1, /Listener ports/);
  fs.writeFileSync(envFile, 'RUNTIME_URL=SECRET_SENTINEL\n');
  const invalid = await run(['--check']); assert.equal(invalid.code, 1); assert.ok(!invalid.output.includes('SECRET_SENTINEL')); count++; console.log('PASS invalid URL does not disclose configuration');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(envFile, `ORCHESTRATOR_PORT=${port}\n`);
  try { await check('occupied port aborts before build/migration without killing owner', ['--skip-build','--skip-migrate'], 1, /occupied/); assert.equal(server.listening, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
  console.log(`${count} checks passed; no database or real service started`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));

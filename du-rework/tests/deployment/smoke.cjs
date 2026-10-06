/** Requires an already running isolated stack; never starts or resets a project. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const filename = process.env.DU_SMOKE_ENV_FILE;
const project = process.env.DU_SMOKE_PROJECT;
if (!filename || !project?.startsWith('du-fix-')) throw new Error('Set isolated DU_SMOKE_ENV_FILE and DU_SMOKE_PROJECT=du-fix-*');
const env = Object.fromEntries(fs.readFileSync(filename, 'utf8').split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
function compose(args, input) {
  const result = spawnSync('docker', ['compose', '--env-file', filename, '-p', project, ...args],
    { cwd: root, encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const services = ['orchestrator', 'connector', 'document-core', 'lc-checker', 'example-review'];
for (const service of services) {
  test(`${service}: non-root, compiled code, complete production dependencies`, () => {
    const code = `
      const assert=require('node:assert/strict'), fs=require('node:fs');
      assert.equal(process.getuid(), 1000);
      const pkg=require('/app/package.json');
      assert.equal(pkg.name, '@du/${service}');
      assert.equal(fs.existsSync('/app/src'),false);
      assert.equal(fs.existsSync('/app/tests'),false);
      assert.throws(()=>require.resolve('typescript'),{code:'MODULE_NOT_FOUND'});
      for(const dep of Object.keys(pkg.dependencies || {})) require.resolve(dep);
      assert.ok(fs.existsSync('/app/dist/${service === 'connector' ? 'entrypoint' : 'main'}.js'));
      ${service === 'orchestrator' ? "assert.ok(fs.existsSync('/app/admin-web/index.html')); assert.ok(fs.readdirSync('/app/migrations').length > 0);" : ''}
      ${service === 'connector' ? "assert.ok(fs.readdirSync('/app/dist/db/migrations').some(f=>f.endsWith('.sql')));" : ''}
      console.log('runtime package verified');
    `;
    compose(['exec', '-T', service, 'node', '-'], code);
  });
}

test('migration job succeeds and every long-running process stays up without restarts', () => {
  const ids = compose(['ps', '-aq']).trim().split(/\r?\n/);
  const result = spawnSync('docker', ['inspect', ...ids], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const containers = JSON.parse(result.stdout);
  assert.equal(containers.length, 8);
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    if (service === 'migrate') {
      assert.equal(container.State.Status, 'exited');
      assert.equal(container.State.ExitCode, 0);
    } else {
      assert.equal(container.State.Running, true, service);
      assert.equal(container.RestartCount, 0, service);
      if (container.State.Health) assert.equal(container.State.Health.Status, 'healthy', service);
    }
  }
});

for (const service of services.slice(2)) {
  test(`${service}: reaches API, queue and Connector from its own network`, () => {
    compose(['exec', '-T', service, 'node', '-'], `
      const assert=require('node:assert/strict');
      (async()=>{
        const api=await fetch(new URL('/health',process.env.RUNTIME_URL)); assert.equal(api.status,200);
        const address=new URL(process.env.REDIS_URL);
        await new Promise((resolve,reject)=>{
          const socket=require('node:net').createConnection({host:address.hostname,port:Number(address.port||6379)});
          socket.setTimeout(5000,()=>socket.destroy(new Error('queue connectivity timeout')));
          socket.on('error',reject);
          socket.on('connect',()=>socket.write('*1\\r\\n$4\\r\\nPING\\r\\n'));
          socket.on('data',data=>{socket.end();try {assert.match(data.toString(),/PONG/);resolve();} catch(e) {reject(e);}});
        });
        if(process.env.CONNECTOR_URL) {
          const r=await fetch(process.env.CONNECTOR_URL+'/health/ready'); assert.equal(r.status,200);
          const authenticated=await fetch(process.env.CONNECTOR_URL+'/connectors', {
            headers:{authorization:'Bearer '+process.env.CONNECTOR_SERVICE_TOKEN}});
          assert.equal(authenticated.status,403); // invoke identity cannot manage connectors
          const body=await authenticated.json(); assert.ok(JSON.stringify(body).includes('BINDING_DENIED'));
        }
      })().catch(e=>{console.error(e);process.exitCode=1;});
    `);
  });
}

test('Admin shell authenticates with a Secure cookie and serves bundled JS/CSS', async () => {
  const base = `http://127.0.0.1:${env.ADMIN_SHELL_PORT}`;
  const anonymous = await fetch(base + '/admin/web', { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  const login = await fetch(base + '/admin/login');
  assert.equal(login.status, 200);
  const session = await fetch(base + '/admin/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
    body: new URLSearchParams({ token: env.ADMIN_TOKEN, redirect: '/admin/web' }) });
  assert.equal(session.status, 302);
  const setCookie = session.headers.get('set-cookie');
  assert.ok(setCookie.includes('Secure') && setCookie.includes('HttpOnly'));
  const cookie = setCookie.split(';')[0];
  const response = await fetch(base + '/admin/web', { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) {
    const bundled = await fetch(new URL(asset, base), { headers: { cookie } });
    assert.equal(bundled.status, 200, asset);
    assert.ok((await bundled.text()).length > 0);
  }
});

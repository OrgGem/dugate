/* DSH2 independent probe for AWEB-12 (Profiles table view). READ-ONLY on the repo.
   Loads the real TypeScript sources with a transpile hook so the assertions run
   against the working-tree code, not a compiled copy. Writes nothing to the repo. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ORCH = 'D:/Git/dugate/du-rework/orchestrator/services/orchestrator';
const WEB = 'D:/Git/dugate/du-rework/orchestrator/apps/admin-web';
const ts = require(path.join(ORCH, 'node_modules/typescript/lib/typescript.js'));

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      resolveJsonModule: true,
    },
  }).outputText;
  module._compile(out, filename);
};

const results = [];
function check(name, fn) {
  try { const d = fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}
async function checkAsync(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const profileList = require(path.join(ORCH, 'src/modules/admin-read/profile-list.ts'));
const webState = require(path.join(WEB, 'src/features/profiles/state.ts'));
const contracts = require(path.join(ORCH, 'node_modules/@du/contracts'));

function recordingDb(rows, countRows) {
  const calls = [];
  return {
    calls,
    db: {
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        const isCount = sql.startsWith('SELECT count(*)');
        return { rows: isCount ? (countRows ?? [{ total: '0' }]) : (rows ?? []), rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
    },
  };
}

// ---- A. query parser ----------------------------------------------------
check('A1 parses tenant+business+limit+sort and clamps limit', () => {
  const q = profileList.parseAdminProfileListQuery(new URLSearchParams(
    `tenantId=${TENANT_A}&businessId=document-core&limit=25&sort=updatedAt:desc`));
  assert.equal(q.tenantId, TENANT_A);
  assert.equal(q.businessId, 'document-core');
  assert.equal(q.limit, 25);
  assert.equal(q.sort, 'updatedAt:desc');
  const clamped = profileList.parseAdminProfileListQuery(new URLSearchParams(`tenantId=${TENANT_A}&limit=100000`));
  assert.equal(clamped.limit, contracts.ADMIN_LIST_LIMIT_MAX);
  const floored = profileList.parseAdminProfileListQuery(new URLSearchParams(`tenantId=${TENANT_A}&limit=0`));
  assert.equal(floored.limit, 1);
  return 'limit 25 ok; 100000 -> ' + clamped.limit + '; 0 -> ' + floored.limit;
});

check('A2 rejects repeated, malformed and hostile scope values with 422', () => {
  const cases = [
    [`tenantId=${TENANT_A}&tenantId=${TENANT_A}`, /must not be repeated/],
    ['tenantId=not-a-uuid', /must be a uuid/],
    [`tenantId=${TENANT_A}&businessId=${'x'.repeat(257)}`, /printable characters/],
    [`tenantId=${TENANT_A}&businessId=bad%00value`, /printable characters/],
    [`tenantId=${TENANT_A}&sort=evil:desc`, /sort must be one of/],
    [`tenantId=${TENANT_A}&cursor=not-a-cursor`, /cursor is not a valid sortable list cursor/],
  ];
  for (const [qs, pattern] of cases) {
    assert.throws(() => profileList.parseAdminProfileListQuery(new URLSearchParams(qs)),
      (e) => e.status === 422 && e.code === 'INVALID_SCHEMA' && pattern.test(e.message),
      'not rejected as 422 INVALID_SCHEMA: ' + qs);
  }
  return cases.length + ' hostile inputs -> 422 INVALID_SCHEMA';
});

check('A3 absent tenantId parses to null but the page function still demands a tenant', () => {
  const q = profileList.parseAdminProfileListQuery(new URLSearchParams('businessId=document-core'));
  assert.equal(q.tenantId, null);
  assert.equal(profileList.listAdminProfilePage.length, 3, 'listAdminProfilePage must take (db, tenantId, query)');
  const src = fs.readFileSync(path.join(ORCH, 'src/modules/admin-read/profile-list.ts'), 'utf8');
  assert.ok(/clauses = \['n\.tenant_id = \$1'\]/.test(src), 'tenant clause must be the first, unconditional clause');
  return 'parser lenient, executor requires a concrete tenant string';
});

// ---- B. SQL + keyset bounds --------------------------------------------
checkAsync('B1 tenant is always $1; business is optional $2; limit+1 is last', async () => {
  const noBiz = recordingDb();
  await profileList.listAdminProfilePage(noBiz.db, TENANT_A, profileList.parseAdminProfileListQuery(
    new URLSearchParams(`tenantId=${TENANT_A}&limit=100`)));
  assert.equal(noBiz.calls.length, 2, 'page + count');
  const page = noBiz.calls[0];
  assert.match(page.sql, /n\.tenant_id = \$1/);
  assert.ok(!/n\.business_id = \$\d/.test(page.sql), 'no business predicate expected');
  assert.deepEqual(page.params, [TENANT_A, 101]);
  assert.ok(!page.sql.includes(TENANT_A), 'tenant must be bound, never interpolated');
  assert.ok(!page.sql.includes('101'), 'limit must be bound, never interpolated');
  const counted = noBiz.calls[1];
  assert.match(counted.sql, /^SELECT count\(\*\)::int AS total FROM /);
  assert.match(counted.sql, /n\.tenant_id = \$1/);
  assert.deepEqual(counted.params, [TENANT_A]);

  const withBiz = recordingDb();
  await profileList.listAdminProfilePage(withBiz.db, TENANT_A, profileList.parseAdminProfileListQuery(
    new URLSearchParams(`tenantId=${TENANT_A}&businessId=document-core&limit=25`)));
  assert.match(withBiz.calls[0].sql, /n\.tenant_id = \$1 AND n\.business_id = \$2/);
  assert.deepEqual(withBiz.calls[0].params, [TENANT_A, 'document-core', 26]);
  assert.deepEqual(withBiz.calls[1].params, [TENANT_A, 'document-core']);
  return 'params: tenant-only [T,101]; tenant+business [T,doc-core,26]; count reuses filters';
});

checkAsync('B2 cursor values are bound params and the count query ignores them', async () => {
  const cursorId = '123e4567-e89b-42d3-a456-426614174000';
  const cursor = contracts.encodeAdminResourceListSortCursor({
    timestamp: '2026-10-10T08:00:00.000000Z', id: cursorId, direction: 'next', sort: 'updatedAt:desc',
  });
  const rec = recordingDb([], [{ total: '7' }]);
  const q = profileList.parseAdminProfileListQuery(new URLSearchParams(
    `tenantId=${TENANT_A}&businessId=document-core&limit=25&sort=updatedAt:desc&cursor=${encodeURIComponent(cursor)}`));
  assert.equal(q.cursor.id, cursorId);
  const result = await profileList.listAdminProfilePage(rec.db, TENANT_A, q);
  const page = rec.calls[0];
  assert.deepEqual(page.params, [TENANT_A, 'document-core', '2026-10-10T08:00:00.000000Z', cursorId, 26]);
  assert.match(page.sql, /::timestamptz, \$\d+::uuid/);
  assert.ok(!page.sql.includes(cursorId), 'cursor id must be bound, never interpolated');
  assert.deepEqual(rec.calls[1].params, [TENANT_A, 'document-core'], 'count must not carry cursor/limit');
  assert.equal(result.total, 7);
  assert.equal(result.nextCursor, null, 'no rows -> no next cursor');
  assert.equal(result.prevCursor, null, 'first page without cursor -> no prev cursor');
  return 'cursor bound as (timestamp, uuid); count filters only; total=7';
});

checkAsync('B3 nextCursor appears only when the probe row exists, prevCursor only after a cursor', async () => {
  const mkRow = (id, stamp) => ({
    profile_id: id, tenant_id: TENANT_A, business_id: 'document-core', business_version: '1.2.0',
    profile_name: 'p-' + id.slice(0, 4), revision: 3, enabled: true, key_count: 1,
    bound_actions: ['extract'], created_at: new Date(stamp), updated_at: new Date(stamp),
    created_at_cursor: stamp, updated_at_cursor: stamp,
  });
  const limit = 2;
  const rows = [mkRow('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '2026-10-10T09:00:00.000000Z'),
    mkRow('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '2026-10-10T08:00:00.000000Z'),
    mkRow('cccccccc-3333-4333-8333-cccccccccccc', '2026-10-10T07:00:00.000000Z')];
  const first = recordingDb(rows, [{ total: '9' }]);
  const page1 = await profileList.listAdminProfilePage(first.db, TENANT_A, profileList.parseAdminProfileListQuery(
    new URLSearchParams(`tenantId=${TENANT_A}&limit=${limit}&sort=updatedAt:desc`)));
  assert.equal(page1.rows.length, limit, 'probe row must be sliced off');
  assert.ok(page1.nextCursor !== null, 'next cursor expected');
  assert.equal(page1.prevCursor, null, 'page 1 must not advertise a previous link to itself');

  const second = recordingDb([rows[0]], [{ total: '9' }]);
  const page2 = await profileList.listAdminProfilePage(second.db, TENANT_A, profileList.parseAdminProfileListQuery(
    new URLSearchParams(`tenantId=${TENANT_A}&limit=${limit}&sort=updatedAt:desc&cursor=${encodeURIComponent(page1.nextCursor)}`)));
  assert.equal(page2.nextCursor, null, 'single row -> no next cursor');
  assert.ok(page2.prevCursor !== null, 'a page reached by cursor must offer a previous link');
  return 'page1 next only; page2 prev only; probe row not rendered';
});

checkAsync('B4 the SELECT list carries no key material and no secret columns', async () => {
  const rec = recordingDb();
  await profileList.listAdminProfilePage(rec.db, TENANT_A, profileList.parseAdminProfileListQuery(
    new URLSearchParams(`tenantId=${TENANT_A}`)));
  const sql = rec.calls[0].sql;
  const selectList = sql.slice(0, sql.indexOf(' FROM '));
  for (const forbidden of ['raw_key', 'key_hash', 'secret', 'prefix', 'api_key_id', 'token']) {
    assert.ok(!selectList.includes(forbidden), 'select list leaks ' + forbidden + ': ' + selectList);
  }
  assert.match(selectList, /active_binding\.enabled/);
  assert.match(selectList, /key_count/);
  assert.match(selectList, /ARRAY\[active_binding\.action\]::text\[\] AS bound_actions/);
  return 'select list: metadata + enabled + key_count + bound_actions only';
});

// ---- C. admin-web strict page gate -------------------------------------
const webRow = {
  tenantId: 'tenant-a', businessId: 'document-core', businessVersion: '1.2.0', profileName: 'default',
  revision: 3, status: 'ACTIVE', keyCount: 2, boundActions: ['extract'],
  createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-10T09:00:00.000Z',
};
check('C1 rejects rows outside the selected tenant or business scope', () => {
  const page = (items, extra = {}) => ({ items, total: items.length, limit: 10, nextCursor: null, prevCursor: null, ...extra });
  assert.equal(webState.parseProfileListPage(page([webRow]), 'tenant-b'), null, 'foreign tenant row accepted');
  assert.equal(webState.parseProfileListPage(page([webRow]), 'tenant-a', 'another-business'), null, 'foreign business row accepted');
  assert.ok(webState.parseProfileListPage(page([webRow]), 'tenant-a', 'document-core') !== null, 'in-scope row rejected');
  assert.ok(webState.parseProfileListPage(page([webRow])) !== null, 'unscoped call must still parse (documented)');
  return 'tenant/business mismatch -> null; match -> page';
});

check('C2 rejects malformed rows and page invariant violations', () => {
  const page = (items, extra = {}) => ({ items, total: items.length, limit: 10, nextCursor: null, prevCursor: null, ...extra });
  const bad = [
    ['negative keyCount', page([{ ...webRow, keyCount: -1 }])],
    ['revision 0', page([{ ...webRow, revision: 0 }])],
    ['unknown status', page([{ ...webRow, status: 'WHATEVER' }])],
    ['empty profileName', page([{ ...webRow, profileName: '' }])],
    ['non-array boundActions', page([{ ...webRow, boundActions: 'extract' }])],
    ['empty bound action', page([{ ...webRow, boundActions: [''] }])],
    ['total below item count', page([webRow], { total: 0 })],
    ['limit below 1', page([webRow], { limit: 0 })],
    ['more items than limit', page([webRow, { ...webRow, profileName: 'x' }], { limit: 1, total: 2 })],
    ['numeric nextCursor', page([webRow], { nextCursor: 7 })],
    ['non-object page', 'nope'],
    ['items not an array', { items: {}, total: 0, limit: 1, nextCursor: null, prevCursor: null }],
  ];
  for (const [label, value] of bad) assert.equal(webState.parseProfileListPage(value), null, label + ' accepted');
  const good = page([webRow], { total: 2, nextCursor: 'next', prevCursor: 'prev' });
  assert.deepEqual(webState.parseProfileListPage(good), good);
  return bad.length + ' malformed pages rejected; valid page preserved';
});

check('C3 documents the strictness boundary: timestamps are shape-checked, not date-checked', () => {
  const page = { items: [{ ...webRow, createdAt: 'not-a-date', updatedAt: '' }], total: 1, limit: 10, nextCursor: null, prevCursor: null };
  const parsed = webState.parseProfileListPage(page);
  assert.ok(parsed !== null, 'expected the current implementation to accept the row');
  return 'accepted (observation, not a defect claim): createdAt/updatedAt are not Date.parse-validated';
});

// ---- D. BFF behaviour over real HTTP (current TS sources) ---------------
async function bffProbe() {
  const { createAdminShellServer } = require(path.join(ORCH, 'src/app/admin/shell-server.ts'));
  const { signCookie } = require(path.join(ORCH, 'src/app/admin/shell-auth.ts'));
  const SECRET = 'dsh2-aweb12-cookie-secret';
  const ADMIN_TOKEN = 'dsh2-aweb12-platform-token';
  const TENANT_A_TOKEN = 'dsh2-aweb12-tenant-a-token';
  const OPERATOR_SESSION = 'O'.repeat(43);
  const captured = [];
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    captured.push({ path: url.pathname + url.search, auth: req.headers['authorization'] ?? null });
    res.setHeader('content-type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ items: [], total: 0, limit: 100, nextCursor: null, prevCursor: null }));
  });
  await new Promise((resolve, reject) => { stub.once('error', reject); stub.listen(0, '127.0.0.1', resolve); });
  const stubPort = stub.address().port;
  const store = new Map([[OPERATOR_SESSION, { role: 'operator', tenantId: TENANT_A, csrfToken: 'C'.repeat(43) }]]);
  const handle = createAdminShellServer({
    port: 0, host: '127.0.0.1', cookieSecret: SECRET, adminToken: ADMIN_TOKEN,
    tenantAdminTokens: { [TENANT_A_TOKEN]: TENANT_A },
    jsonBaseUrl: 'http://127.0.0.1:' + stubPort,
    adminWeb: { distDir: 'Z:/does-not-exist' },
    cookiePolicy: { trustProxyProtocol: false, requireSecure: false },
    oidcSessions: { get: async (id) => store.get(id) ?? null },
  });
  const bound = await handle.listen();
  const base = bound.url;
  const get = (qs, headers) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: new URL(base).port, path: '/admin/api/profiles' + qs, method: 'GET', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  const operatorCookie = { cookie: 'du_session=' + OPERATOR_SESSION };
  const nowMs = Date.now();
  const adminCookieValue = signCookie(SECRET, { iss: 'du-admin-shell', role: 'admin', iat: nowMs, exp: nowMs + 3600000 });
  const adminCookie = { cookie: 'du_admin=' + adminCookieValue };
  try {
    await checkAsync('D1 tenant operator list is fenced to its own tenant and uses its tenant credential', async () => {
      captured.length = 0;
      const res = await get('?tenantId=' + TENANT_A + '&businessId=document-core&limit=25', operatorCookie);
      assert.equal(res.status, 200);
      assert.equal(captured.length, 1);
      assert.match(captured[0].path, /businessId=document-core/);
      assert.match(captured[0].path, /limit=25/);
      assert.match(captured[0].path, new RegExp('tenantId=' + TENANT_A));
      assert.equal(captured[0].auth, 'Bearer ' + TENANT_A_TOKEN);
      assert.notEqual(captured[0].auth, 'Bearer ' + ADMIN_TOKEN);
      return 'upstream ' + captured[0].path + ' with tenant credential';
    });

    await checkAsync('D2 tenant operator asking for another tenant is denied with zero upstream calls', async () => {
      captured.length = 0;
      const res = await get('?tenantId=' + TENANT_B, operatorCookie);
      assert.equal(res.status, 403);
      assert.equal(JSON.parse(res.body).code, 'PERMISSION_DENIED');
      assert.equal(captured.length, 0, 'upstream was called');
      return '403 PERMISSION_DENIED, upstream untouched';
    });

    await checkAsync('D3 unapproved query params never reach upstream', async () => {
      captured.length = 0;
      const res = await get('?tenantId=' + TENANT_A + '&ignored=1&adminToken=leak&sort=updatedAt:desc', operatorCookie);
      assert.equal(res.status, 200);
      assert.equal(captured.length, 1);
      assert.ok(!captured[0].path.includes('ignored'), 'ignored param forwarded');
      assert.ok(!captured[0].path.includes('leak'), 'unapproved value forwarded');
      assert.match(captured[0].path, /sort=updatedAt%3Adesc|sort=updatedAt:desc/);
      return 'allowlist held: ' + captured[0].path;
    });

    await checkAsync('D4 platform admin list carries the selected tenant and the platform credential', async () => {
      captured.length = 0;
      const res = await get('?tenantId=' + TENANT_A + '&limit=50', adminCookie);
      assert.equal(res.status, 200);
      assert.equal(captured.length, 1);
      assert.match(captured[0].path, new RegExp('tenantId=' + TENANT_A));
      assert.match(captured[0].path, /limit=50/);
      assert.equal(captured[0].auth, 'Bearer ' + ADMIN_TOKEN);
      return 'upstream ' + captured[0].path + ' with platform credential';
    });

    await checkAsync('D5 platform admin with no tenant selection forwards no tenant filter', async () => {
      captured.length = 0;
      const res = await get('?businessId=document-core', adminCookie);
      assert.equal(res.status, 200);
      assert.equal(captured.length, 1);
      assert.ok(!/tenantId=/.test(captured[0].path), 'tenant filter leaked into an unscoped platform read: ' + captured[0].path);
      return 'upstream ' + captured[0].path + ' (upstream then answers an empty page by design)';
    });
  } finally {
    await handle.close();
    await new Promise((resolve) => stub.close(resolve));
  }
}

// ---- E. screen wiring ---------------------------------------------------
check('E1 screen wires the tenant, business filter, cursor paging and strict parse', () => {
  const src = fs.readFileSync(path.join(WEB, 'src/features/profiles/profiles-screen.tsx'), 'utf8');
  assert.match(src, /const query: Record<string, string> = \{ tenantId: globalTenantId, limit: '100' \};/);
  assert.match(src, /if \(profileListBusinessId\) query\.businessId = profileListBusinessId;/);
  assert.match(src, /parseProfileListPage\(result\.data, globalTenantId, profileListBusinessId \|\| null\)/);
  assert.match(src, /cursor: profileListPage\.nextCursor/);
  assert.match(src, /limit: String\(profileListPage\.limit\)/);
  assert.match(src, /profileGroups\.set\(row\.businessId, group\)/);
  assert.match(src, /\{profileListPage\.nextCursor !== null \? \(/);
  assert.match(src, /setProfileListPage\(\(current\) => current === null \? current : \(\{/);
  return 'tenant+business+cursor+group+load-more anchors present';
});

check('E2 screen renders the documented columns and distinct list states', () => {
  const src = fs.readFileSync(path.join(WEB, 'src/features/profiles/profiles-screen.tsx'), 'utf8');
  for (const head of ['Profile', 'Business', 'Version', 'Status', 'Active keys', 'Bound actions']) {
    assert.ok(src.includes('<TableHead>' + head + '</TableHead>'), 'missing column ' + head);
  }
  assert.match(src, /row\.status === 'ACTIVE' \? 'success' : row\.status === 'DISABLED' \? 'warning' : 'neutral'/);
  assert.match(src, /\{row\.keyCount\}/);
  assert.match(src, /row\.boundActions\.map/);
  assert.match(src, /profileListProblem\.status === 401 \|\| profileListProblem\.status === 403/);
  assert.match(src, /No profiles were found for this tenant and business filter\./);
  assert.match(src, /code: 'UNREADABLE_RESPONSE'/);
  assert.match(src, /code: 'NETWORK_ERROR'/);
  assert.match(src, /Select a tenant to view profiles/);
  return 'columns + 401/403/empty/unreadable/network/no-tenant states present';
});

check('E3 Open loads the profile by its business/version/name identity', () => {
  const src = fs.readFileSync(path.join(WEB, 'src/features/profiles/profiles-screen.tsx'), 'utf8');
  assert.match(src, /load\(undefined, \{ businessId: row\.businessId, businessVersion: row\.businessVersion, profileName: row\.profileName \}\)/);
  return 'row identity handed to the detail loader';
});

(async () => {
  try { await bffProbe(); }
  catch (error) { results.push({ name: 'D* BFF probe could not run', pass: false, detail: String((error && error.stack) || error).split('\n').slice(0, 4).join(' | ') }); }
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();

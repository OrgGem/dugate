/**
 * Lane-1 UI audit — BFF HTTP probe for /admin/api/secrets* (read-only).
 *
 * Runs against the AWEB harness (real shell server + scripted upstream) and
 * verifies the wire fences the UI depends on:
 *  - unauthenticated / no-CSRF mutation refusal,
 *  - 422 body validation never echoes a submitted literal,
 *  - POST /secrets reaches the create dispatch (SC-04-M02) instead of 405,
 *  - GET list and probe route pass through the BFF.
 */
const { request } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');

const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const EXPLICIT_CSRF = process.env.AUDIT_CSRF_HEADER === '1';

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? '' : ' :: ' + String(detail)}`);
  }
}

async function main() {
  if (!BASE || !TOKEN) throw new Error('AWEB01B_URL / AWEB01B_TOKEN must be set');
  const ctx = await request.newContext();

  // Login through the real shell form; the session cookie lands in the context.
  const login = await ctx.post(`${BASE}/admin/login`, { form: { token: TOKEN }, maxRedirects: 0, failOnStatusCode: false });
  check('login accepted', [302, 303].includes(login.status()), `status=${login.status()}`);

  const sessionResponse = await ctx.get(`${BASE}/admin/api/session`);
  const session = await sessionResponse.json().catch(() => null);
  check('session read gives a CSRF token', sessionResponse.ok() && session && typeof session.csrfToken === 'string');
  const csrf = session && session.csrfToken;
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const sentinel = 'AUDIT-LANE1-SENTINEL-VALUE-DO-NOT-ECHO';

  // 1) Mutation without CSRF -> 403 CSRF_REJECTED.
  const noCsrf = await ctx.post(`${BASE}/admin/api/secrets`, {
    data: { tenantId, name: 'audit probe', purpose: 'generic', services: ['orchestrator'], provider: { kind: 'managed_value' }, value: { kind: 'literal', value: sentinel } },
    headers: { 'content-type': 'application/json' },
    failOnStatusCode: false,
  });
  const noCsrfBody = await noCsrf.json().catch(() => ({}));
  check('create without CSRF is 403 CSRF_REJECTED', noCsrf.status() === 403 && noCsrfBody.code === 'CSRF_REJECTED', `status=${noCsrf.status()} code=${noCsrfBody.code}`);

  // 2) Invalid body -> 422 with pointer errors and NO sentinel echo.
  const invalid = await ctx.post(`${BASE}/admin/api/secrets`, {
    data: { tenantId, name: '', purpose: 'not-a-purpose', services: [], provider: { kind: 'managed_value' }, value: { kind: 'literal', value: sentinel } },
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    failOnStatusCode: false,
  });
  const invalidText = await invalid.text();
  check('invalid body is 422 INVALID_SCHEMA', invalid.status() === 422, `status=${invalid.status()}`);
  check('422 response never echoes the submitted literal', !invalidText.includes(sentinel));

  // 3) Valid body -> create dispatch (SC-04-M02): must NOT be 405. The stub has
  //    no /api/v1/admin/secrets route, so the honest outcome is an upstream
  //    relay (404/502), which proves validation passed and the create branch ran.
  const valid = await ctx.post(`${BASE}/admin/api/secrets`, {
    data: { tenantId, name: 'audit probe', purpose: 'generic', services: ['orchestrator'], provider: { kind: 'managed_value' }, value: { kind: 'literal', value: sentinel } },
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    failOnStatusCode: false,
  });
  const validBody = await valid.text();
  check('valid create is not 405 (create dispatch reached upstream)', valid.status() !== 405, `status=${valid.status()} body=${validBody.slice(0, 160)}`);
  check('valid create response never echoes the literal', !validBody.includes(sentinel));

  // 4) GET list passes the BFF (upstream stub may answer 404 honestly).
  const list = await ctx.get(`${BASE}/admin/api/secrets?limit=5`, { failOnStatusCode: false });
  check('list is not 405/401 for the admin session', list.status() !== 405 && list.status() !== 401, `status=${list.status()}`);

  // 5) Test probe route method fence.
  const testGet = await ctx.get(`${BASE}/admin/api/secrets/aaaaaaaa-1111-4111-8111-111111111111/test`, { failOnStatusCode: false });
  check('GET on /test is 405', testGet.status() === 405, `status=${testGet.status()}`);
  const testPost = await ctx.post(`${BASE}/admin/api/secrets/aaaaaaaa-1111-4111-8111-111111111111/test`, {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: {},
    failOnStatusCode: false,
  });
  check('POST on /test is not 405', testPost.status() !== 405, `status=${testPost.status()}`);

  // 6) Rotate CAS body validation: missing expectedRevision -> 422.
  const rotate = await ctx.post(`${BASE}/admin/api/secrets/aaaaaaaa-1111-4111-8111-111111111111/rotate`, {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: { value: { kind: 'literal', value: sentinel } },
    failOnStatusCode: false,
  });
  const rotateText = await rotate.text();
  check('rotate without CAS revision is 422', rotate.status() === 422, `status=${rotate.status()}`);
  check('rotate 422 never echoes the submitted literal', !rotateText.includes(sentinel));

  await ctx.dispose();
  console.log(failures === 0 ? '\nBFF probe: ALL CHECKS PASSED' : `\nBFF probe: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('BFF PROBE CRASHED', error);
  process.exit(1);
});

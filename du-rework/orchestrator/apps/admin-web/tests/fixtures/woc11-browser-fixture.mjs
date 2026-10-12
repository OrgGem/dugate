import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dist = resolve(here, '../../dist');
const tenantId = '11111111-1111-4111-8111-111111111111';
const apiKeyId = '33333333-3333-4333-8333-333333333333';
const fixedDate = new Date().toISOString();
const businesses = [
  { businessId: 'document-core', enabled: true, lifecycleRevision: 8, activeVersion: '1.1.0', versions: ['1.1.0', '2.0.0'] },
  { businessId: 'claims-workflow', enabled: true, lifecycleRevision: 3, activeVersion: '3.0.0', versions: ['3.0.0'] },
];
const groups = new Map();
let nextGroupRevision = 1;
let nextChildId = 0;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendProblem(res, status, code, title) {
  sendJson(res, status, { status, code, title, correlationId: 'woc11-local-fixture' });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function businessRows() {
  return businesses.map(({ businessId, enabled, lifecycleRevision, activeVersion }) => ({
    businessId,
    activeVersion,
    version: businessId === 'document-core' ? '2.0.0' : '3.0.0',
    status: 'ENABLED',
    updatedAt: fixedDate,
    enabled,
    lifecycleRevision,
  }));
}

function versionRows(business) {
  return business.versions.map((version) => ({
    version,
    status: 'ENABLED',
    isActive: business.activeVersion === version,
    updatedAt: fixedDate,
  }));
}

function descriptorSet(businessId, version, enabled) {
  const manifestDigest = `${businessId}-${version}-fixture-digest`;
  if (businessId === 'document-core') {
    return {
      businessId,
      businessVersion: version,
      manifestDigest,
      businessEnabled: enabled,
      functions: [
        {
          kind: 'endpoint', functionId: 'core:extract:invoice', action: 'extract', endpointSlug: 'extract.invoice', manifestDigest,
          inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          profileSchema: { type: 'object', properties: { temperature: { type: 'number', title: 'Temperature', default: 0.2 }, options: { type: 'object', title: 'Options', default: {} } }, required: ['temperature'] },
          available: true,
          connectorSlots: [{ name: 'reasoning', required: true, acceptedCapabilities: ['reasoning'] }],
        },
        {
          kind: 'endpoint', functionId: 'core:analyze:legacy', action: 'analyze', endpointSlug: 'analyze.legacy', manifestDigest,
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, profileSchema: { type: 'object', properties: {} },
          available: false,
          unavailableReason: 'The local runtime fixture does not admit this legacy endpoint.',
          connectorSlots: [],
        },
      ],
    };
  }
  return {
    businessId,
    businessVersion: version,
    manifestDigest,
    businessEnabled: enabled,
    functions: [{
      kind: 'workflow', functionId: 'claims:action:review', action: 'review-claim', manifestDigest,
      inputSchema: { type: 'object', properties: { claimId: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { decision: { type: 'string' } } },
      profileSchema: { type: 'object', properties: { threshold: { type: 'number', title: 'Threshold', default: 0.7 } } },
      available: true,
      connectorSlots: [{ name: 'reasoning', required: true, acceptedCapabilities: ['reasoning'] }],
    }],
  };
}

function readPolicy(policy) {
  return {
    enabled: policy.enabled ?? true,
    parameters: policy.parameters ?? {},
    jobPriority: policy.jobPriority ?? 'MEDIUM',
    allowedFileExtensions: policy.allowedFileExtensions ?? '',
    fileUrlAuthConfigured: false,
    allowedOrigins: policy.allowedOrigins ?? [],
    connectionsOverride: policy.connectionsOverride ?? [],
    ...(policy.requestRedaction !== undefined ? { requestRedaction: policy.requestRedaction } : {}),
    ...(policy.callbackPolicy !== undefined ? { callbackPolicy: policy.callbackPolicy } : {}),
  };
}

function groupFromBody(body, groupId, revision) {
  return {
    groupId,
    name: body.name,
    tenantId: body.tenantId ?? tenantId,
    revision,
    apiKey: { apiKeyId: body.apiKey.apiKeyId, prefix: 'du_fixture', status: 'ACTIVE' },
    businesses: body.businesses.map((business) => ({
      businessId: business.businessId,
      businessVersion: business.businessVersion,
      manifestDigest: business.manifestDigest,
      functions: business.functions.map((fn) => {
        nextChildId += 1;
        const childOrdinal = String(nextChildId).padStart(12, '0');
        return {
          kind: fn.kind,
          functionId: fn.functionId,
          action: fn.action,
          ...(fn.endpointSlug ? { endpointSlug: fn.endpointSlug } : {}),
          ...(fn.workflowRevision ? { workflowRevision: fn.workflowRevision } : {}),
          manifestDigest: business.manifestDigest,
          childProfileId: `66666666-6666-4666-8666-${childOrdinal}`,
          childRevision: revision,
          enabled: fn.policy.enabled ?? true,
          policy: readPolicy(fn.policy),
          connectorBindings: fn.connectorBindings,
        };
      }),
    })),
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (path === '/admin/api/session' && method === 'GET') {
    return sendJson(res, 200, {
      schemaVersion: 'fixture-1', plane: 'oidc', role: 'admin',
      principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' },
      displayName: 'WOC11 fixture administrator', localUser: false, csrfToken: 'woc11-fixture-csrf',
    });
  }
  if (path === '/admin/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok', db: true, redis: true, activeLeases: 2, outboxBacklog: 0,
      queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: fixedDate },
      sampledAt: fixedDate,
    });
  }
  if (path === '/admin/api/secrets' && method === 'GET') {
    return sendJson(res, 200, { items: [], nextCursor: null });
  }
  if (path === '/admin/api/tenants' && method === 'GET') {
    return sendJson(res, 200, { items: [{ id: tenantId, name: 'Default fixture tenant', state: 'ACTIVE' }], nextCursor: null, prevCursor: null, total: 1, limit: 100 });
  }
  if (path === '/admin/api/businesses' && method === 'GET') {
    return sendJson(res, 200, { items: businessRows(), total: businesses.length, limit: Number(url.searchParams.get('limit') ?? 50), nextCursor: null });
  }
  const businessEnabled = /^\/admin\/api\/businesses\/([^/]+)\/enabled$/.exec(path);
  if (businessEnabled && method === 'PUT') {
    const body = await readJson(req);
    const business = businesses.find((item) => item.businessId === decodeURIComponent(businessEnabled[1]));
    if (!business) return sendProblem(res, 404, 'NOT_FOUND', 'Business not found in local fixture.');
    if (body.expectedLifecycleRevision !== business.lifecycleRevision) return sendProblem(res, 409, 'REVISION_CONFLICT', 'Business lifecycle revision changed.');
    business.enabled = body.enabled;
    business.lifecycleRevision += 1;
    return sendJson(res, 200, { businessId: business.businessId, enabled: business.enabled, lifecycleRevision: business.lifecycleRevision, replayed: false });
  }
  const businessVersions = /^\/admin\/api\/businesses\/([^/]+)\/versions$/.exec(path);
  if (businessVersions && method === 'GET') {
    const business = businesses.find((item) => item.businessId === decodeURIComponent(businessVersions[1]));
    if (!business) return sendProblem(res, 404, 'NOT_FOUND', 'Business not found in local fixture.');
    return sendJson(res, 200, { businessId: business.businessId, activeVersion: business.activeVersion, enabled: business.enabled, lifecycleRevision: business.lifecycleRevision, rows: versionRows(business) });
  }
  const businessVersionAction = /^\/admin\/api\/businesses\/([^/]+)\/versions\/([^/]+)\/(enable|activate|deactivate)$/.exec(path);
  if (businessVersionAction && method === 'PUT') {
    const business = businesses.find((item) => item.businessId === decodeURIComponent(businessVersionAction[1]));
    const version = decodeURIComponent(businessVersionAction[2]);
    if (!business || !business.versions.includes(version)) return sendProblem(res, 404, 'NOT_FOUND', 'Version not found in local fixture.');
    if (businessVersionAction[3] === 'activate') business.activeVersion = version;
    else if (businessVersionAction[3] === 'deactivate' && business.activeVersion === version) business.activeVersion = null;
    return sendJson(res, 200, { businessId: business.businessId, version, action: businessVersionAction[3] });
  }
  const functionCatalog = /^\/admin\/api\/businesses\/([^/]+)\/versions\/([^/]+)\/functions$/.exec(path);
  if (functionCatalog && method === 'GET') {
    const businessId = decodeURIComponent(functionCatalog[1]);
    const version = decodeURIComponent(functionCatalog[2]);
    const business = businesses.find((item) => item.businessId === businessId);
    if (!business || !business.versions.includes(version)) return sendProblem(res, 404, 'NOT_FOUND', 'Registered business version not found in local fixture.');
    return sendJson(res, 200, descriptorSet(businessId, version, business.enabled));
  }
  if (path === '/admin/api/worker-instances' && method === 'GET') {
    const businessId = url.searchParams.get('businessId');
    const items = businessId === 'document-core' ? [
      { businessId, businessVersion: '1.1.0', instanceId: 'core-v1-worker-a', state: 'ONLINE', health: 'HEALTHY', capacity: 8, activeLeases: 3, acceptedTaskCount: 128, acceptedTaskCountSince: '2026-10-01T00:00:00.000Z', acceptedTaskCountScope: 'business-instance-lifetime', lastSeenAt: fixedDate, observedAt: fixedDate },
      { businessId, businessVersion: '1.1.0', instanceId: 'core-v1-worker-b', state: 'DRAINING', health: 'DEGRADED', capacity: 6, activeLeases: 1, acceptedTaskCount: 95, acceptedTaskCountSince: '2026-10-02T00:00:00.000Z', acceptedTaskCountScope: 'business-instance-lifetime', lastSeenAt: fixedDate, observedAt: fixedDate },
      { businessId, businessVersion: '2.0.0', instanceId: 'core-v2-worker-a', state: 'ONLINE', health: 'HEALTHY', capacity: 8, activeLeases: 2, acceptedTaskCount: 7, acceptedTaskCountSince: '2026-10-11T00:00:00.000Z', acceptedTaskCountScope: 'business-instance-lifetime', lastSeenAt: fixedDate, observedAt: fixedDate },
    ] : [];
    return sendJson(res, 200, { items, sampledAt: fixedDate, truncated: false });
  }
  if (path === '/admin/api/api-keys' && method === 'GET') {
    return sendJson(res, 200, { items: [{ id: apiKeyId, tenantId, prefix: 'du_fixture', name: 'Existing fixture key', maskedHint: 'du_fixture••••', status: 'ACTIVE', createdAt: fixedDate, updatedAt: fixedDate }], nextCursor: null, prevCursor: null, total: 1, limit: 100, grants: [], createCopyOnce: null });
  }
  if (path === '/admin/api/connectors' && method === 'GET') {
    return sendJson(res, 200, { items: [{ connectorId: 'reasoning-primary', revision: 2, adapter: 'fixture-adapter', state: 'ACTIVE', config: { profile: 'fixture' } }] });
  }
  if (path === '/admin/api/profile-groups' && method === 'GET') {
    return sendJson(res, 200, { groups: [...groups.values()] });
  }
  if (path === '/admin/api/profile-groups' && method === 'POST') {
    const body = await readJson(req);
    if (body.expectedRevision !== 0) return sendProblem(res, 409, 'REVISION_CONFLICT', 'New group must start at revision 0.');
    const groupId = '77777777-7777-4777-8777-777777777777';
    const group = groupFromBody(body, groupId, nextGroupRevision++);
    groups.set(groupId, group);
    return sendJson(res, 200, group);
  }
  const groupRoute = /^\/admin\/api\/profile-groups\/([^/]+)(?:\/(rollback))?$/.exec(path);
  if (groupRoute) {
    const groupId = decodeURIComponent(groupRoute[1]);
    const group = groups.get(groupId);
    if (!group) return sendProblem(res, 404, 'NOT_FOUND', 'Profile group not found in local fixture.');
    if (method === 'GET' && !groupRoute[2]) return sendJson(res, 200, group);
    if (method === 'PUT' && !groupRoute[2]) {
      const body = await readJson(req);
      if (body.expectedRevision !== group.revision) return sendProblem(res, 409, 'REVISION_CONFLICT', 'Profile group revision changed in local fixture.');
      const updated = groupFromBody(body, groupId, group.revision + 1);
      groups.set(groupId, updated);
      return sendJson(res, 200, updated);
    }
    if (method === 'POST' && groupRoute[2]) {
      const body = await readJson(req);
      if (body.expectedRevision !== group.revision) return sendProblem(res, 409, 'REVISION_CONFLICT', 'Profile group revision changed in local fixture.');
      group.revision += 1;
      group.updatedAt = fixedDate;
      return sendJson(res, 200, group);
    }
  }
  if (path === '/admin/api/profiles' && method === 'GET') {
    return sendJson(res, 200, { items: [], total: 0, limit: 100, nextCursor: null, prevCursor: null });
  }
  if (path.endsWith('/workflows') && method === 'GET') {
    const parts = path.split('/');
    return sendJson(res, 200, { businessId: parts[3] ?? 'document-core', businessVersion: parts[4] ?? '1.0.0', items: [], total: 0, limit: 100, nextCursor: null, prevCursor: null });
  }
  if (path === '/admin/api/__fixture/business-enabled' && method === 'POST') {
    const body = await readJson(req);
    const business = businesses.find((item) => item.businessId === body.businessId);
    if (!business) return sendProblem(res, 404, 'NOT_FOUND', 'Business not found in local fixture.');
    business.enabled = body.enabled;
    business.lifecycleRevision += 1;
    return sendJson(res, 200, { businessId: business.businessId, enabled: business.enabled, lifecycleRevision: business.lifecycleRevision });
  }
  if (path === '/admin/api/__fixture/bump-group' && method === 'POST') {
    const body = await readJson(req);
    const group = groups.get(body.groupId);
    if (!group) return sendProblem(res, 404, 'NOT_FOUND', 'Profile group not found in local fixture.');
    group.revision += 1;
    group.updatedAt = fixedDate;
    return sendJson(res, 200, { groupId: group.groupId, revision: group.revision });
  }
  if (path.startsWith('/admin/api/')) return sendProblem(res, 404, 'NOT_FOUND', `No local fixture route for ${method} ${path}.`);
  return false;
}

function contentType(path) {
  return ({ '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png' })[extname(path)] ?? 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/admin/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/admin') {
      res.writeHead(302, { location: '/admin/' });
      res.end();
      return;
    }
    const relative = url.pathname.startsWith('/admin/') ? url.pathname.slice('/admin/'.length) : '';
    let target = resolve(dist, relative || 'index.html');
    if (!target.startsWith(`${dist}${sep}`) && target !== resolve(dist, 'index.html')) {
      sendProblem(res, 403, 'FORBIDDEN', 'Local fixture path rejected.');
      return;
    }
    try {
      const data = await readFile(target);
      res.writeHead(200, { 'content-type': contentType(target), 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      target = resolve(dist, 'index.html');
      const data = await readFile(target);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(data);
    }
  } catch (error) {
    sendProblem(res, 500, 'FIXTURE_ERROR', error instanceof Error ? error.message : 'Local fixture error.');
  }
});

const port = Number(process.env.WOC11_FIXTURE_PORT ?? 4178);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ event: 'ready', url: `http://127.0.0.1:${port}/admin/`, fixture: 'isolated in-memory WOC11 UI data' }) + '\n');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

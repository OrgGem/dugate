/**
 * CONV-02: the runtime/worker audience (all `/api/runtime/v1/` routes) and
 * its auth guards, moved verbatim out of server.ts route(). The guards are
 * the same ones the single-function route() used — assertTaskRuntimeAuth,
 * assertArtifactRuntimeAuth and assertBodyTaskRuntimeAuth keep their task/
 * artifact-ownership fences byte-for-byte.
 */
import { Readable } from 'node:stream';
import { HttpError } from '../errors';
import { ClaimTaskRequestSchema, WorkspaceReferenceQuerySchema } from '@du/contracts';
import {
  authorizeWorkerBusiness,
  authorizeWorkerClaim,
  isAuthorizedPlatformRuntimeBearer,
  isAuthorizedRuntimeBearer,
  resolveWorkerBusinessIdentity,
} from '../../modules/runtime/worker-identity';
import { decryptStoredArtifact } from '../../modules/encryption/artifact-read-decrypt';
import type { RouteContext, RouteResult } from '../route-context';

function assertRuntimeAuth(ctx: RouteContext): string | undefined {
  const auth = ctx.headers['authorization'] ?? '';
  if (!isAuthorizedRuntimeBearer(ctx.config, auth)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'invalid runtime bearer token');
  }
  return resolveWorkerBusinessIdentity(ctx.config, auth) ?? undefined;
}

function assertPlatformRuntimeAuth(ctx: RouteContext): void {
  const auth = ctx.headers['authorization'] ?? '';
  if (isAuthorizedPlatformRuntimeBearer(ctx.config, auth)) return;
  if (resolveWorkerBusinessIdentity(ctx.config, auth)) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker credentials cannot register business versions');
  }
  throw new HttpError(401, 'UNAUTHENTICATED', 'invalid platform runtime bearer token');
}

async function assertTaskRuntimeAuth(ctx: RouteContext, taskId: string): Promise<string | undefined> {
  const workerBusinessId = assertRuntimeAuth(ctx);
  if (!workerBusinessId) return undefined; // platform runtime identity
  const res = await ctx.db.query<{ business_id: string }>(
    `SELECT o.business_id FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE t.id=$1`,
    [taskId]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', 'task not found');
  authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], res.rows[0]!.business_id);
  return workerBusinessId;
}

async function assertArtifactRuntimeAuth(ctx: RouteContext, artifactId: string): Promise<void> {
  const workerBusinessId = assertRuntimeAuth(ctx);
  if (!workerBusinessId) return; // platform runtime identity
  const res = await ctx.db.query<{ business_id: string }>(
    `SELECT o.business_id FROM artifacts a JOIN operations o ON o.id=a.operation_id WHERE a.id=$1`,
    [artifactId]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', 'artifact not found');
  authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], res.rows[0]!.business_id);
}

async function assertBodyTaskRuntimeAuth(ctx: RouteContext): Promise<void> {
  const workerBusinessId = assertRuntimeAuth(ctx);
  if (!workerBusinessId) return; // platform runtime identity
  const taskId = (ctx.body as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker artifact access requires an owned task');
  }
  await assertTaskRuntimeAuth(ctx, taskId);
}

// CR-12: the blob route resolves the artifact's CURRENT token, the method the
// token was issued for (upload|download), and its expiry — the shared token is
// now method-scoped and time-bounded, so a read grant cannot PUT and an expired
// token 404s instead of serving bytes.
async function resolveArtifactByStorageKey(
  ctx: RouteContext,
  storageKey: string
): Promise<{ id: string; token: string; tenantId: string; mode: string | null; expiresAt: string | null; businessId: string | null; uploadToken: string | null; manifestVersionId: string | null }> {
  const res = await ctx.db.query(
    `SELECT a.id, a.upload_token, a.token, a.tenant_id, a.token_mode, a.token_expires_at, o.business_id,
            a.manifest_version_id
     FROM artifacts a LEFT JOIN operations o ON o.id=a.operation_id
     WHERE a.storage_key=$1`,
    [storageKey]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `artifact ${storageKey} not found`);
  const row = res.rows[0] as {
    id: string; upload_token: string | null; token: string; tenant_id: string; token_mode: string | null;
    token_expires_at: string | null; business_id: string | null; manifest_version_id: string | null;
  };
  return {
    id: row.id,
    uploadToken: row.upload_token,
    token: row.token,
    tenantId: row.tenant_id,
    mode: row.token_mode,
    expiresAt: row.token_expires_at,
    businessId: row.business_id,
    // RFX-05-residual: the committed sidecar generation, when the row has one
    // (migration 0025). NULL keeps the legacy key-only manifest read.
    manifestVersionId: row.manifest_version_id,
  };
}

/**
 * RFX-11: whether a grant URL may fall back to the request Host when no
 * `publicBaseUrl` is configured. A real deployment must configure the public
 * base URL (or answer the relative path); only a dev/test boot — `NODE_ENV`
 * development/test, or a zero-config boot (`autoMigrate: true`, the mode this
 * module documents for dev/test fixtures) — may keep the legacy Host-derived
 * absolute URL.
 */
export function allowHostDerivedGrantUrl(
  env: Record<string, string | undefined> = process.env,
  options: { zeroConfigBoot?: boolean } = {},
): boolean {
  const nodeEnv = env['NODE_ENV'];
  return nodeEnv === 'development' || nodeEnv === 'test' || options.zeroConfigBoot === true;
}

export interface GrantUrlOptions {
  /** Platform configuration; when set it ALWAYS decides the grant host. */
  publicBaseUrl?: string;
  /** Zero-config boot (`autoMigrate: true`) counts as dev/test for the fallback. */
  zeroConfigBoot?: boolean;
  /** Environment consulted when no explicit decision is available. */
  env?: Record<string, string | undefined>;
}

/**
 * RFX-11: build the absolute grant URL handed to a worker.
 *
 * A reverse proxy forwards the caller's Host header, so it is caller-influenced
 * input: deriving the host of a URL that the client will follow with a grant
 * token attached would let an attacker point the grant at their own endpoint
 * (phishing the token or the uploaded bytes). Resolution order:
 *   1. an already-absolute http(s) URL (provider-signed) is returned as-is;
 *   2. the configured `publicBaseUrl` (platform configuration) decides the host;
 *   3. only for a dev/test boot (see allowHostDerivedGrantUrl) does the legacy
 *      Host-derived fallback apply;
 *   4. otherwise the relative grant path is returned — never a Host-derived
 *      absolute URL. Clients that require an absolute URL (e.g. the worker SDK
 *      parses grants as `z.string().url()`) fail closed on the relative value
 *      instead of following a poisoned host.
 */
export function absoluteGrantUrl(
  host: string,
  url: string,
  options: GrantUrlOptions = {},
): string {
  if (/^https?:\/\//i.test(url)) return url;
  const path = url.startsWith('/') ? url : `/${url}`;
  const base = options.publicBaseUrl?.trim();
  if (base) return `${base.replace(/\/+$/, '')}${path}`;
  if (allowHostDerivedGrantUrl(options.env ?? process.env, { zeroConfigBoot: options.zeroConfigBoot })) {
    return `http://${host}${path}`;
  }
  return path;
}

/** RFX-11: the grant URL for the request at hand, with the app's own boot mode. */
function requestGrantUrl(ctx: RouteContext, url: string): string {
  return absoluteGrantUrl(ctx.host, url, {
    publicBaseUrl: ctx.config.runtimeBaseUrl ?? ctx.config.publicBaseUrl,
    zeroConfigBoot: ctx.config.autoMigrate === true,
  });
}

export async function handleRuntimeRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  const { method, pathname } = ctx;

  // Runtime: POST /api/runtime/v1/usage-events (Connector usage ingestion)
  if (method === 'POST' && pathname === '/api/runtime/v1/usage-events') {
    const authorization = ctx.headers.authorization;
    if (!authorization || !ctx.config.usageToken) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'missing connector usage bearer token');
    }
    if (authorization !== `Bearer ${ctx.config.usageToken}`) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'usage ingestion requires connector identity');
    }
    return { status: 200, body: await ctx.usage.ingest(ctx.body) };
  }

  // Runtime: artifact upload grant  POST /api/runtime/v1/tasks/:id/artifacts
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/artifacts$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const body = ctx.body as { leaseEpoch: number };
      const grant = await ctx.artifacts.requestUpload(m[1]!, body.leaseEpoch, ctx.body);
      return { status: 201, body: { ...grant, uploadUrl: requestGrantUrl(ctx, grant.uploadUrl) } };
    }
  }

  // Runtime: artifact finalize  POST /api/runtime/v1/artifacts/:id/finalize
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/finalize$/.exec(pathname);
    if (m && method === 'POST') {
      await assertArtifactRuntimeAuth(ctx, m[1]!);
      await assertBodyTaskRuntimeAuth(ctx);
      return { status: 200, body: await ctx.artifacts.finalize(m[1]!, ctx.body) };
    }
  }

  // Runtime: artifact access grant  POST /api/runtime/v1/artifacts/:id/access
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/access$/.exec(pathname);
    if (m && method === 'POST') {
      await assertArtifactRuntimeAuth(ctx, m[1]!);
      await assertBodyTaskRuntimeAuth(ctx);
      const grant = await ctx.artifacts.requestAccess(m[1]!, ctx.body);
      const abs: Record<string, unknown> = { ...grant };
      if (grant.downloadUrl) abs.downloadUrl = requestGrantUrl(ctx, grant.downloadUrl);
      if (grant.uploadUrl) abs.uploadUrl = requestGrantUrl(ctx, grant.uploadUrl);
      return { status: 200, body: abs };
    }
  }

  // Runtime: multipart init  POST /api/runtime/v1/tasks/:id/artifacts/multipart
  // DATA-02. The task-scoped fence matches the single-PUT grant route; the
  // uploadToken in the body is the replay key, so a lost response is retried
  // with the same token instead of leaking a second provider upload.
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/artifacts\/multipart$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const ack = await ctx.multipart.init(m[1]!, ctx.body);
      return { status: ack.replayed ? 200 : 201, body: ack };
    }
  }

  // Runtime: multipart part grant / complete / abort
  // POST /api/runtime/v1/artifacts/:id/multipart/{part,complete,abort}
  // The artifact row is the authority for which task owns the upload, so these
  // three are authorized by artifact id: the part/complete/abort wire carries
  // only the lease epoch, never a client-declared task id. A presigned part URL
  // is a grant like any other and is never logged.
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/multipart\/(part-grant|part|complete|abort)$/.exec(pathname);
    if (m && method === 'POST') {
      const artifactId = m[1]!;
      await assertArtifactRuntimeAuth(ctx, artifactId);
      if (m[2] === 'part-grant' || m[2] === 'part') {
        const grant = await ctx.multipart.grantPart(artifactId, ctx.body);
        return { status: 200, body: { ...grant, partUrl: requestGrantUrl(ctx, grant.partUrl) } };
      }
      if (m[2] === 'complete') {
        return { status: 200, body: await ctx.multipart.complete(artifactId, ctx.body) };
      }
      return { status: 200, body: await ctx.multipart.abort(artifactId, ctx.body) };
    }
  }

  // Runtime: invocation grant  POST /api/runtime/v1/tasks/:id/invocation-grants
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/invocation-grants$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      if (!ctx.grants) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'invocation grants are not configured');
      const body = ctx.body as { leaseEpoch: number };
      return { status: 201, body: await ctx.grants.issue(m[1]!, body.leaseEpoch, ctx.body) };
    }
  }

  // Runtime: artifact blob PUT/GET (grant-protected; slice in-process transport)
  // CR-12: method-scoped, expiring grants. The token row carries the method it
  // was issued for (upload|download) and its expiry; a mismatch 403s (a read
  // grant can never PUT) and an expired token 404s (indistinguishable from a
  // missing artifact, no existence leak). Legacy rows with NULL mode/expiry
  // (pre-0008) fail closed — holders must re-request a scoped grant.
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/blob\/([^/]+)$/.exec(pathname);
    if (m) {
      const art = await resolveArtifactByStorageKey(ctx, m[1]!);
      const workerBusinessId = resolveWorkerBusinessIdentity(ctx.config, ctx.headers['authorization']);
      if (workerBusinessId) {
        authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], art.businessId ?? '');
      }
      const grant = ctx.searchParams.get('grant');
      if (!grant || art.token !== grant) throw new HttpError(403, 'PERMISSION_DENIED', 'invalid artifact blob grant');
      const wantMode = method === 'PUT' ? 'upload' : method === 'GET' ? 'download' : null;
      if (!wantMode) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      if (art.mode !== wantMode) throw new HttpError(403, 'PERMISSION_DENIED', 'grant not issued for this method');
      if (!art.expiresAt || new Date(art.expiresAt).getTime() <= Date.now()) {
        throw new HttpError(404, 'NOT_FOUND', `artifact ${m[1]} not found`);
      }
      if (method === 'PUT') {
        // FIX-CR-11: blob bytes arrive raw via the binary ingress path —
        // never utf8-decoded or JSON-parsed. GET without a prior PUT has no
        // rawBody; putBlob of an empty buffer is the explicit empty blob.
        await ctx.artifacts.putBlob(m[1]!, art.tenantId, ctx.rawBody ?? Buffer.alloc(0));
        return { status: 204, body: undefined };
      }
      if (method === 'GET') {
        // RFX-15: the download grant is SINGLE-USE. The token rides the URL
        // (the worker SDK fetches grants as bare presigned-style URLs), so a
        // token observed in a proxy/LB access log must be worthless by the
        // time it is replayed. The consume is atomic — `token_expires_at >
        // now()` makes exactly one concurrent request win — and a replay is
        // reported as NOT_FOUND, indistinguishable from an expired grant. A
        // legitimate retry re-requests access and gets a fresh token. PUT is
        // deliberately NOT consumed here: a lost-response retry of the same
        // upload is idempotent by content hash and stays valid within the
        // (now shorter) TTL.
        const spent = await ctx.db.query(
          `UPDATE artifacts SET token_expires_at = now()
            WHERE id=$1 AND token=$2 AND token_mode='download' AND token_expires_at > now()`,
          [art.id, grant]
        );
        if (!spent.rowCount) throw new HttpError(404, 'NOT_FOUND', `artifact ${m[1]} not found`);
        // CR28-01: a sealed artifact must be authenticated and opened BEFORE
        // a worker sees it. Handing the worker ciphertext would make the task
        // fail deep inside a parser with no signal that the storage layer was
        // the cause, so the decrypt happens here, on the serving boundary.
        if (ctx.artifactDecryptDeps) {
          const opened = await decryptStoredArtifact(ctx.artifactDecryptDeps, {
            artifactId: art.id as string,
            tenantId: art.tenantId as string,
            storageKey: m[1]!,
            uploadToken: (art.uploadToken as string | null) ?? null,
            // RFX-05-residual: pin the sidecar generation the row committed.
            manifestVersionId: art.manifestVersionId,
          });
          if (opened.decrypted) {
            return {
              status: 200,
              raw: Readable.from([opened.bytes]),
              headers: { 'content-type': 'application/octet-stream' },
            };
          }
        }
        const stream = await ctx.artifacts.getBlob(m[1]!);
        return { status: 200, raw: stream, headers: { 'content-type': 'application/octet-stream' } };
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    }
  }

  {
    const m = /^\/api\/runtime\/v1\/businesses\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      assertPlatformRuntimeAuth(ctx);
      const result = await ctx.registry.registerVersion(ctx.body);
      return { status: result.created ? 201 : 200, body: result };
    }
  }

  // Runtime: PUT /api/runtime/v1/workers/:instanceId/heartbeat
  // RFX-12: STUB COMPAT SURFACE — kept so older worker SDKs receive an ack
  // instead of a 404. It reads and writes NO runtime/lease state, so it must
  // not report HEALTHY: an operator or autoscaler acting on a fabricated
  // 'HEALTHY' would make decisions from data this route never collected.
  // 'DEGRADED' is the conservative value inside the published
  // HeartbeatAckSchema enum ['HEALTHY','DEGRADED','OFFLINE'] (it is also what
  // SDK clients zod-parse; an out-of-enum 'UNKNOWN' would fail their parse).
  // leaseExpiresAt/capacity stay for wire-shape compatibility. Real monitoring
  // is GET /health (DB/Redis transport + queueIntegrity sweep state).
  if (method === 'PUT' && /^\/api\/runtime\/v1\/workers\/[^/]+\/heartbeat$/.test(pathname)) {
    const workerBusinessId = assertRuntimeAuth(ctx);
    if (workerBusinessId) {
      const declaredBusinessId = (ctx.body as { businessId?: unknown } | null)?.businessId;
      if (typeof declaredBusinessId !== 'string') {
        throw new HttpError(403, 'PERMISSION_DENIED', 'worker heartbeat requires its authenticated business');
      }
      authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], declaredBusinessId);
    }
    return { status: 200, body: { health: 'DEGRADED', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 } };
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/claim
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/claim$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      const parsedBody = ClaimTaskRequestSchema.safeParse(ctx.body);
      if (!parsedBody.success) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'task claim requires deliveryId, workerInstanceId, and businessId');
      }
      const body = parsedBody.data;
      const workerBusinessId = authorizeWorkerClaim(
        ctx.config,
        ctx.headers['authorization'],
        body.businessId
      );
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.claimTask(
        m[1]!,
        body.deliveryId,
        body.workerInstanceId,
        workerBusinessId
      );
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/heartbeat
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/heartbeat$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const body = ctx.body as { leaseEpoch: number };
      const result = await ctx.runtime.heartbeatTask(m[1]!, body.leaseEpoch, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: PUT /api/runtime/v1/tasks/:id/steps/:stepKey
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/steps\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.saveStep(m[1]!, decodeURIComponent(m[2]!), ctx.body as never, workerBusinessId);
      return { status: result.replayed ? 200 : 201, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/progress
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/progress$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      await ctx.runtime.reportProgress(m[1]!, ctx.body as never);
      return { status: 200, body: {} };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/complete
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/complete$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.completeTask(m[1]!, ctx.body as never, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/fail
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/fail$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.failTask(m[1]!, ctx.body as never, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/children  (W13-C item 4: fan-out spawn)
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/children$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.spawnChildren(m[1]!, ctx.body as never, workerBusinessId);
      return { status: 202, body: result };
    }
  }

  // Runtime: GET /api/runtime/v1/tasks/:id/children  (W13-C item 4: join visibility)
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/children$/.exec(pathname);
    if (m && method === 'GET') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.getChildren(m[1]!);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/wait-input  (W13-C item 4: human wait)
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/wait-input$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.waitInput(m[1]!, ctx.body as never, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: GET /api/runtime/v1/workspace-reference?workspacePath=<dir>&tenantId=<uuid>
  // (W47-C1: read-only ART-02 lookup for the SDK sweeper's hasActiveReference
  // hook — the ONLY writer-side integration the worker needs. Answers whether
  // this temp workspace still holds an ACTIVE reference (non-terminal
  // task/operation or OPEN human wait under `tenantId`). Contract (§contract):
  // 200 `{ workspacePath, tenantId, referenced, activeHolders }`;
  // 401 invalid runtime bearer; 422 missing/invalid query params (INVALID_SCHEMA).
  // No 404 — an unknown/unreferenced workspace is `referenced: false`, not
  // an error (the sweeper treats it as a true orphan candidate).
  if (method === 'GET' && pathname === '/api/runtime/v1/workspace-reference') {
    const workerBusinessId = assertRuntimeAuth(ctx);
    const parsed = WorkspaceReferenceQuerySchema.safeParse({
      workspacePath: ctx.searchParams.get('workspacePath'),
      tenantId: ctx.searchParams.get('tenantId'),
    });
    if (!parsed.success) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        'workspace-reference requires workspacePath and tenantId query parameters'
      );
    }
    const status = await ctx.runtime.workspaceReferenceStatus(parsed.data.tenantId, workerBusinessId);
    return {
      status: 200,
      body: {
        workspacePath: parsed.data.workspacePath,
        tenantId: parsed.data.tenantId,
        referenced: status.referenced,
        activeHolders: status.activeHolders,
      },
    };
  }

  return null;
}

/**
 * CONV-02: the public/x-api-key audience (all `/api/v1/` routes, the legacy
 * compat facade and the ENC-07 delivery helpers), moved verbatim out of
 * server.ts route(). The delivery helpers used to be nested inside route();
 * they are now module-level and only this family calls them.
 */
import { Readable } from 'node:stream';
import { HttpError, zodIssuesToProblem } from '../errors';
import { MULTIPART_MIN_TOTAL_BYTES, UsageEventDrilldownQuerySchema } from '@du/contracts';
import { publicUploadToken } from '../../modules/artifacts/multipart-service';
import { DeliveryEncryptionError } from '../../modules/public-api';
import { decryptStoredArtifact } from '../../modules/encryption/artifact-read-decrypt';
import { handleLegacyRoute } from '../../compat/legacy-http-mount';
import { legacyCompatHost } from '../../compat/legacy-host-adapter';
import { resultHttpStatus, toOperationView, waitForTerminal } from '../../modules/operations/facade';
import { listOperationsPage, parseOperationsListQuery } from '../../modules/operations/list-query';
import { buildAdminOperationDetail, toOperationDetailWire } from '../../modules/operations/mappers';
import {
  authorizeAuditTenantRead,
  requireResourceTenant,
  resolveAdminPrincipal,
} from '../../modules/admin-actions/rbac';
import { readStreamBounded } from './public-bounded-body';
import { resolveApiKey } from './api-key-auth';
import { authorizeConnectorProbe } from '../../modules/connectors/probe-authorization';
import { compatibilityMetadataReader } from '../../modules/encryption/metadata-read-policy';
import type { RouteContext, RouteResult } from '../route-context';

/**
 * ENC-07: map a delivery-encryption failure onto the wire.
 *
 * Two properties matter here. First, the text is FIXED per code: the raw
 * error message never crosses the boundary (ADM-BASE-03 - an upstream or
 * registry error can echo internals). Second, and more important, every
 * failure is UNAVAILABLE, never a plaintext downgrade: a tenant whose
 * delivery encryption is switched on but whose key is missing, revoked,
 * unresolvable or currently erroring gets a 503, because silently
 * downgrading is exactly the leak this feature exists to prevent.
 */
function deliveryEncryptionHttpError(err: DeliveryEncryptionError): HttpError {
  if (err.code === 'RECIPIENT_KEY_NOT_FOUND') {
    return new HttpError(
      503,
      'TEMPORARY_UNAVAILABLE',
      'encrypted delivery is unavailable: no recipient key is registered',
    );
  }
  if (err.code === 'RECIPIENT_KEY_REVOKED') {
    return new HttpError(
      503,
      'TEMPORARY_UNAVAILABLE',
      'encrypted delivery is unavailable: the recipient key is revoked',
    );
  }
  if (err.code === 'DELIVERY_ENCRYPTION_DISABLED') {
    return new HttpError(409, 'STATE_CONFLICT', 'delivery encryption is not enabled for this tenant');
  }
  return new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
}

/**
 * ENC-07: read a stored blob into memory with a hard byte ceiling. Streaming
 * is the default download path, but an encrypted delivery has to hold the
 * whole payload (AES-GCM is single-shot), so the buffer must be bounded
 * rather than trusted. Past the ceiling the stream is destroyed and the
 * request fails closed with 413 - a large artifact is a real limit, not a
 * reason to fall back to plaintext.
 */

/**
 * ENC-07: wrap a response payload in the delivery envelope when the tenant
 * policy asks for it. Returns null when the policy is absent or disabled, so
 * the caller serves its existing plaintext shape unchanged.
 */
async function encryptedDeliveryBody(
  ctx: RouteContext,
  tenantId: string,
  payload: Buffer,
  extra: Record<string, unknown> = {},
  resolved?: { policy: Awaited<ReturnType<NonNullable<RouteContext['deliveryEncryption']>['resolvePolicy']>> },
): Promise<{ body: Record<string, unknown> } | null> {
  // A caller that already resolved policy may pass it here so the size guard
  // and encryption decision use the same per-request policy snapshot.
  const policy = resolved === undefined
    ? await ctx.deliveryEncryption?.resolvePolicy(tenantId)
    : resolved.policy;
  if (!policy?.enabled) return null;
  const service = ctx.deliveryEncryption;
  if (!service) {
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
  }
  try {
    const delivery = await service.encryptForDelivery(tenantId, payload);
    return { body: { schemaVersion: '1', encrypted: true, delivery, ...extra } };
  } catch (err) {
    if (err instanceof DeliveryEncryptionError) throw deliveryEncryptionHttpError(err);
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
  }
}

export async function handlePublicRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  const { method, pathname } = ctx;

  // Public: GET /api/v1/usage/summary?from=<iso>&to=<iso> (P2-07 tenant usage projection).
  // Tenant-scoped via x-api-key; aggregates usage by provider/model over [from,to).
  if (method === 'GET' && pathname === '/api/v1/usage/summary') {
    const apiKey = await resolveApiKey(ctx);
    const from = ctx.searchParams.get('from');
    const to = ctx.searchParams.get('to');
    if (!from || !to) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'usage summary requires from and to query parameters');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    return { status: 200, body: await ctx.usage.getUsageSummary(apiKey.tenantId, fromDate, toDate) };
  }

  // COST-03: GET /api/v1/usage/events is a bounded keyset page shared by
  // aggregate drill-down and export clients. The principal determines tenant
  // scope before the usage service constructs SQL; every successful page is
  // audited without putting filter values, cursors, or credentials in the log.
  if (method === 'GET' && pathname === '/api/v1/usage/events') {
    const allowed = new Set([
      'tenantId', 'apiKeyId', 'businessId', 'action', 'profileRevision', 'provider', 'model',
      'operationId', 'from', 'to', 'timeField', 'limit', 'cursor',
    ]);
    const rawQuery: Record<string, unknown> = {};
    for (const [key, value] of ctx.searchParams.entries()) {
      if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(rawQuery, key)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'usage event query contains an unsupported or repeated parameter');
      }
      if (key === 'limit' || key === 'profileRevision') {
        if (!/^\d+$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', 'usage event query contains an invalid integer');
        rawQuery[key] = Number(value);
      } else {
        rawQuery[key] = value;
      }
    }
    const parsedQuery = UsageEventDrilldownQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) throw zodIssuesToProblem(parsedQuery.error.issues);

    const usagePrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    let tenantId: string;
    let actor: string;
    if (usagePrincipal) {
      tenantId = authorizeAuditTenantRead(usagePrincipal, parsedQuery.data.tenantId ?? '');
      if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'usage event export requires tenantId');
      actor = 'admin';
    } else {
      const apiKey = await resolveApiKey(ctx);
      if (parsedQuery.data.tenantId && parsedQuery.data.tenantId !== apiKey.tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'tenantId does not match api key tenant');
      }
      tenantId = apiKey.tenantId;
      actor = 'api-key';
    }

    const page = await ctx.usage.getUsageEventExportPage(tenantId, parsedQuery.data);
    await ctx.audit.record({
      tenantId,
      actor,
      action: 'usage.export',
      resource: 'usage-events:page',
      severity: 'info',
      correlationId: ctx.correlationId,
    });
    return { status: 200, body: page };
  }

  // Public: GET /api/v1/usage?tenantId=<uuid>&from=<iso>&to=<iso>
  // ADM-BASE-01: the shell's overview fetcher GETs exactly this path with
  // the admin bearer (not /usage/summary, which stays as-is for
  // Connector/x-api-key consumers). Admin bearer → tenantId REQUIRED from
  // the query (cross-tenant: it IS the admin console). x-api-key →
  // tenant from the key; an explicit tenantId param must match the key's
  // tenant or the request fails closed (no cross-tenant read via key).
  if (method === 'GET' && pathname === '/api/v1/usage') {
    const from = ctx.searchParams.get('from');
    const to = ctx.searchParams.get('to');
    if (!from || !to) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'usage summary requires from and to query parameters');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    // ADM-BASE-02: principal-aware admin branch. Platform keeps the exact
    // old contract (tenantId REQUIRED cross-tenant, 422 when missing); a
    // tenant operator may only read its own tenant — foreign tenantId is
    // 403, missing param falls back to the caller's own scope.
    const usagePrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (usagePrincipal) {
      const tenantId = authorizeAuditTenantRead(usagePrincipal, ctx.searchParams.get('tenantId') ?? '');
      if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'usage requires tenantId query parameter');
      return { status: 200, body: await ctx.usage.getUsageSummary(tenantId, fromDate, toDate) };
    }
    const apiKey = await resolveApiKey(ctx);
    const tenantParam = ctx.searchParams.get('tenantId');
    if (tenantParam && tenantParam !== apiKey.tenantId) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'tenantId does not match api key tenant');
    }
    return { status: 200, body: await ctx.usage.getUsageSummary(apiKey.tenantId, fromDate, toDate) };
  }

  // Public: GET /api/v1/connectors/:id/test (P2-07/CON-03 connector test proxy).
  // Tenant-scoped via x-api-key; proves the platform-registered Connector is
  // reachable. No caller headers are forwarded and no upstream error text is
  // echoed — failures surface as sanitized platform ProblemDetails only.
  {
    const m = /^\/api\/v1\/connectors\/([^/]+)\/test$/.exec(pathname);
    if (m && method === 'GET') {
      const apiKey = await resolveApiKey(ctx);
      const connectorId = decodeURIComponent(m[1]!);
      await authorizeConnectorProbe(ctx.db, apiKey, connectorId);
      const outcome = await ctx.connectors.testConnector(connectorId);
      return { status: 200, body: outcome };
    }
  }

  // Public uploads are tenant-fenced by x-api-key and use no producer lease.
  // Files below the multipart contract floor get a gateway-owned session;
  // larger sessions retain the existing initializer. The replay key is the
  // body uploadToken or an Idempotency-Key derived per tenant.
  {
    const content = /^\/api\/v1\/uploads\/([^/]+)(?:\/content)?$/.exec(pathname);
    if (method === 'PUT' && content) {
      const apiKey = await resolveApiKey(ctx);
      if (!ctx.publicUploadGateway) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted public uploads are not configured');
      }
      if (!ctx.bodyStream) throw new HttpError(400, 'MALFORMED_BODY', 'upload byte stream is required');
      const contentLength = ctx.headers['content-length'];
      const plaintextSha256 = ctx.headers['x-content-sha256'];
      const ack = await ctx.publicUploadGateway.upload({
        artifactId: decodeURIComponent(content[1]!),
        tenantId: apiKey.tenantId,
        source: ctx.bodyStream,
        ...(typeof contentLength === 'string' ? { contentLength } : {}),
        ...(typeof plaintextSha256 === 'string' ? { plaintextSha256 } : {}),
      });
      return { status: ack.replayed ? 200 : 201, body: ack };
    }
    if (method === 'POST' && pathname === '/api/v1/uploads') {
      const apiKey = await resolveApiKey(ctx);
      if (!ctx.publicUploadGateway) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted public uploads are not configured');
      }
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const maxUploadBytes = ctx.config.publicUploadEncryption?.maxBytes ?? 8 * 1024 * 1024 * 1024;
      if (typeof body.sizeBytes === 'number' && body.sizeBytes > maxUploadBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the encrypted upload size limit');
      }
      const headerKey = ctx.headers['idempotency-key'];
      const forwarded =
        typeof body.uploadToken === 'string' || typeof headerKey !== 'string' || headerKey.length === 0
          ? body
          : { ...body, uploadToken: publicUploadToken(apiKey.tenantId, headerKey) };
      const ack = typeof body.sizeBytes === 'number' && body.sizeBytes < MULTIPART_MIN_TOTAL_BYTES
        ? await ctx.publicUploadGateway.initSingle(apiKey.tenantId, forwarded)
        : await ctx.multipart.publicInit(apiKey.tenantId, forwarded);
      return {
        status: ack.replayed ? 200 : 201,
        body: { ...ack, uploadUrl: `/api/v1/uploads/${encodeURIComponent(ack.artifactId)}/content` },
      };
    }
    const m = /^\/api\/v1\/uploads\/([^/]+)\/(part|complete|abort)$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const artifactId = decodeURIComponent(m[1]!);
      if (m[2] === 'part') {
        throw new HttpError(409, 'STATE_CONFLICT', 'direct S3 upload grants are disabled for public uploads');
      }
      if (m[2] === 'complete') {
        if (!ctx.publicUploadGateway) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted public uploads are not configured');
        }
        return { status: 200, body: await ctx.publicUploadGateway.completeReplay(artifactId, apiKey.tenantId, ctx.body) };
      }
      return { status: 200, body: await ctx.multipart.publicAbort(artifactId, apiKey.tenantId, ctx.body) };
    }
  }

  // Legacy compat facade (COMP-03a/05/06/07/08). Mounted BEFORE the canonical
  // routes because the legacy paths are matched by their own table; a request
  // the facade does not own returns null and falls through unchanged. The
  // facade reproduces the old wire verbatim (status, headers, envelope) while
  // taking identity only from the API key — see compat/legacy-http-mount.ts.
  {
    let legacyTenantId: string | undefined;
    const legacy = await handleLegacyRoute(
      {
        method,
        pathname,
        searchParams: ctx.searchParams,
        headers: ctx.headers,
        body: ctx.body,
        ...(ctx.bodyStream ? { bodyStream: ctx.bodyStream } : {}),
        resolvePrincipal: async () => {
          const key = await resolveApiKey(ctx);
          // The download branch already authenticated through this resolver.
          // Reuse that exact tenant for delivery policy; never make a separate
          // unauthenticated key lookup or trust request data for tenant scope.
          legacyTenantId = key.tenantId;
          return { tenantId: key.tenantId, apiKeyId: key.id };
        },
      },
      legacyCompatHost(ctx),
    );
    if (legacy !== null) {
      // RCR-06: carry the legacy facade's raw bytes through — dropping `raw`
      // here re-truncated every binary response into `{}`.
      if (legacy.raw !== undefined) {
        if (legacyTenantId === undefined) {
          // The mount only returns bytes after resolving a principal. Treat a
          // broken handoff as unavailable; never let it become plaintext.
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'legacy download authorization is unavailable');
        }
        let policy: Awaited<ReturnType<NonNullable<RouteContext['deliveryEncryption']>['resolvePolicy']>>;
        try {
          policy = await ctx.deliveryEncryption?.resolvePolicy(legacyTenantId);
        } catch {
          // Policy lookup is part of the encryption decision. If it is
          // unavailable, serving the already-read output as plaintext would
          // be a delivery-policy downgrade.
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
        }
        if (policy?.enabled) {
          const maxBytes = ctx.config.maxBlobBytes ?? 64 * 1024 * 1024;
          if (legacy.raw.length > maxBytes) {
            throw new HttpError(413, 'TOO_LARGE', 'operation output exceeds the encrypted delivery size limit');
          }
          const encrypted = await encryptedDeliveryBody(
            ctx,
            legacyTenantId,
            legacy.raw,
            { mimeType: legacy.headers['content-type'] ?? 'application/octet-stream' },
            { policy },
          );
          if (!encrypted) {
            throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
          }
          // The JSON envelope replaces all binary headers. In particular, do
          // not forward the plaintext byte Content-Length or output MIME type.
          return {
            status: legacy.status,
            body: encrypted.body,
            headers: { 'content-type': 'application/json' },
          };
        }
      }
      return {
        status: legacy.status,
        body: legacy.body,
        headers: legacy.headers,
        ...(legacy.raw ? { raw: legacy.raw } : {}),
      };
    }
  }

  // Public: POST /api/v1/businesses/:id/actions/:action
  {
    const m = /^\/api\/v1\/businesses\/([^/]+)\/actions\/([^/]+)$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.submission.submit({
        tenantId: apiKey.tenantId,
        apiKeyId: apiKey.id,
        businessId: decodeURIComponent(m[1]!),
        action: decodeURIComponent(m[2]!),
        idempotencyKey: (ctx.headers['idempotency-key'] as string) || undefined,
        correlationId: ctx.correlationId,
        submission: ctx.body,
      });
      // URL submissions are admitted with a PENDING_INGESTION operation and
      // must not dispatch the business task until the ingestion worker pins a
      // version/hash and calls markIngestionReady. Inline submissions retain
      // the existing best-effort dispatch path.
      if (ctx.config.autoDispatch !== false && result.operation.state !== 'PENDING_INGESTION') {
        ctx.dispatcher.dispatchOnce().catch(() => undefined);
      }
      const status = result.replayed ? 200 : 202;
      return {
        status,
        body: {
          operationId: result.operation.id,
          state: result.operation.state,
          stateVersion: result.operation.stateVersion,
          replayed: result.replayed,
          correlationId: result.correlationId,
          links: result.operation.links,
        },
      };
    }
  }

  // Public: GET /api/v1/operations
  // ADM-BASE-01: the admin bearer is accepted as an ALTERNATE auth path
  // (the shell's operation fetcher sends `Authorization: Bearer <adminToken>`
  // with no x-api-key). ADM-UX-02 replaced the two divergent list envelopes
  // with ONE query contract on both paths: allow-listed `state`/`tenant`/
  // `id` filters, a server-enforced `limit` (default 20, max 100), a stable
  // keyset `cursor`, and `{ items, nextCursor, prevCursor, total, limit }`
  // where `total` is a COUNT of the filtered population (the old
  // `total = rows.length` is gone). The x-api-key path stays tenant-fenced
  // (R24-01 untouched) and gains the same read-only filters.
  if (method === 'GET' && pathname === '/api/v1/operations') {
    // ADM-BASE-02: the admin-bearer list is principal-aware. The tenant SCOPE
    // comes from the credential: a platform principal may narrow to any
    // tenant with `?tenant=`, a tenant operator is pinned to its own tenant
    // by SQL predicate (server-side fence, not post-filter) and gets 403 on a
    // foreign `tenant` — identical wording for foreign and unknown ids.
    const listPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (listPrincipal) {
      const query = parseOperationsListQuery(ctx.searchParams);
      const scope = authorizeAuditTenantRead(listPrincipal, query.tenantId ?? '');
      return {
        status: 200,
        body: await listOperationsPage(ctx, query, scope === '' ? null : scope, toOperationDetailWire),
      };
    }
    const apiKey = await resolveApiKey(ctx);
    const query = parseOperationsListQuery(ctx.searchParams);
    // R24-01: on the public path the API KEY is the fence, never a query
    // parameter — `tenant` is not a scope selector here, it is only honoured
    // when it equals the key's own tenant (a foreign value 403s rather than
    // being silently ignored, so no caller believes it widened its view).
    if (query.tenantId !== null && query.tenantId !== apiKey.tenantId) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'admin reads are scoped to the caller tenant');
    }
    return {
      status: 200,
      body: await listOperationsPage(ctx, query, apiKey.tenantId, toOperationView),
    };
  }

  // Public: GET /api/v1/operations/:id  (P2-08 facade, `?wait=<seconds>` long-poll)
  // R24-01: the read is tenant-scoped BEFORE the poll starts and stays
  // tenant-scoped on every 500 ms re-read inside waitForTerminal, so a
  // foreign id 404s promptly (no timing leak, no wasted DB polling) and an
  // operation that changes hands/is cancelled mid-poll re-fences per
  // iteration. No post-poll tenant comparison is needed — or trusted.
  {
    const m = /^\/api\/v1\/operations\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET' && !pathname.endsWith('/result')) {
      // ADM-BASE-01: admin bearer alternate path — the shell's detail
      // fetcher GETs this same URL with the admin token. Admin gets the
      // merged `{ operation, result, artifacts, serverNow }` envelope the
      // fetcher parses (cross-tenant: it IS the admin console). The
      // x-api-key path below is unchanged (tenant-fenced plain view).
      // ADM-BASE-02: by-id admin detail is principal-aware. A tenant
      // operator reaching a foreign operation gets the SAME 404 as a
      // missing row (R24-01 precedent — no existence leak on by-id access);
      // platform behavior unchanged.
      const detailPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (detailPrincipal) {
        if (detailPrincipal.role === 'tenant_operator') {
          const op = await ctx.runtime.getOperation(m[1]!);
          requireResourceTenant(detailPrincipal, String(op.tenant_id));
        }
        return { status: 200, body: await buildAdminOperationDetail(ctx, m[1]!) };
      }
      const apiKey = await resolveApiKey(ctx);
      const waitParam = ctx.searchParams.get('wait');
      const waitSeconds = waitParam ? parseInt(waitParam, 10) : 0;
      const op = await waitForTerminal(
        (id) => ctx.runtime.getTenantOperation(id, apiKey.tenantId),
        m[1]!,
        Number.isFinite(waitSeconds) ? waitSeconds : 0
      );
      return { status: 200, body: toOperationView(op) };
    }
  }

  // Public: GET /api/v1/operations/:id/result  (P2-08 facade)
  // CR-12/MM-02: the envelope now projects REAL artifact refs (never []):
  // submission-declared inputs (top-level roles from `submit_artifacts`,
  // persisted verbatim at submit) plus task-produced outputs (READY rows
  // verified at completion time, purpose 'output'). `data` carries the worker's
  // opaque resultRef verbatim (no envelope guessing); `download` is a
  // relative public URL per ArtifactRefSchema — the GET below mints a real
  // download for READY rows after a tenant-scoped check.
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/result$/.exec(pathname);
    if (m && method === 'GET') {
      const apiKey = await resolveApiKey(ctx);
      const op = await ctx.runtime.getOperation(m[1]!);
      if ((op.tenant_id as string) !== apiKey.tenantId) throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      const status = resultHttpStatus(op.state as string);
      if (status !== 200) {
        if (status === 410) {
          throw new HttpError(410, 'GONE', `operation ${op.state as string} is expired`);
        }
        throw new HttpError(409, 'STATE_CONFLICT', `operation is ${op.state as string}, not SUCCEEDED`);
      }
      const arts = await ctx.db.query(
        `SELECT a.id, a.purpose, a.mime_type, a.size_bytes, a.sha256, a.state,
                COALESCE(o.submit_artifacts, '[]'::jsonb) AS submit_roles
         FROM operations o
         LEFT JOIN artifacts a
           ON a.state = 'READY'
          AND a.tenant_id = o.tenant_id
          AND a.purpose IN ('input', 'output')
          AND (
            (a.operation_id = o.id AND a.purpose = 'output')
            OR COALESCE(o.submit_artifacts, '[]'::jsonb) @>
               jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
          )
         WHERE o.id = $1`,
        [m[1]!]
      );
      const submitRoles = new Map<string, string>();
      for (const row of arts.rows as { submit_roles: unknown }[]) {
        const declared = (row.submit_roles as { artifactId?: unknown; role?: unknown }[] | null) ?? [];
        if (Array.isArray(declared)) {
          for (const d of declared) {
            if (typeof d?.artifactId === 'string' && typeof d?.role === 'string') {
              submitRoles.set(d.artifactId, d.role);
            }
          }
        }
        break;
      }
      const artifacts = (arts.rows as {
        id: string | null; purpose: string | null; mime_type: string | null;
        size_bytes: number | string | null; sha256: string | null; state: string | null;
      }[])
        .filter((r) => r.id !== null)
        .map((r) => ({
          artifactId: r.id as string,
          role: submitRoles.get(r.id as string) ?? r.purpose ?? 'output',
          mimeType: r.mime_type ?? undefined,
          sizeBytes: r.size_bytes === null ? undefined : Number(r.size_bytes),
          hashSha256: r.sha256 ?? undefined,
          download: `/api/v1/artifacts/${r.id as string}/download`,
        }));
      // ENCMETA-RESULTREF R1: the stored copy is sealed under the operation's
      // own slot; open it here and project the SAME opaque string — the public
      // wire shape does not change. No seam / legacy plaintext row → the
      // historical verbatim value (the standard backfill-window convention).
      const openedResultRef =
        op.result_ref == null
          ? undefined
          : await (ctx.metadataReader ?? compatibilityMetadataReader(ctx.metadataCrypto)).readStoredText(
              String(op.result_ref),
              { tenantId: apiKey.tenantId, slot: 'operations.result_ref', refId: String(op.id) },
            );
      const plaintextResult = {
        schemaVersion: '1',
        data: openedResultRef ? { resultRef: openedResultRef } : {},
        artifacts,
        usage: await ctx.usage.project(m[1]!),
        warnings: [],
      };
      // ENC-07: the tenant policy, not the caller, decides the wire shape. A
      // client cannot ask for plaintext here, and a failed encryption is a
      // 503 rather than a downgrade, so /result can never quietly serve
      // plaintext under a tenant that switched encryption on.
      const encrypted = await encryptedDeliveryBody(
        ctx,
        apiKey.tenantId,
        Buffer.from(JSON.stringify(plaintextResult), 'utf8'),
      );
      if (encrypted) return { status: 200, body: encrypted.body };
      return {
        status: 200,
        body: plaintextResult,
      };
    }
  }

  // Public: GET /api/v1/artifacts/:id/download  (CR-12/MM-02)
  // Tenant-scoped download for published READY inputs/outputs. Unlike the
  // runtime blob route (grant-bearer, worker lane), this route is tenant-scoped
  // rows 409 (bytes not yet integrity-verified); foreign/missing ids 404
  // (indistinguishable, no existence leak). Bytes stream raw
  // (application/octet-stream, CR-13 wire), not wrapped or re-encoded.
  {
    const m = /^\/api\/v1\/artifacts\/([^/]+)\/download$/.exec(pathname);
    if (m && method === 'GET') {
      const apiKey = await resolveApiKey(ctx);
      const res = await ctx.db.query(
        `SELECT a.state, a.mime_type, a.tenant_id, a.storage_key, a.upload_token, a.manifest_version_id
         FROM artifacts a
         WHERE a.id = $1 AND a.tenant_id = $2
           AND a.purpose IN ('input', 'output')
           AND (
             (a.purpose = 'output' AND EXISTS (
               SELECT 1 FROM operations owner_op
               WHERE owner_op.id = a.operation_id
                 AND owner_op.tenant_id = $2 AND owner_op.state = 'SUCCEEDED'
             ))
             OR EXISTS (
               SELECT 1 FROM operations ref_op
               WHERE ref_op.tenant_id = $2 AND ref_op.state = 'SUCCEEDED'
                 AND COALESCE(ref_op.submit_artifacts, '[]'::jsonb) @>
                     jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
             )
           )`,
        [m[1]!, apiKey.tenantId]
      );
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `artifact ${m[1]} not found`);
      const row = res.rows[0] as {
        state: string; mime_type: string; tenant_id: string; storage_key: string;
        upload_token: string | null; manifest_version_id: string | null;
      };
      if (row.state !== 'READY') {
        throw new HttpError(409, 'STATE_CONFLICT', `artifact ${m[1]} is ${row.state}, not READY`);
      }
      // CR28-01: the payload may be sealed at rest. Decrypt BEFORE deciding
      // how to deliver it, so neither branch can hand a caller ciphertext:
      // the plaintext branch would label ciphertext as the document, and the
      // encrypted-delivery branch would double-wrap it for the recipient.
      const stored = ctx.artifactDecryptDeps
        ? await decryptStoredArtifact(ctx.artifactDecryptDeps, {
            artifactId: m[1]!,
            tenantId: apiKey.tenantId,
            storageKey: row.storage_key,
            uploadToken: row.upload_token,
            // RFX-05-residual: pin the sidecar generation the row committed.
            manifestVersionId: row.manifest_version_id,
          })
        : null;
      const stream = stored ? Readable.from([stored.bytes]) : await ctx.artifacts.getBlob(row.storage_key);
      // ENC-07: the same server-side policy that governs /result governs the
      // bytes here. Wrapping only the metadata and streaming raw bytes
      // underneath it would leave the payload - the part that matters - in
      // plaintext, so both routes encrypt or neither does.
      const downloadPolicy = await ctx.deliveryEncryption?.resolvePolicy(apiKey.tenantId);
      if (downloadPolicy?.enabled) {
        // Encrypting needs the whole payload in memory (AES-GCM is single
        // shot), which is exactly what the streaming download avoids. The
        // read is therefore bounded by the same cap the ingress enforces, and
        // an artifact past it FAILS CLOSED rather than quietly degrading to
        // an unbounded buffer.
        const bytes = await readStreamBounded(stream, ctx.config.maxBlobBytes ?? 64 * 1024 * 1024);
        const encrypted = await encryptedDeliveryBody(
          ctx,
          apiKey.tenantId,
          bytes,
          { artifactId: m[1]!, mimeType: row.mime_type || 'application/octet-stream' },
        );
        if (!encrypted) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
        return {
          status: 200,
          body: encrypted.body,
          headers: { 'content-type': 'application/json' },
        };
      }
      return {
        status: 200,
        raw: stream,
        headers: { 'content-type': row.mime_type || 'application/octet-stream' },
      };
    }
  }

  // Public: POST /api/v1/operations/:id/cancel  (P2-06, idempotent, tenant-scoped)
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/cancel$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.lifecycle.cancelOperation(m[1]!, apiKey.tenantId);
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Public: POST /api/v1/operations/:id/resume  (W13-C item 4: tenant-scoped, CAS)
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/resume$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.runtime.resumeOperation(m[1]!, apiKey.tenantId, ctx.body as never);
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  return null;
}

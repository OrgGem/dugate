/**
 * CONV-02: the public/x-api-key audience (all `/api/v1/` routes, the legacy
 * compat facade and the ENC-07 delivery helpers), moved verbatim out of
 * server.ts route(). The delivery helpers used to be nested inside route();
 * they are now module-level and only this family calls them.
 */
import { Readable } from 'node:stream';
import { resultHttpStatus, toOperationView } from '../../modules/operations/facade';
import { listOperationsPage, parseOperationsListQuery } from '../../modules/operations/list-query';
import { compatibilityMetadataReader } from '../../modules/encryption/metadata-read-policy';
import { HttpError, zodIssuesToProblem } from '../errors';
import { MULTIPART_MIN_TOTAL_BYTES, UsageEventDrilldownQuerySchema } from '@du/contracts';
import { publicUploadToken } from '../../modules/artifacts/multipart-service';
import { DeliveryEncryptionError } from '../../modules/public-api';
import { decryptStoredArtifact } from '../../modules/encryption/artifact-read-decrypt';
import { handleLegacyRoute } from '../../compat/legacy-http-mount';
import { legacyCompatHost } from '../../compat/legacy-host-adapter';
import {
  authorizeAuditTenantRead,
  resolveAdminPrincipal,
} from '../../modules/admin-actions/rbac';
import { readStreamBounded } from './public-bounded-body';
import { resolveApiKey } from './api-key-auth';
import { authorizeConnectorProbe } from '../../modules/connectors/probe-authorization';
import { readIdempotencyKey } from '../../modules/idempotency/idempotency';
import {
  ProfileGroupPreviewV2RequestSchema,
  ProfileGroupSubmitV2RequestSchema,
} from '@du/contracts';
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

async function requireOwnedUpload(ctx: RouteContext, artifactId: string, key: { id: string; tenantId: string }): Promise<void> {
  const owned = await ctx.db.query(
    "SELECT id FROM artifacts WHERE id=$1 AND tenant_id=$2 AND upload_api_key_id=$3 AND purpose='input' AND operation_id IS NULL AND task_id IS NULL",
    [artifactId, key.tenantId, key.id],
  );
  if (!owned.rowCount) throw new HttpError(404, 'NOT_FOUND', 'upload not found');
}

type PublicResumeBodyKind = 'legacy' | 'cas' | 'mixed';

function publicResumeBodyKind(body: unknown): PublicResumeBodyKind {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'legacy';
  const value = body as Record<string, unknown>;
  const hasCasField = ['waitId', 'input', 'expectedStateVersion'].some((key) => Object.hasOwn(value, key));
  const hasLegacyField = ['step', 'extracted_data'].some((key) => Object.hasOwn(value, key));
  if (hasCasField && hasLegacyField) return 'mixed';
  return hasCasField ? 'cas' : 'legacy';
}

async function handlePublicCasResume(
  ctx: RouteContext,
  operationId: string,
  apiKey: { id: string; tenantId: string },
): Promise<RouteResult> {
  const result = await ctx.db.tx(async (client) => {
    return ctx.runtime.resumeOperation(
      operationId,
      apiKey.tenantId,
      ctx.body as { waitId: string; input: unknown; expectedStateVersion: number },
      client,
      apiKey.id,
    );
  });
  return { status: result.replayed ? 200 : 202, body: result };
}

/**
 * PC-05 — public v2 profile-group resolution.
 *
 *   POST /api/v2/profile-groups/:groupId/preview
 *   POST /api/v2/profile-groups/:groupId/operations
 *
 * The group is addressed by PATH only: the request DTOs are `.strict()` and
 * carry no `groupId`, so a client cannot claim one group's selector while
 * resolving another group's grant. Both routes authenticate with the presented
 * `x-api-key`; the resolver decides whether that key is group-managed.
 */
async function handlePublicProfileGroupsV2(ctx: RouteContext): Promise<RouteResult> {
  const match = /^\/api\/v2\/profile-groups\/([^/]+)\/(preview|operations)$/.exec(ctx.pathname);
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  if (ctx.method !== 'POST') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile group v2 routes require POST');
  }
  if ([...ctx.searchParams].length > 0) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'profile group v2 routes do not accept query parameters');
  }
  let groupId: string;
  try {
    groupId = decodeURIComponent(match[1]!);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  }
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const apiKey = await resolveApiKey(ctx);

  if (match[2] === 'preview') {
    const parsed = ProfileGroupPreviewV2RequestSchema.safeParse(ctx.body);
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    const preview = await ctx.submission.previewProfileV2({
      tenantId: apiKey.tenantId,
      apiKeyId: apiKey.id,
      groupId,
      selector: {
        businessId: parsed.data.businessId,
        businessVersion: parsed.data.businessVersion,
        action: parsed.data.action,
        functionId: parsed.data.functionId,
        ...(parsed.data.endpointSlug ? { endpointSlug: parsed.data.endpointSlug } : {}),
      },
      submission: parsed.data.submission,
      correlationId: ctx.correlationId,
    });
    return { status: 200, body: preview };
  }

  const parsed = ProfileGroupSubmitV2RequestSchema.safeParse(ctx.body);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  const idempotencyKey = readIdempotencyKey(ctx.headers);
  if (!idempotencyKey) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'profile group v2 submission requires an Idempotency-Key');
  }
  const result = await ctx.submission.submitProfileV2({
    tenantId: apiKey.tenantId,
    apiKeyId: apiKey.id,
    groupId,
    selector: {
      businessId: parsed.data.businessId,
      businessVersion: parsed.data.businessVersion,
      action: parsed.data.action,
      functionId: parsed.data.functionId,
      ...(parsed.data.endpointSlug ? { endpointSlug: parsed.data.endpointSlug } : {}),
    },
    submission: parsed.data.submission,
    resolutionFingerprint: parsed.data.resolutionFingerprint,
    idempotencyKey,
    correlationId: ctx.correlationId,
  });
  if (ctx.config.autoDispatch !== false && result.operation.state !== 'PENDING_INGESTION') {
    ctx.dispatcher.dispatchOnce().catch(() => undefined);
  }
  return {
    status: result.replayed ? 200 : 202,
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

export async function handlePublicRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  const { method, pathname } = ctx;

  // PC-05: public v2 profile-group resolution. The `/api/v2` prefix is disjoint
  // from every handler family tried before this one and from the legacy public
  // regexes below, so claiming it here needs no `server.ts` registration.
  if (pathname === '/api/v2/profile-groups' || pathname.startsWith('/api/v2/profile-groups/')) {
    return handlePublicProfileGroupsV2(ctx);
  }

  // Preserve the published API-key operation flow. Unsupported management
  // extensions (metrics/retry) remain absent; admin operations live under the
  // internal prefix and are not selected by a bearer on this public surface.
  if (pathname === '/api/v1/operations' || pathname.startsWith('/api/v1/operations/')) {
    const legacyOperationPath = pathname === '/api/v1/operations'
      || /^\/api\/v1\/operations\/[^/]+(?:\/(?:result|download|cancel|resume))?$/.test(pathname);
    if (pathname === '/api/v1/operations/metrics' || !legacyOperationPath) {
      throw new HttpError(404, 'NOT_FOUND', 'Not Found');
    }
  }

  // The published rework API accepted a CAS resume body and returned the
  // runtime acknowledgement (202 fresh / 200 replay). The original
  // compatibility facade also accepts `{step, extracted_data}` and keeps its
  // legacy success envelope. Dispatch only the CAS shape here; reject a body
  // that combines both dialects instead of silently discarding its CAS fields.
  const publicResumeMatch = /^\/api\/v1\/operations\/([^/]+)\/resume$/.exec(pathname);
  if (method === 'POST' && publicResumeMatch !== null) {
    const bodyKind = publicResumeBodyKind(ctx.body);
    if (bodyKind !== 'legacy') {
      const apiKey = await resolveApiKey(ctx);
      if (bodyKind === 'mixed') {
        throw new HttpError(422, 'INVALID_SCHEMA', 'resume body must use either the CAS or legacy input fields');
      }
      let operationId: string;
      try {
        operationId = decodeURIComponent(publicResumeMatch[1]!);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      }
      if (!operationId || operationId.includes('/') || operationId.includes('\\')) {
        throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      }
      return handlePublicCasResume(ctx, operationId, apiKey);
    }
  }


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
      await requireOwnedUpload(ctx, decodeURIComponent(content[1]!), apiKey);
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
      if (typeof body.uploadToken === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.uploadToken)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'uploadToken must be a UUID');
      }
      // Namespace replay tokens by authenticated key before initialization, so
      // concurrent keys cannot race to claim one newly-created orphan row.
      const clientToken = typeof body.uploadToken === 'string' ? body.uploadToken : typeof headerKey === 'string' && headerKey.length ? headerKey : undefined;
      const forwarded = clientToken === undefined ? body
        : { ...body, uploadToken: publicUploadToken(apiKey.tenantId, `${apiKey.id}:${clientToken}`) };
      const ack = typeof body.sizeBytes === 'number' && body.sizeBytes < MULTIPART_MIN_TOTAL_BYTES
        ? await ctx.publicUploadGateway.initSingle(apiKey.tenantId, forwarded)
        : await ctx.multipart.publicInit(apiKey.tenantId, forwarded);
      const bound = await ctx.db.query(
        "UPDATE artifacts SET upload_api_key_id=$3 WHERE id=$1 AND tenant_id=$2 AND purpose='input' AND operation_id IS NULL AND task_id IS NULL AND (upload_api_key_id IS NULL OR upload_api_key_id=$3)",
        [ack.artifactId, apiKey.tenantId, apiKey.id],
      );
      if (!bound.rowCount) throw new HttpError(409, 'STATE_CONFLICT', 'upload token belongs to another API key');
      return {
        status: ack.replayed ? 200 : 201,
        body: { ...ack, uploadUrl: `/api/v1/uploads/${encodeURIComponent(ack.artifactId)}/content` },
      };
    }
    const m = /^\/api\/v1\/uploads\/([^/]+)\/(part|complete|abort)$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const artifactId = decodeURIComponent(m[1]!);
      await requireOwnedUpload(ctx, artifactId, apiKey);
      if (m[2] === 'part') {
        // CR06-10: a direct-S3 `part` grant is the same capability the
        // encryption-gated public multipart refuses, so it must report the
        // SAME status+code as assertPublicMultipartAllowed
        // (multipart-service.ts:81) — 501 PUBLIC_MULTIPART_UNAVAILABLE.
        // The old 409 STATE_CONFLICT read as "try again", implying a retry
        // could succeed; 501 says this deployment does not offer it.
        throw new HttpError(
          501,
          'PUBLIC_MULTIPART_UNAVAILABLE',
          'public multipart upload is not available while artifact encryption is required; ' +
            'use the encrypted upload gateway (single PUT or multipart) instead',
        );
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
  // The published rework list query (`limit`/`cursor` and its filters) is an
  // additional API-key dialect. Keep it separate from the original
  // `filter`/`page_size`/`page_token` contract so both response projections and
  // pagination tokens remain wire-compatible. Admin bearer lists stay closed
  // on this public route.
  if (method === 'GET' && pathname === '/api/v1/operations'
      && !((ctx.headers['authorization'] ?? '').trim().toLowerCase().startsWith('bearer '))) {
    const canonicalListParameters = new Set([
      'limit', 'cursor', 'state', 'tenant', 'id', 'sort', 'from', 'to',
      'business', 'action', 'apiKey', 'profile', 'correlation', 'provider',
      'model', 'usage', 'reservation', 'attention',
    ]);
    const usesCanonicalQuery = Array.from(ctx.searchParams.keys()).some((key) => canonicalListParameters.has(key));
    if (usesCanonicalQuery) {
      const apiKey = await resolveApiKey(ctx);
      const query = parseOperationsListQuery(ctx.searchParams);
      if (query.tenantId !== null && query.tenantId !== apiKey.tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'admin reads are scoped to the caller tenant');
      }
      return {
        status: 200,
        body: await listOperationsPage(ctx, query, apiKey.tenantId, toOperationView, null, apiKey.id),
      };
    }
  }

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

  // Public ResultEnvelope path retained for clients of the published rework
  // API. Resolve an ACTIVE API key first, then scope the operation read by both
  // tenant and key before projecting any result or artifact metadata. A bearer
  // token alone never authorizes this public route.
  {
    const match = /^\/api\/v1\/operations\/([^/]+)\/result$/.exec(pathname);
    if (method === 'GET' && match) {
      const authorization = ctx.headers['authorization'];
      if (typeof authorization === 'string' && authorization.trim().toLowerCase().startsWith('bearer ')) {
        return null;
      }
      const apiKey = await resolveApiKey(ctx);
      let operationId: string;
      try {
        operationId = decodeURIComponent(match[1]!);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      }
      if (!operationId || operationId.includes('/') || operationId.includes('\\')) {
        throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      }
      const operation = await ctx.db.query(
        `SELECT id, tenant_id, api_key_id, state, result_ref, endpoint_slug
           FROM operations
          WHERE id=$1 AND tenant_id=$2 AND api_key_id=$3 AND deleted_at IS NULL`,
        [operationId, apiKey.tenantId, apiKey.id],
      );
      if (!operation.rowCount) throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      return buildOperationResult(ctx, operation.rows[0] as Record<string, unknown>);
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
        `SELECT a.state, a.mime_type, a.tenant_id, a.storage_key, a.storage_generation_id, a.upload_token, a.manifest_version_id, a.storage_version_id, a.sha256, a.size_bytes
         FROM artifacts a
         WHERE a.id = $1 AND a.tenant_id = $2
           AND a.purpose IN ('input', 'output')
           AND (
             (a.purpose = 'output' AND EXISTS (
               SELECT 1 FROM operations owner_op
               WHERE owner_op.id = a.operation_id
                 AND owner_op.tenant_id = $2 AND owner_op.api_key_id = $3
                 AND owner_op.deleted_at IS NULL AND owner_op.state = 'SUCCEEDED'
             ))
             OR EXISTS (
               SELECT 1 FROM operations ref_op
               WHERE ref_op.tenant_id = $2 AND ref_op.api_key_id = $3
                 AND ref_op.deleted_at IS NULL AND ref_op.state = 'SUCCEEDED'
                 AND COALESCE(ref_op.submit_artifacts, '[]'::jsonb) @>
                     jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
             )
           )`,
        [m[1]!, apiKey.tenantId, apiKey.id]
      );
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `artifact ${m[1]} not found`);
      const row = res.rows[0] as {
        state: string; mime_type: string; tenant_id: string; storage_key: string; storage_generation_id: string | null;
        upload_token: string | null; manifest_version_id: string | null; storage_version_id: string | null; sha256: string | null; size_bytes: string | number | null;
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
            storageGenerationId: row.storage_generation_id,
            uploadToken: row.upload_token,
            // RFX-05-residual: pin the sidecar generation the row committed.
            manifestVersionId: row.manifest_version_id,
            storageVersionId: row.storage_version_id,
            ciphertextSha256: row.sha256,
            ciphertextSizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
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

  return null;
}

/** Canonical result projection after the caller authorizes the operation. */
export async function buildOperationResult(ctx: RouteContext, op: Record<string, unknown>): Promise<RouteResult> {
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
    [String(op.id)]
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
          { tenantId: String(op.tenant_id), slot: 'operations.result_ref', refId: String(op.id) },
        );
  const plaintextResult = {
    schemaVersion: '1',
    data: openedResultRef ? { resultRef: openedResultRef } : {},
    artifacts,
    usage: await ctx.usage.project(String(op.id)),
    warnings: [],
  };
  // ENC-07: the tenant policy, not the caller, decides the wire shape. A
  // client cannot ask for plaintext here, and a failed encryption is a
  // 503 rather than a downgrade, so /result can never quietly serve
  // plaintext under a tenant that switched encryption on.
  const encrypted = await encryptedDeliveryBody(
    ctx,
    String(op.tenant_id),
    Buffer.from(JSON.stringify(plaintextResult), 'utf8'),
  );
  if (encrypted) return { status: 200, body: encrypted.body };
  return {
    status: 200,
    body: plaintextResult,
  };
}

/** Output bytes for an already-authorized administrative operation. */
export async function buildOperationDownload(ctx: RouteContext, op: Record<string, unknown>): Promise<RouteResult> {
  if (op.state !== 'SUCCEEDED') throw new HttpError(409, 'STATE_CONFLICT', 'operation has not completed successfully');
  const host = legacyCompatHost(ctx);
  const tenantId = String(op.tenant_id);
  const keyId = String(op.api_key_id ?? '');
  const row = await host.loadOperation(String(op.id), tenantId, keyId);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'not found');
  const bytes = await host.loadOutputContent(String(op.id), tenantId, keyId);
  if (!bytes) throw new HttpError(404, 'NOT_FOUND', 'operation output is unavailable');
  const mimeType = row.outputFormat === 'html' ? 'text/html; charset=utf-8'
    : row.outputFormat === 'json' ? 'application/json' : 'text/markdown; charset=utf-8';
  const encrypted = await encryptedDeliveryBody(ctx, tenantId, bytes, { mimeType });
  if (encrypted) return { status: 200, body: encrypted.body, headers: { 'content-type': 'application/json' } };
  return { status: 200, raw: bytes, headers: { 'content-type': mimeType, 'content-length': String(bytes.length),
    'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } };
}

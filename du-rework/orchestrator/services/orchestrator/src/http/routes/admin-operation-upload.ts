import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';
import { authorizeAuditTenantRead, type AdminActionAuth, type AdminPrincipal } from '../../modules/admin-actions/rbac';

export const ADMIN_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const uploadQuery = z.object({ tenantId: z.string().uuid(), apiKeyId: z.string().uuid(), fileName: z.string().min(1).max(255).refine(n => !/[\\/\u0000-\u001f\u007f]/.test(n) && n !== '.' && n !== '..') }).strict();

/** Bounded source; never materializes arbitrary caller bytes. */
async function* boundedSource(source: AsyncIterable<Uint8Array>, expected: number | null, limit: number): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  const iterable = source instanceof Readable ? source.iterator({ destroyOnReturn: false }) : source;
  for await (const chunk of iterable) {
    bytes += chunk.byteLength;
    if (bytes > limit || (expected !== null && bytes > expected)) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'file exceeds upload limit');
    yield chunk;
  }
  if (!bytes || (expected !== null && bytes !== expected)) throw new HttpError(400, 'MALFORMED_BODY', 'file length does not match request');
}

export async function uploadAdminOperationArtifact(ctx: RouteContext, auth: AdminActionAuth, principal: AdminPrincipal): Promise<RouteResult> {
  if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'file upload requires POST');
  if (auth.kind === 'cookie' && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (auth.kind === 'cookie' && auth.role === 'viewer') throw new HttpError(403, 'PERMISSION_DENIED', 'viewer cannot upload files');
  const parsed = uploadQuery.safeParse(Object.fromEntries(ctx.searchParams));
  if (!parsed.success || [...ctx.searchParams.keys()].length !== 3) throw new HttpError(422, 'INVALID_SCHEMA', 'upload requires tenantId, apiKeyId and a valid fileName');
  const p = parsed.data;
  authorizeAuditTenantRead(principal, p.tenantId);
  const mimeType = ctx.headers['content-type'] ?? 'application/octet-stream';
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType) || mimeType.length > 127) throw new HttpError(422, 'INVALID_SCHEMA', 'upload requires a valid file MIME type');
  const limit = Math.min(ADMIN_UPLOAD_MAX_BYTES, ctx.config.maxBlobBytes ?? ADMIN_UPLOAD_MAX_BYTES, ctx.config.publicUploadEncryption?.maxBytes ?? ADMIN_UPLOAD_MAX_BYTES);
  const length = ctx.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1)) throw new HttpError(400, 'MALFORMED_BODY', 'invalid file length');
  const expected = length === undefined ? null : Number(length);
  if (expected !== null && expected > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'file exceeds upload limit');
  const key = await ctx.db.query("SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'", [p.apiKeyId, p.tenantId]);
  if (!key.rowCount) throw new HttpError(404, 'NOT_FOUND', 'active API key not found in tenant');
  ctx.artifacts.assertPublicArtifactEncryptionReady();
  if (!ctx.bodyStream) throw new HttpError(400, 'MALFORMED_BODY', 'file stream is required');
  const source = boundedSource(ctx.bodyStream, expected, limit);
  let artifactId: string | undefined;
  let sizeBytes = 0;
  try {
    if (ctx.publicUploadGateway && expected !== null) {
      const init = await ctx.publicUploadGateway.initSingle(p.tenantId, { uploadToken: randomUUID(), fileName: p.fileName, mimeType, sizeBytes: expected });
      artifactId = init.artifactId;
      const bound = await ctx.db.query('UPDATE artifacts SET upload_api_key_id=$3 WHERE id=$1 AND tenant_id=$2 AND upload_api_key_id IS NULL', [artifactId, p.tenantId, p.apiKeyId]);
      if (!bound.rowCount) throw new HttpError(409, 'STATE_CONFLICT', 'upload ownership could not be established');
      await ctx.publicUploadGateway.upload({ artifactId, tenantId: p.tenantId, source, contentLength: String(expected) });
      sizeBytes = expected;
    } else {
      // PostgreSQL encrypted backend uses its bounded writer (max16MiB here).
      const chunks: Buffer[] = [];
      for await (const chunk of source) { sizeBytes += chunk.byteLength; chunks.push(Buffer.from(chunk)); }
      const stored = await ctx.artifacts.putPublicArtifact({ tenantId: p.tenantId, apiKeyId: p.apiKeyId, fileName: p.fileName, mimeType, bytes: Buffer.concat(chunks, sizeBytes), requireEncryption: true });
      artifactId = stored.artifactId;
    }
    await ctx.audit.record({ tenantId: p.tenantId, actor: auth.kind === 'cookie' ? `shell:${auth.role}` : 'admin', ...(auth.kind === 'cookie' ? { actorIssuer: auth.issuer, actorSub: auth.principalId, actorRole: auth.role } : {}), action: 'artifact.upload', resource: `artifact:${artifactId}`, correlationId: ctx.correlationId });
    return { status: 201, body: { artifactId, state: 'READY', fileName: p.fileName, mimeType, sizeBytes } };
  } catch (error) {
    if (artifactId) await ctx.artifacts.cleanupUnlinkedPublicArtifacts(p.tenantId, [artifactId]).catch(() => undefined);
    throw error;
  }
}

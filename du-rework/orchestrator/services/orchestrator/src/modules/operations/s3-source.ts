import { HeadObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SourceAcquisitionError, type SourceIngestorOptions, type AcquiredSource } from '@du/worker-sdk';
import { z } from 'zod';

const RuleSchema = z.object({
  tenantId: z.string().uuid(),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  prefix: z.string().max(1024).refine(value => (value === '' || value.endsWith('/')) && !/[\x00-\x1f\x7f]/.test(value)),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  expectedBucketOwner: z.string().regex(/^\d{12}$/),
}).strict();
export type S3SourceRule = z.infer<typeof RuleSchema>;

export function s3SourceRulesFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): S3SourceRule[] {
  if (!env.DU_S3_SOURCE_RULES) return [];
  try { return z.array(RuleSchema).parse(JSON.parse(env.DU_S3_SOURCE_RULES)); }
  catch { throw new Error('DU_S3_SOURCE_RULES must be an array of tenantId/bucket/prefix/region/expectedBucketOwner rules'); }
}

export function parseS3Source(raw: string) {
  // Parse without URL path normalization: S3 keys are opaque, not filesystem paths.
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/([^?#]+)(?:\?versionId=([^&#]+))?$/.exec(raw);
  if (!match) throw new SourceAcquisitionError(422, 'INVALID_URL', 'invalid S3 object URI');
  let key: string, versionId: string | undefined;
  try { key = decodeURIComponent(match[2]!); versionId = match[3] ? decodeURIComponent(match[3]) : undefined; }
  catch { throw new SourceAcquisitionError(422, 'INVALID_URL', 'invalid S3 object URI encoding'); }
  if (!key || Buffer.byteLength(key) > 1024 || /[\x00-\x1f\x7f]/.test(key) ||
      (versionId !== undefined && (!versionId || versionId === 'null' || versionId.length > 1024 || /[\x00-\x1f\x7f]/.test(versionId)))) {
    throw new SourceAcquisitionError(422, 'INVALID_URL', 'invalid S3 object identity');
  }
  return { bucket: match[1]!, key, versionId };
}

export function authorizeS3Source(raw: string, tenantId: string, rules: readonly S3SourceRule[]) {
  const { bucket, key, versionId } = parseS3Source(raw);
  const rule = rules.find(candidate => candidate.tenantId === tenantId && candidate.bucket === bucket && key.startsWith(candidate.prefix));
  if (!rule) throw new SourceAcquisitionError(403, 'DESTINATION_DENIED', 'S3 source is not allowed for this tenant');
  return { rule, key, versionId };
}

type SourceClient = Pick<S3Client, 'send'>;
export function createS3SourceAcquisition(rules: readonly S3SourceRule[], clientFor: (rule: S3SourceRule) => SourceClient) {
  return (tenantId: string, source?: string): NonNullable<SourceIngestorOptions['acquireFile']> => {
    // Gate authorization must also run when a prior attempt has a cached pin.
    if (source !== undefined) authorizeS3Source(source, tenantId, rules);
    return async (workspace, fileName, raw, policy): Promise<AcquiredSource> => {
      const { rule, key, versionId } = authorizeS3Source(raw, tenantId, rules);
      const target = workspace.filePath(fileName);
      const timeoutMs = policy.timeoutMs ?? 60_000;
      const idleMs = policy.idleTimeoutMs ?? 10_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(idleMs) || idleMs < 1) {
        throw new SourceAcquisitionError(422, 'TIMEOUT', 'invalid S3 transfer timeout');
      }
      const controller = new AbortController();
      const signal = policy.signal ? AbortSignal.any([policy.signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
      let idle: NodeJS.Timeout | undefined;
      let idleExpired = false;
      let body: Readable | undefined;
      let ownsFile = false;
      try {
        const client = clientFor(rule);
        const identity = { Bucket: rule.bucket, Key: key, ExpectedBucketOwner: rule.expectedBucketOwner, VersionId: versionId };
        const head = await client.send(new HeadObjectCommand(identity), { abortSignal: signal });
        if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength! < 0 || head.ContentLength! > policy.maxBytes) {
          throw new SourceAcquisitionError(413, 'TOO_LARGE', 'S3 source exceeds its transfer budget');
        }
        const pinnedVersion = versionId ?? (head.VersionId && head.VersionId !== 'null' ? head.VersionId : undefined);
        if (!pinnedVersion && !head.ETag) throw new SourceAcquisitionError(422, 'SOURCE_REJECTED', 'S3 source has no stable read identity');
        const object = await client.send(new GetObjectCommand({ ...identity, VersionId: pinnedVersion, IfMatch: head.ETag }), { abortSignal: signal });
        if (!(object.Body instanceof Readable)) throw new SourceAcquisitionError(502, 'EMPTY_BODY', 'S3 source has no readable body');
        body = object.Body;
        if ((pinnedVersion && object.VersionId !== pinnedVersion) || (head.ETag && object.ETag !== head.ETag)) {
          throw new SourceAcquisitionError(422, 'SOURCE_REJECTED', 'S3 source changed during acquisition');
        }
        let sizeBytes = 0;
        const hash = createHash('sha256');
        const armIdle = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => { idleExpired = true; controller.abort(); }, idleMs); idle.unref();
        };
        const measured = new Transform({ transform(chunk: Buffer, _encoding, done) {
          sizeBytes += chunk.length;
          if (sizeBytes > policy.maxBytes) return done(new SourceAcquisitionError(413, 'TOO_LARGE', 'S3 source exceeds its transfer budget'));
          hash.update(chunk); armIdle(); done(null, chunk);
        } });
        armIdle();
        const output = createWriteStream(target, { flags: 'wx', highWaterMark: policy.highWaterMarkBytes ?? 64 * 1024 });
        output.once('open', () => { ownsFile = true; });
        await pipeline(body, measured, output, { signal });
        const sha256 = hash.digest('hex');
        if (sizeBytes !== head.ContentLength || (policy.expectedSizeBytes !== undefined && sizeBytes !== policy.expectedSizeBytes)) {
          throw new SourceAcquisitionError(422, 'SIZE_MISMATCH', 'S3 source size does not match its pinned identity');
        }
        if (policy.expectedSha256 && sha256 !== policy.expectedSha256.toLowerCase()) {
          throw new SourceAcquisitionError(422, 'HASH_MISMATCH', 'S3 source hash mismatch');
        }
        return { path: target, sizeBytes, sha256, hops: 0 };
      } catch (error: unknown) {
        body?.destroy();
        if (ownsFile) await rm(target, { force: true });
        if (error instanceof SourceAcquisitionError) throw error;
        if (signal.aborted) throw new SourceAcquisitionError(408, idleExpired ? 'IDLE_TIMEOUT' : 'TIMEOUT', 'S3 source transfer aborted');
        const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        throw new SourceAcquisitionError(status === 403 ? 403 : status === 404 ? 404 : status === 412 ? 422 : 502,
          status === 403 ? 'DESTINATION_DENIED' : 'SOURCE_REJECTED', 'S3 source could not be read');
      } finally { clearTimeout(timer); if (idle) clearTimeout(idle); }
    };
  };
}

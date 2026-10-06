import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { access, readFile } from 'node:fs/promises';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createTempWorkspace } from '@du/worker-sdk';
import { authorizeS3Source, createS3SourceAcquisition, parseS3Source, s3SourceRulesFromEnv, type S3SourceRule } from '../src/modules/operations/s3-source';

const TENANT = '60000000-0000-4000-8000-000000000001';
const rule: S3SourceRule = { tenantId: TENANT, bucket: 'customer-documents', prefix: 'invoices/', region: 'ap-southeast-1', expectedBucketOwner: '123456789012' };
const uri = 's3://customer-documents/invoices/file.pdf';

describe('IAM S3 source policy and bounded acquisition', () => {
  it('keeps opaque keys intact and supports an encoded version ID', () => {
    expect(parseS3Source(uri + '?versionId=v%2B1')).toEqual({ bucket: rule.bucket, key: 'invoices/file.pdf', versionId: 'v+1' });
    expect(parseS3Source('s3://customer-documents/invoices/../report%20one.pdf').key).toBe('invoices/../report one.pdf');
  });
  it.each(['s3://user:password@customer-documents/a', 's3://customer-documents/', uri + '?endpoint=http://localhost', uri + '#secret', uri + '?versionId=null', uri + '?versionId=%00', 's3://customer-documents/invoices/%ZZ'])('rejects malformed or credential/endpoint-bearing sources', value => {
    expect(() => parseS3Source(value)).toThrow();
  });
  it('denies foreign tenant/bucket/prefix and defaults to disabled', () => {
    for (const [source, tenant, rules] of [[uri, TENANT, []], [uri, 'other-tenant', [rule]], ['s3://other-bucket/invoices/a', TENANT, [rule]], ['s3://customer-documents/invoices-other/a', TENANT, [rule]]] as const) {
      expect(() => authorizeS3Source(source, tenant, rules)).toThrow('not allowed');
    }
    expect(authorizeS3Source(uri, TENANT, [rule]).key).toBe('invoices/file.pdf');
    const clientFor = jest.fn();
    expect(() => createS3SourceAcquisition([], clientFor)(TENANT, uri)).toThrow('not allowed');
    expect(clientFor).not.toHaveBeenCalled();
  });
  it('validates deployment rules without echoing credentials or configuration values', () => {
    expect(s3SourceRulesFromEnv({})).toEqual([]);
    expect(s3SourceRulesFromEnv({ DU_S3_SOURCE_RULES: JSON.stringify([rule]) })).toEqual([rule]);
    expect(s3SourceRulesFromEnv({ DU_S3_SOURCE_RULES: JSON.stringify([{ ...rule, prefix: '' }]) })).toHaveLength(1);
    expect(() => s3SourceRulesFromEnv({ DU_S3_SOURCE_RULES: JSON.stringify([{ ...rule, accessKey: 'secret-sentinel' }]) })).toThrow('must be an array');
  });
  async function run(head: object, object: object, policy = {}, source = uri) {
    const workspace = await createTempWorkspace('s3-role-test');
    const send = jest.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(object);
    const acquire = createS3SourceAcquisition([rule], () => ({ send }) as never)(TENANT);
    try {
      const result = await acquire(workspace, 'source.bin', source, { maxBytes: 8, ...policy });
      return { result, bytes: await readFile(result.path), send };
    } catch (error) {
      await expect(access(workspace.filePath('source.bin'))).rejects.toThrow();
      throw error;
    } finally { await workspace.dispose(); }
  }
  it('pins HEAD version for GET and streams verified bytes with an owner guard', async () => {
    const body = Buffer.from('document');
    const { result, bytes, send } = await run({ ContentLength: 8, ETag: 'etag', VersionId: 'v1' }, { Body: Readable.from([body]), ETag: 'etag', VersionId: 'v1' });
    expect(bytes).toEqual(body);
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1]![0].input).toEqual({ Bucket: rule.bucket, Key: 'invoices/file.pdf', VersionId: 'v1', ExpectedBucketOwner: rule.expectedBucketOwner, IfMatch: 'etag' });
    expect(send.mock.calls[1]![0].input).not.toHaveProperty('credentials');
  });
  it('pins an unversioned source using ETag/IfMatch before private versioned storage', async () => {
    const { send } = await run({ ContentLength: 3, ETag: 'etag', VersionId: 'null' }, { Body: Readable.from(['abc']), ETag: 'etag' });
    expect(send.mock.calls[1]![0].input.VersionId).toBeUndefined();
    expect(send.mock.calls[1]![0].input.IfMatch).toBe('etag');
  });
  it('preserves a caller-selected immutable version', async () => {
    const { send } = await run({ ContentLength: 3, ETag: 'etag', VersionId: 'selected' }, { Body: Readable.from(['abc']), ETag: 'etag', VersionId: 'selected' }, {}, uri + '?versionId=selected');
    expect(send.mock.calls[0]![0].input.VersionId).toBe('selected');
    expect(send.mock.calls[1]![0].input.VersionId).toBe('selected');
  });
  it('rejects oversized metadata before GET', async () => {
    await expect(run({ ContentLength: 9 }, {})).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
  it('enforces the byte cap during streaming and deletes partial output', async () => {
    await expect(run({ ContentLength: 8, ETag: 'etag' }, { Body: Readable.from(['12345', '6789']), ETag: 'etag' })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
  it('rejects short reads, digest mismatches and changed versions', async () => {
    await expect(run({ ContentLength: 8, ETag: 'etag' }, { Body: Readable.from(['abc']), ETag: 'etag' })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(run({ ContentLength: 3, ETag: 'etag' }, { Body: Readable.from(['abc']), ETag: 'etag' }, { expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await expect(run({ ContentLength: 3, ETag: 'etag', VersionId: 'v1' }, { Body: Readable.from(['abc']), ETag: 'etag', VersionId: 'v2' })).rejects.toMatchObject({ code: 'SOURCE_REJECTED' });
  });
  it('aborts an idle body and a timed-out HEAD request', async () => {
    await expect(run({ ContentLength: 3, ETag: 'etag' }, { Body: new Readable({ read() {} }), ETag: 'etag' }, { idleTimeoutMs: 20 })).rejects.toMatchObject({ code: 'IDLE_TIMEOUT' });
    const workspace = await createTempWorkspace('s3-timeout-test');
    const send = jest.fn((_command, options) => new Promise((_resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    try {
      await expect(createS3SourceAcquisition([rule], () => ({ send }) as never)(TENANT)(workspace, 'source.bin', uri, { maxBytes: 8, timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally { await workspace.dispose(); }
  });
});

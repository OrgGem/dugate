import { createHash } from 'node:crypto';
import { writePublicArtifact, PublicArtifactTooLargeError, type PublicArtifactWriterDeps } from '../src/compat/legacy-public-artifact';

/**
 * The writer is the only place a legacy upload becomes a durable artifact, so
 * the two properties that matter are both pinned here: the bytes are verified
 * before the row is written, and the cap refuses BEFORE anything is stored.
 * A test that only checked the happy path would pass even if the cap were
 * checked after `putBlob` and had already written the blob.
 */

interface Call {
  readonly sql: string;
  readonly params: unknown[];
}

function deps(overrides: Partial<PublicArtifactWriterDeps> = {}): {
  deps: PublicArtifactWriterDeps;
  calls: Call[];
  blobs: { key: string; bytes: Buffer }[];
} {
  const calls: Call[] = [];
  const blobs: { key: string; bytes: Buffer }[] = [];
  return {
    calls,
    blobs,
    deps: {
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
      putBlob: async (storageKey, _tenantId, bytes) => {
        blobs.push({ key: storageKey, bytes });
      },
      verifyAndPin: async (pin) => ({
        objectKey: pin.objectKey,
        versionId: pin.expectedSha256,
      }),
      storageBackend: 'postgres',
      maxArtifactBytes: 1024,
      ...overrides,
    },
  };
}

describe('writePublicArtifact', () => {
  it('stores the bytes and returns a READY artifact', async () => {
    const { deps: d, calls, blobs } = deps();
    const bytes = Buffer.from('%PDF-1.7', 'latin1');
    const res = await writePublicArtifact(d, {
      tenantId: 't-1',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      bytes,
    });
    expect(res.state).toBe('READY');
    expect(res.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.bytes.toString('latin1')).toBe('%PDF-1.7');
    // The row is written with operation_id and task_id absent, which is what
    // keeps it out of the worker lifecycle's reach.
    const insert = calls.find((c) => c.sql.includes('INSERT INTO artifacts'));
    expect(insert).toBeDefined();
    expect(insert!.sql).not.toContain('operation_id');
    expect(insert!.sql).not.toContain('task_id');
  });

  it('records the sha256 it verified so the stored digest is auditable', async () => {
    const { deps: d, calls } = deps();
    const bytes = Buffer.from('hello', 'latin1');
    await writePublicArtifact(d, {
      tenantId: 't-1',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      bytes,
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO artifacts'))!;
    expect(insert.params).toContain(createHash('sha256').update(bytes).digest('hex'));
  });

  it('refuses an oversize upload BEFORE storing any bytes or writing a row', async () => {
    const { deps: d, calls, blobs } = deps({ maxArtifactBytes: 10 });
    await expect(
      writePublicArtifact(d, {
        tenantId: 't-1',
        fileName: 'big.bin',
        mimeType: 'application/octet-stream',
        bytes: Buffer.alloc(64),
      }),
    ).rejects.toBeInstanceOf(PublicArtifactTooLargeError);
    expect(blobs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('leaves no row when the digest check fails', async () => {
    const { deps: d, calls, blobs } = deps({
      verifyAndPin: async () => {
        throw new Error('CHECKSUM_MISMATCH');
      },
    });
    await expect(
      writePublicArtifact(d, {
        tenantId: 't-1',
        fileName: 'a.txt',
        mimeType: 'text/plain',
        bytes: Buffer.from('x'),
      }),
    ).rejects.toThrow('CHECKSUM_MISMATCH');
    expect(calls.filter((c) => c.sql.includes('INSERT INTO artifacts'))).toHaveLength(0);
    // The blob may linger, but no READY row points at it, so it is inert and
    // swept as an orphan rather than served.
    expect(blobs).toHaveLength(1);
  });

  it('accepts a zero-length file', async () => {
    const { deps: d } = deps();
    const res = await writePublicArtifact(d, {
      tenantId: 't-1',
      fileName: 'empty.txt',
      mimeType: 'text/plain',
      bytes: Buffer.alloc(0),
    });
    expect(res.state).toBe('READY');
  });
});

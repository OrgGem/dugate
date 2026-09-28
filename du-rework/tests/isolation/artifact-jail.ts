import { createHash, randomUUID } from 'node:crypto';

/**
 * Isolated In-Memory Artifact Store (P1-05 / ART-01..03)
 *
 * Scopes artifact staging, finalization, and downloads strictly to the runId,
 * preventing cross-test artifact leaks or collision.
 */

export interface StagedArtifactRecord {
  artifactId: string;
  runId: string;
  tenantId: string;
  role: 'input' | 'output' | 'intermediate';
  fileName: string;
  mimeType: string;
  content: Buffer;
  sizeBytes: number;
  hashSha256: string;
  state: 'STAGING' | 'READY' | 'EXPIRED';
  expiresAt: string;
}

export class IsolatedArtifactJail {
  // Global memory storage partition
  private static readonly globalArtifacts = new Map<string, StagedArtifactRecord>();

  public constructor(public readonly runId: string, public readonly tenantId: string) {}

  public static clearAll(): void {
    IsolatedArtifactJail.globalArtifacts.clear();
  }

  public async putStaged(
    content: Buffer | string,
    fileName: string,
    mimeType: string,
    role: 'input' | 'output' | 'intermediate' = 'output',
    ttlMs = 900_000,
  ): Promise<StagedArtifactRecord> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const artifactId = randomUUID();
    const hashSha256 = createHash('sha256').update(buf).digest('hex');

    const record: StagedArtifactRecord = {
      artifactId,
      runId: this.runId,
      tenantId: this.tenantId,
      role,
      fileName,
      mimeType,
      content: buf,
      sizeBytes: buf.byteLength,
      hashSha256: `sha256:${hashSha256}`,
      state: 'STAGING',
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };

    IsolatedArtifactJail.globalArtifacts.set(artifactId, record);
    return record;
  }

  public async finalize(artifactId: string, expectedHash?: string): Promise<StagedArtifactRecord> {
    const record = IsolatedArtifactJail.globalArtifacts.get(artifactId);
    if (!record || record.runId !== this.runId) {
      throw new Error(`Artifact ${artifactId} not found in this isolation jail`);
    }

    if (expectedHash && record.hashSha256 !== expectedHash) {
      throw new Error(`Integrity mismatch: expected ${expectedHash}, got ${record.hashSha256}`);
    }

    record.state = 'READY';
    return record;
  }

  public async get(artifactId: string): Promise<Buffer> {
    const record = IsolatedArtifactJail.globalArtifacts.get(artifactId);
    if (!record || record.runId !== this.runId) {
      throw new Error(`Artifact ${artifactId} not found or access denied across run isolation boundary`);
    }
    return record.content;
  }

  public async has(artifactId: string): Promise<boolean> {
    const record = IsolatedArtifactJail.globalArtifacts.get(artifactId);
    return Boolean(record && record.runId === this.runId);
  }

  /**
   * Drops ONLY artifacts belonging to this runId
   */
  public async flush(): Promise<number> {
    let count = 0;
    for (const [id, record] of IsolatedArtifactJail.globalArtifacts.entries()) {
      if (record.runId === this.runId) {
        IsolatedArtifactJail.globalArtifacts.delete(id);
        count++;
      }
    }
    return count;
  }
}

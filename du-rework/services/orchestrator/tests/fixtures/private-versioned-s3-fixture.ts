import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

interface StoredVersion {
  versionId: string;
  bytes: Buffer;
  contentType: string;
  metadata: Record<string, string>;
}

interface PresignedUpload {
  bucket: string;
  key: string;
  contentLength: number;
  contentType: string;
  metadata: Record<string, string>;
}

export interface S3FixtureRequest {
  command: 'head' | 'get' | 'put' | 'delete';
  bucket: string;
  key: string;
  versionId?: string;
}

/** Small versioned, private-bucket S3-compatible fixture for adapter tests. */
export class PrivateVersionedS3Fixture {
  readonly client: S3Client;
  readonly requests: S3FixtureRequest[] = [];
  readonly bucket: string;
  afterHead?: (input: { objectKey: string; versionId: string }) => Promise<void> | void;

  private readonly versions = new Map<string, StoredVersion[]>();
  private readonly presignedUploads = new Map<string, PresignedUpload>();
  private versionSequence = 0;
  private grantSequence = 0;

  constructor(bucket = 'private-artifacts-test') {
    this.bucket = bucket;
    this.client = { send: this.send } as unknown as S3Client;
  }

  readonly presignPut = async (
    _client: S3Client,
    command: PutObjectCommand,
  ): Promise<string> => {
    const { Bucket, Key, ContentLength, ContentType, Metadata } = command.input;
    if (!Bucket || !Key || ContentLength === undefined || !ContentType || !Metadata) {
      throw new Error('invalid fixture presigned upload');
    }
    const url = `https://s3.private.test/upload/${++this.grantSequence}`;
    this.presignedUploads.set(url, {
      bucket: Bucket,
      key: Key,
      contentLength: ContentLength,
      contentType: ContentType,
      metadata: { ...Metadata },
    });
    return url;
  };

  /** Simulate the client PUT made with a URL produced by this fixture. */
  async uploadUsingGrant(url: string, bytes: Buffer): Promise<string> {
    const grant = this.presignedUploads.get(url);
    if (!grant) throw new Error('unknown or expired fixture grant');
    if (bytes.byteLength !== grant.contentLength) throw new Error('signed content length mismatch');
    return this.putVersion(grant.bucket, grant.key, bytes, grant.contentType, grant.metadata);
  }

  /** Simulate a delayed PUT through an already issued grant after finalization. */
  putLateVersion(input: {
    objectKey: string;
    artifactId: string;
    tenantId: string;
    bytes: Buffer;
    contentType?: string;
  }): string {
    return this.putVersion(this.bucket, input.objectKey, input.bytes, input.contentType ?? 'application/octet-stream', {
      artifactid: input.artifactId,
      tenantid: input.tenantId,
    });
  }

  getVersions(objectKey: string): readonly string[] {
    return (this.versions.get(this.objectMapKey(this.bucket, objectKey)) ?? []).map((version) => version.versionId);
  }

  private readonly send = async (command: unknown): Promise<unknown> => {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, ContentType, Metadata } = command.input;
      if (!Bucket || !Key || !Body || !ContentType) throw this.notFound('NoSuchBucket');
      const bytes = Buffer.isBuffer(Body)
        ? Buffer.from(Body)
        : Body instanceof Uint8Array
          ? Buffer.from(Body)
          : null;
      if (!bytes) throw new Error('fixture only accepts bounded buffer PUTs');
      this.requests.push({ command: 'put', bucket: Bucket, key: Key });
      const versionId = this.putVersion(Bucket, Key, bytes, ContentType, Metadata ?? {});
      return { VersionId: versionId };
    }

    if (command instanceof HeadObjectCommand) {
      const { Bucket, Key, VersionId } = command.input;
      if (!Bucket || !Key) throw this.notFound('NoSuchKey');
      const object = this.findVersion(Bucket, Key, VersionId);
      if (!object) throw this.notFound(VersionId ? 'NoSuchVersion' : 'NoSuchKey');
      this.requests.push({ command: 'head', bucket: Bucket, key: Key, versionId: object.versionId });
      const afterHead = this.afterHead;
      this.afterHead = undefined;
      if (afterHead) await afterHead({ objectKey: Key, versionId: object.versionId });
      return {
        VersionId: object.versionId,
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        Metadata: { ...object.metadata },
      };
    }

    if (command instanceof GetObjectCommand) {
      const { Bucket, Key, VersionId } = command.input;
      if (!Bucket || !Key) throw this.notFound('NoSuchKey');
      const object = this.findVersion(Bucket, Key, VersionId);
      if (!object) throw this.notFound(VersionId ? 'NoSuchVersion' : 'NoSuchKey');
      this.requests.push({ command: 'get', bucket: Bucket, key: Key, versionId: object.versionId });
      return { Body: Readable.from([Buffer.from(object.bytes)]) };
    }

    if (command instanceof DeleteObjectCommand) {
      const { Bucket, Key, VersionId } = command.input;
      if (!Bucket || !Key || !VersionId) throw this.notFound('NoSuchVersion');
      this.requests.push({ command: 'delete', bucket: Bucket, key: Key, versionId: VersionId });
      const key = this.objectMapKey(Bucket, Key);
      const stored = this.versions.get(key) ?? [];
      this.versions.set(key, stored.filter((version) => version.versionId !== VersionId));
      return {};
    }

    throw new Error('unsupported S3 fixture command');
  };

  private putVersion(
    bucket: string,
    key: string,
    bytes: Buffer,
    contentType: string,
    metadata: Record<string, string>,
  ): string {
    if (bucket !== this.bucket) throw this.notFound('NoSuchBucket');
    const versionId = `fixture-version-${++this.versionSequence}`;
    const mapKey = this.objectMapKey(bucket, key);
    const versions = this.versions.get(mapKey) ?? [];
    versions.push({ versionId, bytes: Buffer.from(bytes), contentType, metadata: { ...metadata } });
    this.versions.set(mapKey, versions);
    return versionId;
  }

  private findVersion(bucket: string, key: string, versionId?: string): StoredVersion | undefined {
    if (bucket !== this.bucket) return undefined;
    const versions = this.versions.get(this.objectMapKey(bucket, key)) ?? [];
    return versionId
      ? versions.find((version) => version.versionId === versionId)
      : versions.at(-1);
  }

  private objectMapKey(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  private notFound(name: string): Error {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  }
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  StorageGenerationActionRequestSchema,
  StorageGenerationBackendSchema,
  StorageGenerationReadSchema,
  StorageGenerationStageRequestSchema,
  StorageGenerationTestRequestSchema,
  StorageGenerationTestResultSchema,
  type StorageGenerationActionRequest,
  type StorageGenerationBackend,
  type StorageGenerationMutationResult,
  type StorageGenerationRead,
  type StorageGenerationStageRequest,
  type StorageGenerationTestRequest,
  type StorageGenerationTestResult,
} from '@du/contracts';
import type { AuditService } from '../audit/audit';
import type { Db } from '../../db/db';
import { conflict, notFound, unprocessable, unavailable } from '../../http/errors';
import {
  ArtifactStorageError,
  type ArtifactStorageFacade,
} from './storage-facade';
import type { ArtifactMultipartStorage } from './multipart-storage';
import {
  artifactEncryptionContext,
  openWorkerArtifact,
  parseWorkerArtifactSidecar,
  sealWorkerArtifact,
  verifyWorkerArtifact,
  type WorkerArtifactEncryption,
} from './artifact-encryption';
import { canonicalPayloadHash, executeIdempotent } from '../idempotency/idempotency';
import type { BackupArtifactEffectHandle, BackupArtifactEffectPort, BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';

export interface StorageGenerationActor {
  actor: string;
  actorRole: string;
  actorIssuer?: string;
  actorSub?: string;
}

export interface StorageGenerationConfig {
  generationId: string;
  revision: number;
  backend: StorageGenerationBackend;
  endpoint: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  /** Immutable `secretId@revision` reference; floating aliases are rejected. */
  credentialVersionRef: string | null;
  /** UUID owner resolved from the exact archived secret version, not user input. */
  credentialOwnerTenantId: string | null;
  urlTtlSeconds: number | null;
}

export interface StorageGenerationService {
  /** Current immutable generation plus the monotonic activation control revision. */
  current(): Promise<StorageGenerationRead>;
  /** Immutable generation history, newest revision first; secret bytes/refs are never returned. */
  listGenerations(): Promise<StorageGenerationRead[]>;
  /** Seed the active generation from trusted boot configuration exactly once. */
  ensureInitial(config: Omit<StorageGenerationConfig, 'generationId' | 'revision'> & { generationId?: string }): Promise<StorageGenerationRead>;
  /** Persist an immutable staged config; the caller supplies a managed secret ref, never bytes. */
  stage(input: StorageGenerationStageRequest, actor: StorageGenerationActor): Promise<StorageGenerationRead>;
  /** Bounded write/read/hash/crypto/delete check. Any interrupted test is UNKNOWN and never replayed. */
  test(generationId: string, input: StorageGenerationTestRequest, actor: StorageGenerationActor): Promise<StorageGenerationTestResult>;
  /** Activate only after a fully passing test and a CAS on the active revision. */
  activate(generationId: string, input: StorageGenerationActionRequest, actor: StorageGenerationActor): Promise<StorageGenerationMutationResult>;
  /** Switch the active pointer to a previously tested retained generation. */
  rollback(generationId: string, input: StorageGenerationActionRequest, actor: StorageGenerationActor): Promise<StorageGenerationMutationResult>;
  /** Effective direct-upload presign lifetime pinned to this exact generation. */
  presignedUrlTtlSeconds(generationId: string): Promise<number | null>;
  /** A lazy dynamic facade that always resolves the exact immutable generation. */
  forGeneration(generationId: string): ArtifactStorageFacade;
  /** Multipart port for the exact immutable generation; never falls back to a newer active generation. */
  multipartForGeneration(generationId: string): ArtifactMultipartStorage;
}

export interface StorageGenerationServiceOptions {
  db: Db;
  audit: AuditService;
  /** Required at runtime for every storage-generation write. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  /** Durable permit for the real S3 write/read/delete storage test. */
  backupArtifactEffects?: BackupArtifactEffectPort;
  resolveFacade(config: StorageGenerationConfig): Promise<ArtifactStorageFacade & Partial<ArtifactMultipartStorage>> | (ArtifactStorageFacade & Partial<ArtifactMultipartStorage>);
  /** Must resolve the named archived secret revision, never a mutable alias. */
  verifyCredentialVersion?(reference: string, ownerTenantId: string): Promise<void>;
  /** The server crypto key/ref seam used by encrypted storage tests. Required for activation. */
  encryption?: WorkerArtifactEncryption;
  /** Deployment-owned DNS/endpoint policy. Missing validator fails staged S3 config closed. */
  validateEndpoint?: (endpoint: URL) => Promise<boolean> | boolean;
  now?: () => Date;
}

interface GenerationRow extends QueryResultRow {
  generation_id: string;
  revision: number | string;
  backend: string;
  endpoint: string;
  bucket: string;
  region: string;
  force_path_style: boolean;
  credential_version_ref: string | null;
  credential_owner_tenant_id: string | null;
  url_ttl_seconds: number | null;
  state: string;
  tested_at: Date | string | null;
  test_result: unknown;
  activated_at: Date | string | null;
}

interface TestRow extends QueryResultRow {
  test_id: string;
  idempotency_key: string;
  request_hash: string;
  generation_id: string;
  state: string;
  result: unknown;
  started_at: Date | string;
}

const GENERATION_SELECT = `SELECT generation_id, revision, backend, endpoint, bucket, region,
  force_path_style, credential_version_ref, credential_owner_tenant_id, url_ttl_seconds, state, tested_at, test_result, activated_at
  FROM storage_generations`;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ArtifactStorageError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.name)) return error.name;
  return 'STORAGE_TEST_FAILED';
}

function asConfig(row: GenerationRow): StorageGenerationConfig {
  return {
    generationId: row.generation_id,
    revision: Number(row.revision),
    backend: StorageGenerationBackendSchema.parse(row.backend),
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    forcePathStyle: row.force_path_style,
    credentialVersionRef: row.credential_version_ref,
    credentialOwnerTenantId: row.credential_owner_tenant_id,
    urlTtlSeconds: row.url_ttl_seconds,
  };
}

function toRead(row: GenerationRow, controlRevision: number): StorageGenerationRead {
  const test = row.test_result === null ? null : StorageGenerationTestResultSchema.parse(row.test_result);
  return StorageGenerationReadSchema.parse({
    generationId: row.generation_id,
    revision: Number(row.revision),
    controlRevision,
    state: row.state,
    backend: row.backend,
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    forcePathStyle: row.force_path_style,
    secretPresent: row.credential_version_ref !== null,
    credentialVersionRef: row.credential_version_ref,
    credentialOwnerTenantId: row.credential_owner_tenant_id,
    urlTtlSeconds: row.url_ttl_seconds,
    activatedAt: toIso(row.activated_at),
    testedAt: toIso(row.tested_at),
    lastTest: test,
  });
}

function isPassingTest(value: unknown): value is StorageGenerationTestResult {
  const parsed = StorageGenerationTestResultSchema.safeParse(value);
  return parsed.success
    && parsed.data.status === 'PASSED'
    && parsed.data.write === 'PASSED'
    && parsed.data.read === 'PASSED'
    && parsed.data.checksum === 'PASSED'
    && parsed.data.crypto === 'PASSED'
    && parsed.data.delete === 'PASSED';
}

async function collectBounded(readable: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of readable) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > maxBytes) {
      throw new ArtifactStorageError('SIZE_MISMATCH');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createStorageGenerationService(options: StorageGenerationServiceOptions): StorageGenerationService {
  const now = options.now ?? (() => new Date());

  async function assertSnapshotWriteAllowed(client: PoolClient, requestKey: string): Promise<void> {
    if (!options.backupSnapshotWriteGate) throw unavailable('storage generation snapshot write gate is not configured');
    await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
      tenantId: null,
      domain: 'storage-generation-publication',
      requestKey,
    });
  }

  async function readById(generationId: string): Promise<GenerationRow> {
    const result = await options.db.query<GenerationRow>(`${GENERATION_SELECT} WHERE generation_id=$1`, [generationId]);
    if (!result.rowCount) throw notFound('storage generation not found');
    return result.rows[0]!;
  }

  const CURRENT_SELECT = `SELECT g.generation_id, g.revision, g.backend, g.endpoint, g.bucket, g.region,
              g.force_path_style, g.credential_version_ref, g.credential_owner_tenant_id, g.url_ttl_seconds, g.state,
              g.tested_at, g.test_result, g.activated_at, s.revision AS control_revision
         FROM storage_generation_state s
         JOIN storage_generations g ON g.generation_id = s.active_generation_id
        WHERE s.singleton = true`;

  async function readCurrentRow(client?: PoolClient): Promise<{ row: GenerationRow; controlRevision: number }> {
    const result = client
      ? await client.query<GenerationRow & { control_revision: number | string }>(CURRENT_SELECT)
      : await options.db.query<GenerationRow & { control_revision: number | string }>(CURRENT_SELECT);
    if (!result.rowCount) throw unavailable('storage generation has not been initialized from trusted configuration');
    const { control_revision, ...row } = result.rows[0]!;
    return { row, controlRevision: Number(control_revision) };
  }

  async function readControlRevision(client: PoolClient): Promise<number> {
    const result = await client.query<{ revision: number | string }>(
      'SELECT revision FROM storage_generation_state WHERE singleton=true FOR UPDATE',
    );
    if (!result.rowCount) throw unavailable('storage generation has not been initialized from trusted configuration');
    return Number(result.rows[0]!.revision);
  }

  async function auditMutation(
    actor: StorageGenerationActor,
    action: string,
    resource: string,
    executor: PoolClient,
    severity: 'info' | 'success' | 'warning' | 'error' = 'info',
  ): Promise<void> {
    await options.audit.record({
      tenantId: null,
      actor: actor.actor,
      actorIssuer: actor.actorIssuer,
      actorSub: actor.actorSub,
      actorRole: actor.actorRole,
      action,
      resource,
      severity,
    }, executor);
  }

  async function withIdempotency<T>(
    key: string,
    route: string,
    payload: unknown,
    work: (withMarker: (client: PoolClient, response: { status: number; body: T }) => Promise<void>) => Promise<{ status: number; body: T }>,
  ): Promise<T> {
    const response = await executeIdempotent<T>(options.db, {
      key,
      route,
      payloadHash: canonicalPayloadHash(payload),
    }, work);
    return response.body;
  }

  async function resolve(id: string): Promise<ArtifactStorageFacade> {
    return options.resolveFacade(asConfig(await readById(id)));
  }

  async function resolveMultipart(id: string): Promise<ArtifactMultipartStorage> {
    const config = asConfig(await readById(id));
    if (config.backend !== 's3') throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
    const facade = await options.resolveFacade(config);
    const methods: (keyof ArtifactMultipartStorage)[] = [
      'createMultipartUpload', 'presignUploadPart', 'listMultipartParts',
      'completeMultipartUpload', 'abortMultipartUpload',
    ];
    if (methods.some((name) => typeof facade[name] !== 'function')) {
      throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
    }
    return facade as ArtifactStorageFacade & ArtifactMultipartStorage;
  }

  const facadeFor = (generationId: string): ArtifactStorageFacade => ({
    async createUploadGrant(input) { return (await resolve(generationId)).createUploadGrant(input); },
    async verifyAndPin(input) { return (await resolve(generationId)).verifyAndPin(input); },
    async openRead(input) { return (await resolve(generationId)).openRead(input); },
    async delete(input) { return (await resolve(generationId)).delete(input); },
    async putServerObject(input) {
      const facade = await resolve(generationId);
      if (!facade.putServerObject) throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
      return facade.putServerObject(input);
    },
    async putServerObjectStream(input) {
      const facade = await resolve(generationId);
      if (!facade.putServerObjectStream) throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
      return facade.putServerObjectStream(input);
    },
    async readServerObject(objectKey) {
      const facade = await resolve(generationId);
      if (!facade.readServerObject) throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
      return facade.readServerObject(objectKey);
    },
  });

  const multipartFacadeFor = (generationId: string): ArtifactMultipartStorage => ({
    async verifyAndPin(input) { return (await resolveMultipart(generationId)).verifyAndPin(input); },
    async delete(input) { return (await resolveMultipart(generationId)).delete(input); },
    async createMultipartUpload(input) { return (await resolveMultipart(generationId)).createMultipartUpload(input); },
    async presignUploadPart(input) { return (await resolveMultipart(generationId)).presignUploadPart(input); },
    async listMultipartParts(input) { return (await resolveMultipart(generationId)).listMultipartParts(input); },
    async completeMultipartUpload(input) { return (await resolveMultipart(generationId)).completeMultipartUpload(input); },
    async abortMultipartUpload(input) { return (await resolveMultipart(generationId)).abortMultipartUpload(input); },
  });

  async function runProbe(config: StorageGenerationConfig, facade: ArtifactStorageFacade, testId: string): Promise<StorageGenerationTestResult> {
    const checkedAt = now().toISOString();
    let write: StorageGenerationTestResult['write'] = 'UNKNOWN';
    let read: StorageGenerationTestResult['read'] = 'UNKNOWN';
    let checksum: StorageGenerationTestResult['checksum'] = 'UNKNOWN';
    let crypto: StorageGenerationTestResult['crypto'] = 'UNKNOWN';
    let deleteStatus: StorageGenerationTestResult['delete'] = 'UNKNOWN';
    let code: string | null = null;
    let objectKey = `__dugate_maintenance_probe__/${config.generationId}/${testId}/ciphertext`;
    let sidecarKey = `__dugate_maintenance_probe__/${config.generationId}/${testId}/manifest`;
    let objectVersionId: string | null = null;
    let sidecarVersionId: string | null = null;

    if (!options.encryption) {
      return StorageGenerationTestResultSchema.parse({
        generationId: config.generationId,
        status: 'FAILED', checkedAt,
        write: 'UNKNOWN', read: 'UNKNOWN', checksum: 'UNKNOWN', crypto: 'FAILED', delete: 'UNKNOWN',
        code: 'ENCRYPTION_UNAVAILABLE',
      });
    }

    const tenantId = randomUUID();
    const artifactId = randomUUID();
    const objectVersion = randomUUID();
    const plain = randomBytes(96);
    let body: Buffer<ArrayBufferLike> = plain;
    let sidecar: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let identity: { tenantId: string; artifactId: string; objectVersion: string } | null = null;
    identity = { tenantId, artifactId, objectVersion };
    const sealed = await sealWorkerArtifact({ bytes: plain, identity, seam: options.encryption });
    body = sealed.ciphertext;
    sidecar = sealed.sidecar;
    let objectDeleteAttempted = false;
    let sidecarDeleteAttempted = false;

    try {
      const object = facade.putServerObject
        ? await facade.putServerObject({ objectKey, tenantId, body, contentType: 'application/octet-stream' })
        : (() => { throw new ArtifactStorageError('STORAGE_UNAVAILABLE'); })();
      objectVersionId = object.versionId;
      await options.db.query(
        `UPDATE storage_generation_tests SET object_version_id=$2,object_sha256=$3,object_size_bytes=$4 WHERE test_id=$1 AND state='RUNNING'`,
        [testId, objectVersionId, hash(body), body.byteLength],
      );
      const sidecarWrite = facade.putServerObject
        ? await facade.putServerObject({ objectKey: sidecarKey, tenantId, body: sidecar, contentType: 'application/json' })
        : (() => { throw new ArtifactStorageError('STORAGE_UNAVAILABLE'); })();
      sidecarVersionId = sidecarWrite.versionId;
      await options.db.query(
        `UPDATE storage_generation_tests SET sidecar_version_id=$2,sidecar_sha256=$3,sidecar_size_bytes=$4 WHERE test_id=$1 AND state='RUNNING'`,
        [testId, sidecarVersionId, hash(sidecar), sidecar.byteLength],
      );
      if (!objectVersionId || objectVersionId === 'null' || !sidecarVersionId || sidecarVersionId === 'null') {
        throw new ArtifactStorageError('OBJECT_VERSION_REQUIRED');
      }
      write = 'PASSED';

      const storedSidecar = await collectBounded(await facade.openRead({ objectKey: sidecarKey, versionId: sidecarVersionId }), 16 * 1024);
      const ciphertext = await collectBounded(await facade.openRead({ objectKey, versionId: objectVersionId }), 4096);
      const manifest = parseWorkerArtifactSidecar(JSON.parse(storedSidecar.toString('utf8')) as unknown);
      read = 'PASSED';
      if (hash(ciphertext) !== hash(body) || hash(storedSidecar) !== hash(sidecar)) {
        throw new ArtifactStorageError('CHECKSUM_MISMATCH');
      }
      checksum = 'PASSED';
      if (identity) {
        const verified = await verifyWorkerArtifact({
          sidecar: manifest,
          ciphertext,
          context: artifactEncryptionContext(identity),
          seam: options.encryption,
        });
        const opened = await openWorkerArtifact({
          sidecar: manifest,
          ciphertext,
          context: artifactEncryptionContext(identity),
          seam: options.encryption,
        });
        if (verified.plaintextSha256 !== hash(plain) || verified.plaintextSizeBytes !== plain.byteLength || !opened.equals(plain)) {
          throw new ArtifactStorageError('ENVELOPE_INVALID');
        }
        crypto = 'PASSED';
      }
      deleteStatus = 'UNKNOWN';
      objectDeleteAttempted = true;
      await facade.delete({ objectKey, versionId: objectVersionId });
      sidecarDeleteAttempted = true;
      await facade.delete({ objectKey: sidecarKey, versionId: sidecarVersionId });
      deleteStatus = 'PASSED';
    } catch (error) {
      code = safeErrorCode(error);
      const isAmbiguous = error instanceof ArtifactStorageError
        && ['STORAGE_UNAVAILABLE', 'OBJECT_NOT_FOUND'].includes(error.code);
      const failed: StorageGenerationTestResult['write'] = isAmbiguous ? 'UNKNOWN' : 'FAILED';
      if (write === 'UNKNOWN') write = failed;
      if (write === 'PASSED' && read === 'UNKNOWN') read = failed;
      if (read === 'PASSED' && checksum === 'UNKNOWN') checksum = failed;
      if (checksum === 'PASSED' && crypto === 'UNKNOWN') crypto = failed;
      if (deleteStatus !== 'PASSED') deleteStatus = isAmbiguous ? 'UNKNOWN' : 'FAILED';
      // A best-effort exact-version cleanup is attempted only when the write
      // port returned immutable version IDs. Ambiguity is retained in the
      // receipt, never retried as if absence had been proven.
      if (!objectDeleteAttempted && objectVersionId && objectVersionId !== 'null') {
        objectDeleteAttempted = true;
        await facade.delete({ objectKey, versionId: objectVersionId }).catch(() => undefined);
      }
      if (!sidecarDeleteAttempted && sidecarVersionId && sidecarVersionId !== 'null') {
        sidecarDeleteAttempted = true;
        await facade.delete({ objectKey: sidecarKey, versionId: sidecarVersionId }).catch(() => undefined);
      }
    }

    const parts = [write, read, checksum, crypto, deleteStatus];
    const status = parts.every((part) => part === 'PASSED')
      ? 'PASSED'
      : parts.some((part) => part === 'UNKNOWN')
        ? 'UNKNOWN'
        : 'FAILED';
    return StorageGenerationTestResultSchema.parse({
      generationId: config.generationId,
      status,
      checkedAt,
      write,
      read,
      checksum,
      crypto,
      delete: deleteStatus,
      code,
    });
  }

  return {
    async current(): Promise<StorageGenerationRead> {
      const current = await readCurrentRow();
      return toRead(current.row, current.controlRevision);
    },

    async listGenerations(): Promise<StorageGenerationRead[]> {
      const result = await options.db.query<GenerationRow & {control_revision:number|string}>(
        `SELECT g.generation_id,g.revision,g.backend,g.endpoint,g.bucket,g.region,g.force_path_style,
                g.credential_version_ref,g.credential_owner_tenant_id,g.url_ttl_seconds,g.state,g.tested_at,
                g.test_result,g.activated_at,s.revision AS control_revision
           FROM storage_generations g CROSS JOIN storage_generation_state s
          WHERE s.singleton=true ORDER BY g.revision DESC,g.generation_id`,
      );
      if (!result.rowCount) throw unavailable('storage generation has not been initialized from trusted configuration');
      return result.rows.map((row)=>toRead(row,Number(row.control_revision)));
    },

    async presignedUrlTtlSeconds(generationId): Promise<number | null> {
      const generation = await readById(generationId);
      return generation.url_ttl_seconds === null ? null : Number(generation.url_ttl_seconds);
    },

    async ensureInitial(initial): Promise<StorageGenerationRead> {
      const config = {
        generationId: initial.generationId ?? randomUUID(),
        revision: 0,
        ...initial,
      } as StorageGenerationConfig;
      if (config.backend === 's3') {
        if (!config.credentialVersionRef || !options.verifyCredentialVersion) {
          throw unavailable('immutable S3 credential version verifier is not configured');
        }
        if (!config.credentialOwnerTenantId) throw unavailable('S3 credential owner UUID is required');
        await options.verifyCredentialVersion(config.credentialVersionRef, config.credentialOwnerTenantId);
      } else {
        config.credentialOwnerTenantId = null;
      }
      const result = await options.db.tx(async (client) => {
        await assertSnapshotWriteAllowed(client, `storage-bootstrap:${config.generationId}`);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['storage-generation-bootstrap']);
        const current = await client.query('SELECT active_generation_id FROM storage_generation_state WHERE singleton=true');
        if (current.rowCount) return;
        await client.query(
          `INSERT INTO storage_generations
             (generation_id,revision,backend,endpoint,bucket,region,force_path_style,credential_version_ref,credential_owner_tenant_id,url_ttl_seconds,state,activated_at,created_by)
           VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',now(),'system')`,
          [config.generationId, config.backend, config.endpoint, config.bucket, config.region,
            config.forcePathStyle, config.credentialVersionRef, config.credentialOwnerTenantId, config.urlTtlSeconds],
        );
        await client.query(
          `INSERT INTO storage_generation_state(singleton,active_generation_id,revision)
           VALUES (true,$1,0)`,
          [config.generationId],
        );
      });
      void result;
      return this.current();
    },

    async stage(input, actor): Promise<StorageGenerationRead> {
      const parsed = StorageGenerationStageRequestSchema.safeParse(input);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'storage generation stage request is invalid');
      const data = parsed.data;
      const storedConfig = data.backend === 'postgres'
        ? {
            backend: 'postgres' as const,
            endpoint: 'postgres',
            bucket: '',
            region: 'postgres',
            forcePathStyle: false,
            credentialVersionRef: null,
            credentialOwnerTenantId: null,
            urlTtlSeconds: null,
          }
        : data;
      if (data.backend === 's3') {
        let endpoint: URL;
        try {
          endpoint = new URL(data.endpoint);
        } catch {
          throw unprocessable('INVALID_SCHEMA', 'S3 endpoint must be a valid URL');
        }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw unprocessable('INVALID_SCHEMA', 'S3 endpoint must use HTTP(S) without credentials, query or fragment');
        }
        if (!options.validateEndpoint || !(await options.validateEndpoint(endpoint))) {
          throw unprocessable('PERMISSION_DENIED', 'S3 endpoint is outside the deployment allowlist');
        }
        if (!data.credentialVersionRef || !options.verifyCredentialVersion) {
          throw unavailable('immutable S3 credential version verifier is not configured');
        }
        try {
          if (!data.credentialOwnerTenantId) throw new Error('STORAGE_CREDENTIAL_OWNER_MISSING');
          await options.verifyCredentialVersion(data.credentialVersionRef, data.credentialOwnerTenantId);
        } catch {
          throw unprocessable('INVALID_SCHEMA', 'the exact S3 credential revision is unavailable');
        }
      }
      const credentialOwnerTenantId = data.backend === 's3' ? data.credentialOwnerTenantId : null;
      const result = await withIdempotency<StorageGenerationRead>(
        data.idempotencyKey,
        'POST /api/internal/maintenance/storage-generations',
        data,
        async (withMarker) => {
          const response = await options.db.tx(async (client) => {
            await assertSnapshotWriteAllowed(client, `storage-stage:${canonicalPayloadHash(data)}`);
            const revision = await readControlRevision(client);
            if (revision !== data.expectedRevision) throw conflict('STATE_CONFLICT', 'storage generation changed; reload before staging');
            const generationId = randomUUID();
            const generationRevision = await client.query<{ revision: number | string }>(
              `SELECT COALESCE(MAX(revision),0)+1 AS revision FROM storage_generations`,
            );
            await client.query(
              `INSERT INTO storage_generations
                 (generation_id,revision,backend,endpoint,bucket,region,force_path_style,credential_version_ref,credential_owner_tenant_id,url_ttl_seconds,state,created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'STAGED',$11)`,
              [generationId, Number(generationRevision.rows[0]!.revision), storedConfig.backend, storedConfig.endpoint, storedConfig.bucket,
                storedConfig.region, storedConfig.forcePathStyle, storedConfig.credentialVersionRef, storedConfig.credentialOwnerTenantId, storedConfig.urlTtlSeconds, actor.actor],
            );
            const staged = await client.query<GenerationRow>(`${GENERATION_SELECT} WHERE generation_id=$1`, [generationId]);
            const row = staged.rows[0];
            if (!row) throw unavailable('staged storage generation could not be read');
            const wire = toRead(row, revision);
            await auditMutation(actor, 'storage_generation.stage', `storage-generation:${generationId}`, client);
            await withMarker(client, { status: 201, body: wire });
            return { status: 201, body: wire };
          });
          return response;
        },
      );
      return StorageGenerationReadSchema.parse(result);
    },

    async test(generationId, input, actor): Promise<StorageGenerationTestResult> {
      const parsed = StorageGenerationTestRequestSchema.safeParse(input);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'storage generation test request is invalid');
      const data = parsed.data;
      const generation = await readById(generationId);
      if (!['STAGED', 'ACTIVE', 'RETIRED'].includes(generation.state)) throw conflict('STATE_CONFLICT', 'storage generation cannot be tested in its current state');
      const requestHash = canonicalPayloadHash({ generationId, reason: data.reason });
      const testId = randomUUID();
      const probeRoot = `__dugate_maintenance_probe__/${generationId}/${testId}`;
      const begin = await options.db.tx(async (client) => {
        await assertSnapshotWriteAllowed(client, `storage-test:${data.idempotencyKey}`);
        let effect: BackupArtifactEffectHandle | null = null;
        if (options.encryption) {
          if (!options.backupArtifactEffects) throw unavailable('storage test artifact-effect gate is not configured');
          effect = await options.backupArtifactEffects.begin({
            effectKey: `storage-generation-test:${data.idempotencyKey}`,
            category: 'storage-generation-test',
            tenantId: null,
            storageGenerationId: generationId,
            objectKeySha256: hash(Buffer.from(`__dugate_maintenance_probe__/${generationId}`)),
          }, client);
        }
        const inserted = await client.query<TestRow>(
          `INSERT INTO storage_generation_tests(test_id,idempotency_key,request_hash,generation_id,state,probe_object_key,probe_sidecar_key)
           VALUES ($1,$2,$3,$4,'RUNNING',$5,$6)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING test_id,idempotency_key,request_hash,generation_id,state,result,started_at`,
          [testId, data.idempotencyKey, requestHash, generationId, `${probeRoot}/ciphertext`, `${probeRoot}/manifest`],
        );
        if (inserted.rowCount) {
          await auditMutation(actor, 'storage_generation.test.started', `storage-generation:${generationId}`, client);
          return { row: inserted.rows[0]!, created: true, effect };
        }
        const previous = await client.query<TestRow>(
          `SELECT test_id,idempotency_key,request_hash,generation_id,state,result,started_at
             FROM storage_generation_tests WHERE idempotency_key=$1 FOR UPDATE`,
          [data.idempotencyKey],
        );
        const row = previous.rows[0];
        if (!row) throw conflict('IDEMPOTENCY_CONFLICT', 'storage test idempotency record was not found');
        if (row.request_hash !== requestHash || row.generation_id !== generationId) throw conflict('IDEMPOTENCY_CONFLICT', 'storage test key was already used for another request');
        return { row, created: false, effect };
      });
      if (!begin.created) {
        if (begin.row.result) return StorageGenerationTestResultSchema.parse(begin.row.result);
        // A lost owner process may have written a probe object. We report and
        // persist UNKNOWN; no second test or blind storage write is attempted.
        const unknown = StorageGenerationTestResultSchema.parse({
          generationId,
          status: 'UNKNOWN',
          checkedAt: now().toISOString(),
          write: 'UNKNOWN', read: 'UNKNOWN', checksum: 'UNKNOWN', crypto: 'UNKNOWN', delete: 'UNKNOWN',
          code: 'TEST_INTERRUPTED',
        });
        await options.db.tx(async (client) => {
          await client.query(
            `UPDATE storage_generation_tests SET state='UNKNOWN',result=$2,completed_at=now()
              WHERE test_id=$1 AND state='RUNNING'`,
            [begin.row.test_id, JSON.stringify(unknown)],
          );
          await options.audit.record({
            tenantId: null, actor: actor.actor, actorIssuer: actor.actorIssuer, actorSub: actor.actorSub,
            actorRole: actor.actorRole, action: 'storage_generation.test.unknown',
            resource: `storage-generation:${generationId}`, severity: 'warning',
          }, client);
        });
        return unknown;
      }

      let result: StorageGenerationTestResult;
      if (begin.effect) {
        const activated = await options.backupArtifactEffects!.activate(begin.effect.effectId);
        if (!activated) {
          result = StorageGenerationTestResultSchema.parse({
            generationId,status:'FAILED',checkedAt:now().toISOString(),write:'FAILED',read:'UNKNOWN',checksum:'UNKNOWN',
            crypto:'UNKNOWN',delete:'UNKNOWN',code:'BACKUP_EFFECT_FENCE_ACTIVE',
          });
        } else {
          try {
            result = await runProbe(asConfig(generation), await resolve(generationId), begin.row.test_id);
          } catch (error) {
            result = StorageGenerationTestResultSchema.parse({
              generationId,
              status: 'UNKNOWN', checkedAt: now().toISOString(),
              write: 'UNKNOWN', read: 'UNKNOWN', checksum: 'UNKNOWN', crypto: 'UNKNOWN', delete: 'UNKNOWN',
              code: safeErrorCode(error),
            });
          }
        }
      } else {
        try {
          result = await runProbe(asConfig(generation), await resolve(generationId), begin.row.test_id);
        } catch (error) {
          result = StorageGenerationTestResultSchema.parse({
            generationId,
            status: 'UNKNOWN', checkedAt: now().toISOString(),
            write: 'UNKNOWN', read: 'UNKNOWN', checksum: 'UNKNOWN', crypto: 'UNKNOWN', delete: 'UNKNOWN',
            code: safeErrorCode(error),
          });
        }
      }
      const effectProof = await options.db.tx(async (client): Promise<{
        objectVersionId:string|null;objectSha256:string|null;objectByteSize:number|null;
        sidecarVersionId:string|null;sidecarSha256:string|null;sidecarByteSize:number|null;metadataRowSha256:string;
      } | null> => {
        const saved = await client.query<{
          object_version_id:string|null;object_sha256:string|null;object_size_bytes:number|string|null;
          sidecar_version_id:string|null;sidecar_sha256:string|null;sidecar_size_bytes:number|string|null;
        }>(
          `UPDATE storage_generation_tests SET state=$2,result=$3,completed_at=now()
            WHERE test_id=$1 AND state='RUNNING'
            RETURNING object_version_id,object_sha256,object_size_bytes,sidecar_version_id,sidecar_sha256,sidecar_size_bytes`,
          [begin.row.test_id, result.status, JSON.stringify(result)],
        );
        await client.query(
          `UPDATE storage_generations SET tested_at=$2,test_result=$3,
                  state=CASE WHEN state='FAILED' AND $4='PASSED' THEN 'STAGED' ELSE state END
            WHERE generation_id=$1`,
          [generationId, result.checkedAt, JSON.stringify(result), result.status],
        );
        let proof = null;
        if (saved.rows[0]) {
          const row = saved.rows[0]!;
          proof = {
            objectVersionId:row.object_version_id,objectSha256:row.object_sha256,
            objectByteSize:row.object_size_bytes === null ? null : Number(row.object_size_bytes),
            sidecarVersionId:row.sidecar_version_id,sidecarSha256:row.sidecar_sha256,
            sidecarByteSize:row.sidecar_size_bytes === null ? null : Number(row.sidecar_size_bytes),
            metadataRowSha256:canonicalPayloadHash({testId:begin.row.test_id,generationId,state:result.status,result}),
          };
        }
        await options.audit.record({
          tenantId: null, actor: actor.actor, actorIssuer: actor.actorIssuer, actorSub: actor.actorSub,
          actorRole: actor.actorRole,
          action: `storage_generation.test.${result.status.toLowerCase()}`,
          resource: `storage-generation:${generationId}`,
          severity: result.status === 'PASSED' ? 'success' : 'warning',
        }, client);
        return proof;
      });
      if (begin.effect && options.backupArtifactEffects) {
        if (result.delete === 'PASSED' && effectProof?.objectVersionId && effectProof.objectSha256
          && effectProof.objectByteSize !== null && effectProof.sidecarVersionId && effectProof.sidecarSha256
          && effectProof.sidecarByteSize !== null) {
          const settled = await options.backupArtifactEffects.settle(begin.effect.effectId,effectProof);
          if (!settled) await options.backupArtifactEffects.markUnknown(begin.effect.effectId,'STORAGE_TEST_SETTLEMENT_UNPROVEN');
        } else {
          await options.backupArtifactEffects.markUnknown(begin.effect.effectId,'STORAGE_TEST_EFFECT_UNRESOLVED');
        }
      }
      return result;
    },

    async activate(generationId, input, actor): Promise<StorageGenerationMutationResult> {
      const parsed = StorageGenerationActionRequestSchema.safeParse(input);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'storage generation activation request is invalid');
      const data = parsed.data;
      const payload = { generationId, ...data };
      return withIdempotency<StorageGenerationMutationResult>(
        data.idempotencyKey,
        'POST /api/internal/maintenance/storage-generations/:id/activate',
        payload,
        async (withMarker) => ({ status: 200, body: await options.db.tx(async (client) => {
          await assertSnapshotWriteAllowed(client, `storage-activate:${generationId}:${data.idempotencyKey}`);
          const control = await client.query<{ active_generation_id: string; revision: number | string }>(
            `SELECT active_generation_id,revision FROM storage_generation_state WHERE singleton=true FOR UPDATE`,
          );
          if (!control.rowCount) throw unavailable('storage generation has not been initialized from trusted configuration');
          if (Number(control.rows[0]!.revision) !== data.expectedRevision) throw conflict('STATE_CONFLICT', 'storage generation changed; reload before activation');
          const target = await client.query<GenerationRow>(
            `${GENERATION_SELECT} WHERE generation_id=$1 FOR UPDATE`, [generationId],
          );
          if (!target.rowCount) throw notFound('storage generation not found');
          const candidate = target.rows[0]!;
          const restoreTarget = await client.query(
            `SELECT 1 FROM maintenance_restore_attempts WHERE target_generation_id=$1 LIMIT 1`,
            [generationId],
          );
          if (restoreTarget.rowCount) throw conflict('RESTORE_GENERATION_ISOLATED', 'a generation used for isolated restore cannot be activated in the live storage router');
          if (candidate.state !== 'STAGED' || !isPassingTest(candidate.test_result)) {
            throw conflict('STATE_CONFLICT', 'storage generation must pass write/read/checksum/crypto/delete tests before activation');
          }
          const previousId = control.rows[0]!.active_generation_id;
          const previous = await client.query<GenerationRow>(`${GENERATION_SELECT} WHERE generation_id=$1 FOR UPDATE`, [previousId]);
          const nextRevision = Number(control.rows[0]!.revision) + 1;
          await client.query(`UPDATE storage_generations SET state='RETIRED' WHERE generation_id=$1`, [previousId]);
          await client.query(`UPDATE storage_generations SET state='ACTIVE',activated_at=now() WHERE generation_id=$1`, [generationId]);
          await client.query(
            `UPDATE storage_generation_state SET active_generation_id=$1,revision=$2,updated_at=now() WHERE singleton=true`,
            [generationId, nextRevision],
          );
          const activeWire = toRead({ ...candidate, state: 'ACTIVE', activated_at: now() }, nextRevision);
          const previousWire = previous.rowCount ? toRead({ ...previous.rows[0]!, state: 'RETIRED' }, nextRevision) : null;
          const body: StorageGenerationMutationResult = { active: activeWire, previous: previousWire, controlRevision: nextRevision };
          await auditMutation(actor, 'storage_generation.activate', `storage-generation:${generationId}`, client, 'success');
          await withMarker(client, { status: 200, body });
          return body;
        }) }),
      );
    },

    async rollback(generationId, input, actor): Promise<StorageGenerationMutationResult> {
      const parsed = StorageGenerationActionRequestSchema.safeParse(input);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'storage generation rollback request is invalid');
      const data = parsed.data;
      const payload = { generationId, ...data };
      return withIdempotency<StorageGenerationMutationResult>(
        data.idempotencyKey,
        'POST /api/internal/maintenance/storage-generations/:id/rollback',
        payload,
        async (withMarker) => ({ status: 200, body: await options.db.tx(async (client) => {
          await assertSnapshotWriteAllowed(client, `storage-rollback:${generationId}:${data.idempotencyKey}`);
          const control = await client.query<{ active_generation_id: string; revision: number | string }>(
            `SELECT active_generation_id,revision FROM storage_generation_state WHERE singleton=true FOR UPDATE`,
          );
          if (!control.rowCount) throw unavailable('storage generation has not been initialized from trusted configuration');
          if (Number(control.rows[0]!.revision) !== data.expectedRevision) throw conflict('STATE_CONFLICT', 'storage generation changed; reload before rollback');
          const target = await client.query<GenerationRow>(
            `${GENERATION_SELECT} WHERE generation_id=$1 FOR UPDATE`, [generationId],
          );
          if (!target.rowCount) throw notFound('storage generation not found');
          const candidate = target.rows[0]!;
          const restoreTarget = await client.query(
            `SELECT 1 FROM maintenance_restore_attempts WHERE target_generation_id=$1 LIMIT 1`,
            [generationId],
          );
          if (restoreTarget.rowCount) throw conflict('RESTORE_GENERATION_ISOLATED', 'a generation used for isolated restore cannot be activated in the live storage router');
          if (candidate.state !== 'RETIRED' || !isPassingTest(candidate.test_result)) {
            throw conflict('STATE_CONFLICT', 'rollback target must be retained and have a passing storage test');
          }
          const previousId = control.rows[0]!.active_generation_id;
          const previous = await client.query<GenerationRow>(`${GENERATION_SELECT} WHERE generation_id=$1 FOR UPDATE`, [previousId]);
          const nextRevision = Number(control.rows[0]!.revision) + 1;
          await client.query(`UPDATE storage_generations SET state='RETIRED' WHERE generation_id=$1`, [previousId]);
          await client.query(`UPDATE storage_generations SET state='ACTIVE',activated_at=now() WHERE generation_id=$1`, [generationId]);
          await client.query(
            `UPDATE storage_generation_state SET active_generation_id=$1,revision=$2,updated_at=now() WHERE singleton=true`,
            [generationId, nextRevision],
          );
          const activeWire = toRead({ ...candidate, state: 'ACTIVE', activated_at: now() }, nextRevision);
          const previousWire = previous.rowCount ? toRead({ ...previous.rows[0]!, state: 'RETIRED' }, nextRevision) : null;
          const body: StorageGenerationMutationResult = { active: activeWire, previous: previousWire, controlRevision: nextRevision };
          await auditMutation(actor, 'storage_generation.rollback', `storage-generation:${generationId}`, client, 'warning');
          await withMarker(client, { status: 200, body });
          return body;
        }) }),
      );
    },

    forGeneration: facadeFor,
    multipartForGeneration: multipartFacadeFor,
  };
}

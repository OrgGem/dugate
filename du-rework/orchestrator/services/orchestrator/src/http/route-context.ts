/**
 * CONV-02: the typed route context shared by the thin dispatcher in
 * server.ts and the audience families under src/http/routes/. Moved verbatim
 * out of server.ts. `ServerConfig` stays owned by server.ts and is imported
 * TYPE-ONLY here, so the runtime module graph stays acyclic.
 */
import type IORedis from 'ioredis';
import type { Queue } from 'bullmq';
import type { Readable } from 'node:stream';
import type { Db } from '../db/db';
import type { createRegistryService } from '../modules/registry/registry';
import type { ProfileService } from '../modules/profiles/profiles';
import type { AuditService } from '../modules/audit/audit';
import type { createSubmissionService } from '../modules/operations/submission';
import type { createRuntimeService, QueueIntegrityHealth } from '../modules/runtime/runtime';
import type { createUsageService } from '../modules/usage/usage';
import type { ArtifactService } from '../modules/artifacts/artifacts';
import type { MultipartService } from '../modules/artifacts/multipart-service';
import type { DeliveryEncryptionService, PublicUploadGateway } from '../modules/public-api';
import type { GrantService } from '../modules/grants/grants';
import type { ConnectorProxy } from '../modules/connectors/connectors';
import type { ConnectorManagementStore } from '../modules/connectors/connector-management-store';
import type { MetadataCrypto } from '../modules/runtime/metadata-crypto';
import type { MetadataReader } from '../modules/encryption/metadata-read-policy';
import type { createLifecycleService } from '../modules/lifecycle/lifecycle';
import type { createDispatcher } from '../modules/queue/dispatcher';
import type { CredentialWorkflow } from '../modules/connector-credentials/workflow';
import type { ArtifactDecryptDeps } from '../modules/encryption/artifact-read-decrypt';
import type { CryptoConfigServiceOptions } from '../app/admin/crypto-config-api';
import type { ServerConfig } from '../server';
import type { IngressAudience } from './ingress-guard';

/** FIX-CR-13: raw binary payload — sent byte-for-byte, never JSON-encoded. */
export interface RouteResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer | Readable;
}

export interface RouteContext {
  /**
   * PM-M02-ROUTE: which listener accepted this request. REQUIRED and
   * server-owned — set from the server closure, never from a header, query,
   * body or defaulted to `internal`.
   */
  ingressAudience: IngressAudience;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
  /** Public upload bytes stay an incoming stream all the way to crypto. */
  bodyStream?: AsyncIterable<Uint8Array>;
  correlationId: string;
  host: string;
  db: Db;
  redis: IORedis;
  registry: ReturnType<typeof createRegistryService>;
  profiles: ProfileService;
  audit: AuditService;
  submission: ReturnType<typeof createSubmissionService>;
  runtime: ReturnType<typeof createRuntimeService>;
  usage: ReturnType<typeof createUsageService>;
  artifacts: ArtifactService;
  /** DATA-02 client-driven multipart upload lifecycle. */
  multipart: MultipartService;
  /** Null/unset unless S3 and the Vault-backed app crypto are configured. */
  publicUploadGateway?: PublicUploadGateway | null;
  grants: GrantService | null;
  connectors: ConnectorProxy;
  lifecycle: ReturnType<typeof createLifecycleService>;
  dispatcher: ReturnType<typeof createDispatcher>;
  getQueue: (name: string) => Queue;
  /** MM-05: latest queue-integrity sweep snapshot; undefined before the first. */
  queueIntegrity: () => QueueIntegrityHealth | undefined;
  /** VAULT-03: Admin provider-key credential workflow (config-injected). */
  credentialWorkflow: CredentialWorkflow | undefined;
  /**
   * CONNECTOR-WIRE-A: the platform's connector management proxy (list/read/
   * writes), composed at boot from `connectorBaseUrls`. Absent = the
   * management surface fails closed (503) and capabilities report false.
   */
  connectorManagement?: ConnectorManagementStore;
  /**
   * ENCMETA-RESULTREF-IMPL: the metadata seam for sealed control-plane reads
   * that happen in routes (the public /result route opens the operation's
   * result_ref). Undefined = no seam configured; readers keep the historical
   * plaintext value.
   */
  metadataCrypto?: MetadataCrypto;
  /**
   * CONTROL-PLANE-IMPL-818: the boot-built reader for the plaintext decision.
   * Routes read through this instead of passing a literal `allowPlaintext`;
   * absent (an in-process boot) the bounded compatibility reader applies.
   */
  metadataReader?: MetadataReader;
  /** ENC-07: delivery encryption service; null when no tenant policy exists. */
  deliveryEncryption: DeliveryEncryptionService | null;
  /** CR28-01: authenticated read of a sealed artifact; null when not on S3 crypto. */
  artifactDecryptDeps: ArtifactDecryptDeps | null;
  /** ENC-08: crypto-configuration service options; null when not configured. */
  cryptoConfig: CryptoConfigServiceOptions | null;
  config: ServerConfig;
}

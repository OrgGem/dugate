/**
 * Typed Admin BFF wire types (AWEB-02).
 *
 * These mirror the Orchestrator BFF (`/admin/api/*`, see
 * services/orchestrator/src/app/admin/bff/*). Browser-safe only: no token,
 * no server view model, no DB shape.
 */

export interface AdminWebSession {
  schemaVersion: string;
  plane: 'oidc' | 'legacy';
  role: 'admin' | 'operator' | 'viewer';
  principal: {
    kind: 'platform' | 'tenant_operator' | 'unscoped';
    tenantId: string | null;
  };
  scope: { kind: 'platform' } | { kind: 'tenant'; tenantId: string } | null;
  displayName: string;
  /** Server-side CSRF proof; echo it in `X-CSRF-Token` on mutations. */
  csrfToken: string;
}

/** problem+json shape shared with the platform JSON API (@du/contracts). */
export interface AdminApiProblem {
  type?: string;
  title?: string;
  status: number;
  code?: string;
  correlationId?: string;
  errors?: { pointer: string; message: string }[];
}

export type AdminApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; problem: AdminApiProblem };

/** A tenant roster row, with the id kept as a selection value only. */
export interface TenantRow {
  id: string;
  name: string;
  state: string;
}

/** Page returned by GET /admin/api/tenants. */
export interface TenantPage {
  items: TenantRow[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// AWEB-05 wire shapes (BFF /admin/api/*)
// ---------------------------------------------------------------------------

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  prefix: string;
  maskedHint: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Display-only projection of a profile binding (server stays authoritative). */
export interface ApiKeyGrant {
  businessId: string;
  businessVersion: string;
  action: string;
  grantedAt: string;
}

export interface ApiKeyPage {
  items: ApiKeyRow[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
  grants: ApiKeyGrant[];
  /** Always null on reads; copy-once only ever rides the issue response. */
  createCopyOnce: unknown;
}

/**
 * Degraded read projection: the platform's honest answer when no connector
 * management store is composed (endpoint-only placeholder). Kept as its own
 * shape so the UI can tell it apart from a real ledger revision.
 */
export interface ConnectorRevision {
  connectorId: string;
  revision: number;
  adapter: string;
  endpoint: { kind: string; maskedHost: string };
  capabilities: string[];
  state: string;
  createdAt: string;
  updatedAt: string;
  secretSlots: unknown[];
  testResult: unknown;
}

// ---------------------------------------------------------------------------
// CONNECTOR-WIRE-B — connector management wire (BFF /admin/api/connectors*)
// Browser-safe mirror of `@du/contracts` connector-management.ts. Redaction is
// the wire contract: header VALUES arrive `[REDACTED]` from the connector and
// no shape here carries credential material (write-only, rotate-owned).
// ---------------------------------------------------------------------------

export type ConnectorRevisionState = 'PENDING' | 'ACTIVE' | 'RETIRED';

/** One real ledger revision as the platform republishes it. */
export interface ConnectorManagementRevision {
  connectorId: string;
  revision: number;
  adapter: string;
  state: ConnectorRevisionState;
  config: Record<string, unknown>;
  /** Opaque credential slot label — never the value. */
  credentialRef?: string;
  /** Coordinates only (mount/path/account/…), never a secret. */
  credentialSource?: Record<string, unknown>;
  tenantId?: string;
  accountId?: string;
}

/** `{ items }` from the platform list, plus how many rows the browser skipped. */
export interface ConnectorListPage {
  items: ConnectorManagementRevision[];
  /** Rows the reader refused (unknown field / bad shape) — never invented. */
  skipped: number;
}

/** Composition booleans plus known connector ID keys, never configuration values. */
export interface ConnectorCapabilities {
  management: boolean;
  credentialWorkflow: boolean;
  test: boolean;
  knownConnectorIds: string[];
}

/**
 * The revision read answers in exactly two honest shapes: a real management
 * revision when the store is composed, the endpoint-only placeholder when it
 * is not. The reader discriminates on the key set, never on a value.
 */
export type ConnectorRevisionRead =
  | { kind: 'management'; revision: ConnectorManagementRevision }
  | { kind: 'legacy'; revision: ConnectorRevision };

/** `connector.upsert` params — discriminated write shapes (mirrors contracts). */
export interface ConnectorCreateParams {
  mode: 'create';
  connectorId: string;
  adapter: string;
  config: Record<string, unknown>;
  /** Opaque slot label; the value is written only by connectors.rotate_credential. */
  credentialRef: string;
  state?: 'ACTIVE' | 'PENDING';
}

export interface ConnectorRevisionCloneParams {
  mode: 'revision';
  connectorId: string;
  credentialSource: Record<string, unknown>;
  tenantId: string;
  accountId: string;
}

export type ConnectorUpsertParams = ConnectorCreateParams | ConnectorRevisionCloneParams;

export interface ConnectorActivateParams {
  connectorId: string;
  revision: number;
  /** CAS guard: activation wins only while the ACTIVE head still matches. */
  expectedCurrentRevision: number;
}

export interface ConnectorRevisionTarget {
  connectorId: string;
  revision: number;
}

/** Narrow probe result — the only keys the platform is willing to republish. */
export interface ConnectorTestResult {
  ok: boolean;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// AWEB-04 Profile wire — conformant with the FROZEN Phase-1 contract
// (coordination/reports/profile-parity-phase1-2026-10-04.md §5/§7).
// ---------------------------------------------------------------------------

/** One parameter value; `isLocked` slots are display-only (server 400s any send). */
export interface ProfileParameterValue {
  value: unknown;
  isLocked?: boolean;
}

export interface ConnectionStep {
  slug: string;
  stepId?: string;
  captureSession?: boolean;
  injectSession?: boolean;
}

/** WRITE-only (snake_case, legacy parity) — never returned by a read. */
export interface FileUrlAuthConfigWrite {
  type: 'none' | 'bearer' | 'header' | 'query';
  token?: string;
  header_name?: string;
  header_value?: string;
  query_key?: string;
  query_value?: string;
}

/** READ policy — secret replaced by `fileUrlAuthConfigured`. */
export interface RequestRedactionRule { pattern: string; flags?: string; replacement?: string }

export interface ProfilePolicyRead {
  enabled: boolean;
  parameters: Record<string, ProfileParameterValue>;
  jobPriority: 'LOW' | 'MEDIUM' | 'HIGH';
  allowedFileExtensions: string;
  fileUrlAuthConfigured: boolean;
  connectionsOverride: ConnectionStep[];
  requestRedaction?: RequestRedactionRule[];
  /** CB-04: versioned callback policy when the profile revision carries one. */
  callbackPolicy?: ProfileCallbackPolicy | null;
  /** Read-only marker; malformed stored callback content is never returned. */
  callbackPolicyInvalid?: true;
}

export interface ProfileCapability {
  connectorId: string;
  capability: string;
}

export interface ProfileDetail {
  businessId: string;
  businessVersion: string;
  profileName: string;
  /** Real active revision (0 only if the backend has no pointer yet). */
  revision: number;
  currentValues: Record<string, unknown>;
  policy: ProfilePolicyRead;
  manifest: { actions: { name?: string; action?: string }[] };
  capabilities: ProfileCapability[];
  /**
   * T-API-01 closure: the opaque API-key row id this profile belongs to. The
   * detail read reveals it (never the hash) so the profile.* commands can
   * address the profile; absent on the `/new` sentinel and on profiles that
   * are not stored yet.
   */
  apiKeyId?: string;
}

export interface ProfileMutationResult {
  revision?: number;
  [key: string]: unknown;
}

/** The write identity every profile.* command must carry (Δ7-A). */
export interface ApiKeyIdRef {
  apiKeyId: string;
}

export interface PolicyUpsertBody {
  expectedRevision?: number;
  policy: Record<string, unknown>;
  apiKey?: ApiKeyIdRef;
}

export interface ProfilePublishBody {
  expectedRevision: number;
  apiKey?: ApiKeyIdRef;
}

export interface ProfileRollbackBody {
  targetRevision: number;
  expectedRevision?: number;
  apiKey?: ApiKeyIdRef;
}

// ---------------------------------------------------------------------------
// AWEB-06 Operations / Usage / Business wire
// ---------------------------------------------------------------------------

export interface OperationWire {
  id: string;
  state: string;
  tenantId: string | null;
  businessId: string | null;
  action: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  retryOf?: string | null;
  errorCode?: string | null;
  deadlineAt?: string | null;
}

export interface OperationsPage {
  items: OperationWire[];
  total: number;
  limit: number;
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface OperationArtifactWire {
  role: string;
  status: string;
  downloadUrl: string | null;
  contentType: string | null;
}

export interface OperationTaskWire { id: string; taskKey: string; kind: string; state: string; attempt: number; maxAttempts: number; errorCode: string | null; }

export interface OperationDetail {
  tasks?: OperationTaskWire[];
  requestInput?: { data: unknown; status: 'REDACTED' | 'NO_RULES' | 'HIDDEN'; ruleCount: number };
  operation: OperationWire | null;
  resultSummary: string | null;
  artifacts: OperationArtifactWire[];
  serverNow: string | null;
  raw: Record<string, unknown>;
}

export type UsageSummary = Record<string, unknown>;

export interface BusinessRow {
  businessId: string;
  activeVersion: string | null;
  version: string | null;
  status: string;
  updatedAt: string | null;
}

export interface BusinessPage {
  items: BusinessRow[];
  total: number;
  limit: number;
}

export interface BusinessVersionRow {
  version: string;
  status: string;
  isActive: boolean;
  updatedAt: string | null;
}

export interface BusinessVersions {
  businessId: string;
  activeVersion: string | null;
  rows: BusinessVersionRow[];
}

export interface BffHealthResponse {
  status: 'ok' | 'degraded' | 'unknown';
  db: boolean | null;
  redis: boolean | null;
  activeLeases: number;
  queueIntegrity: {
    state: 'OK' | 'RECONSTRUCTING' | 'SUSPECT';
    orphansLast: number;
    stalled: number;
    lastSweepAt: string | null;
  } | null;
  outboxBacklog: number | null;
  sampledAt: string;
}

// ---------------------------------------------------------------------------
// AWEB-07 Security wire
// ---------------------------------------------------------------------------

/** crypto-config view — refs/previews only, secrets never ride this wire. */
export interface CryptoConfigView {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SC-03 Secret catalog wire (mirrors the frozen @du/contracts shapes)
// ---------------------------------------------------------------------------

export const SECRET_PURPOSES = [
  'connector.credential',
  'connector.provider_header',
  'profile.callback_header',
  'profile.callback_oauth2_client_secret',
  'oidc.client_secret',
  'source.auth',
  'generic',
] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export const SECRET_SERVICES = ['orchestrator', 'connector'] as const;
export type SecretService = (typeof SECRET_SERVICES)[number];

export type SecretState = 'ACTIVE' | 'DISABLED' | 'REVOKED';

export type VaultVersionMode = { mode: 'pinned'; version: number } | { mode: 'latest' };

export interface ManagedValueProvider {
  kind: 'managed_value';
}

export interface VaultReferenceProvider {
  kind: 'vault_reference';
  connectionId: string;
  mount: string;
  path: string;
  field: string;
  namespace?: string;
  version: VaultVersionMode;
}

export type SecretProvider = ManagedValueProvider | VaultReferenceProvider;

export interface SecretUsageReference {
  kind: 'connector_credential' | 'profile_callback' | 'oidc_client' | 'source_auth';
  refId: string;
  revision?: number;
}

export interface SecretRotationMetadata {
  rotatedAt: string | null;
  intervalDays: number | null;
}

/** Read projection: metadata ONLY, never a value (`valueConfigured` boolean). */
export interface SecretCatalogEntryRead {
  catalogVersion: 1;
  secretId: string;
  tenantId: string;
  name: string;
  purpose: SecretPurpose;
  services: SecretService[];
  provider: SecretProvider;
  state: SecretState;
  revision: number;
  rotation?: SecretRotationMetadata;
  valueConfigured: boolean;
  usageReferences: SecretUsageReference[];
}

export interface SecretCatalogListPage {
  items: SecretCatalogEntryRead[];
  nextCursor: string | null;
}

export interface SecretCatalogCreateBody {
  tenantId: string;
  name: string;
  purpose: SecretPurpose;
  services: SecretService[];
  provider: SecretProvider;
  /** Required for managed_value; forbidden for vault_reference. Write-only. */
  value?: { kind: 'literal'; value: string };
}

export interface SecretCatalogRotateBody {
  expectedRevision: number;
  value: { kind: 'literal'; value: string };
}

export interface SecretCatalogDisableBody {
  expectedRevision: number;
  reason: string;
}

/** Safe probe result: availability/error code only, never a value. */
export interface SecretProbeResult {
  ok: boolean;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// CB-04 Callback policy wire (mirrors the frozen @du/contracts shapes)
// ---------------------------------------------------------------------------

export type CallbackMode = 'notification_only' | 'notification_with_result';
export type CallbackAuthMethod = 'none' | 'configured_headers' | 'oauth2_client_credentials';

/** Opaque managed-secret reference; the catalog secretId is the stable id. */
export interface CallbackSecretRef {
  kind: 'managed-secret';
  ref: string;
}

export interface CallbackConfiguredHeader {
  name: string;
  secretRef: CallbackSecretRef;
  prefix?: string;
}

export interface CallbackNoneAuth {
  method: 'none';
}

export interface CallbackConfiguredHeadersAuth {
  method: 'configured_headers';
  headers: CallbackConfiguredHeader[];
}

export interface CallbackOAuth2Auth {
  method: 'oauth2_client_credentials';
  grantType: 'client_credentials';
  tokenUrl: string;
  clientId: string;
  clientSecretRef: CallbackSecretRef;
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
  scope?: string;
  audience?: string;
  resource?: string;
  extensions?: Record<string, string>;
  additionalHeaders?: { name: string; value: string }[];
  tokenLifetimeSeconds?: number;
}

export type CallbackAuth = CallbackNoneAuth | CallbackConfiguredHeadersAuth | CallbackOAuth2Auth;

export interface CallbackDestinationAuthorization {
  approvedOrigins: string[];
  allowedPathPrefixes?: string[];
}

export interface ProfileCallbackPolicy {
  version: 1;
  mode: CallbackMode;
  auth: CallbackAuth;
  destination?: CallbackDestinationAuthorization | null;
  forceReferenceOnly?: boolean;
}

export interface WorkflowCatalogItem {
  tenantId: string;
  slug: string;
  revision: number;
  digest: string;
  status: 'active' | 'retired';
  createdAt: string;
  name?: string;
  description?: string;
  nodesCount?: number;
  stages?: string[];
  schema?: unknown;
  connectorSlotMap?: Record<string, string>;
  approvedEgressOrigins?: string[];
}

export interface WorkflowCatalogPage {
  items: WorkflowCatalogItem[];
  total: number;
}

export interface WorkflowDetailResponse {
  active: WorkflowCatalogItem | null;
  revisions: WorkflowCatalogItem[];
}

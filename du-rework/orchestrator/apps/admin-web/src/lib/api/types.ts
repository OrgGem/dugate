/**
 * Typed Admin BFF wire types (AWEB-02).
 *
 * These mirror the Orchestrator BFF (`/admin/api/*`, see
 * services/orchestrator/src/app/admin/bff/*). Browser-safe only: no token,
 * no server view model, no DB shape.
 */

import type {
  ProviderReportedCost,
  TenantActiveConnectorCatalogQuery,
} from '@du/contracts';

// ORV14 leaf contracts are authored in `@du/contracts`; the shared browser
// API barrel re-exports their data types without runtime validators.
export type {
  AdminWorkbenchEndpointTestRequest,
  AdminWorkbenchOperationAccepted,
  AdminWorkbenchPromptWizardRequest,
  ApiKeyIssue,
  ApiKeyLifecyclePage,
  ApiKeyLifecycleRow,
  ApiKeyMutationResult,
  ApiKeyNote,
  ApiKeyRotate,
  ConnectorCredentialStage,
  ConnectorDraftUpsert,
  ConnectorParityActivationResult,
  ConnectorParityDraftResult,
  ConnectorParityRevision,
  ConnectorRecipe,
  IdentityAssignableUserPage,
  IdentityAssignmentReplace,
  IdentityAssignmentSet,
  IdentityMutationResponse,
  IdentityPasswordReset,
  IdentitySnapshot,
  IdentityUser,
  IdentityUserPage,
  CreateIdentityUserParams,
  UpdateIdentityUserParams,
  ParityIdentityUserResponse,
  ProviderTestRequest,
  ProviderTestResult,
  ProfileSelfServiceAssignedApiKeyPage,
  ProfileSelfServiceAssignedApiKeyQuery,
  ProfileSelfServiceAssignedPage,
  ProfileSelfServiceAssignedQuery,
  ProfileSelfServiceEditRequest,
  ProfileSelfServiceEditResponse,
  WorkflowImportPreviewRequest,
  WorkflowImportPreviewResponse,
  TenantAiDraftRequest,
  TenantAiRevision,
  TenantAiTestRequest,
  TenantAiTestResult,
  TenantGlobalSettingsRead,
  TenantAiDefaults,
  TenantPromptDefaults,
  TenantDefaultsSnapshot,
  TenantPromptDraftRequest,
  TenantPromptRevision,
  PlatformRetentionDraftRequest,
  PlatformRetentionRead,
  GlobalSettingsPublishRequest,
  GlobalSettingsRollbackRequest,
  GlobalSettingsMutationResult,
  Incident,
  IncidentAcknowledgeRequest,
  IncidentAssignRequest,
  IncidentDetail,
  IncidentListPage,
  IncidentListQuery,
  IncidentResolveRequest,
  MaintenanceSuppression,
  MaintenanceSuppressionCreate,
  MaintenanceSuppressionList,
  ServiceInventory,
  QueueInventory,
  QueueActionPreviewRequest,
  QueueActionPreview,
  ConfirmQueueAction,
  QueueActionJob,
  MaintenancePreviewRequest,
  MaintenancePreview,
  StartMaintenanceJob,
  MaintenanceJob,
  ReplicaRolloutPreviewRequest,
  ReplicaRolloutPreview,
  ExecuteReplicaRollout,
  ReplicaRolloutJob,
  PreviewReplicaRollback,
  ReplicaRollbackPreview,
  ExecuteReplicaRollback,
  StorageGenerationStageRequest,
  StorageGenerationRead,
  StorageGenerationTestRequest,
  StorageGenerationTestResult,
  StorageGenerationActionRequest,
  StorageGenerationMutationResult,
  CostControlBudgetList,
  CostControlBudgetDetail,
  CostControlPriceList,
  PersistedBudgetRevision,
  PersistedPriceRevision,
  BudgetDraftWrite,
  PriceDraftWrite,
  CostPolicyTransitionRequest,
  CostPolicyRollbackRequest,
  CostAlertChannelList,
  CostPolicyScopeCatalog,
  CostPolicyScopeCatalogQuery,
  CostBudgetAlertBinding,
  CostBudgetAlertBindingWrite,
  CostAlertList,
  CostAlertListQuery,
  CostAlertInboxPage,
  CostAlertInboxQuery,
  CostAlertInboxReadAck,
  CostAlertRecipient,
  CostAlertRecipientCatalog,
  CostAlertRecipientCatalogQuery,
  CostAlertRecipientLifecycleWrite,
  CostAlertRecipientLifecycleResult,
  CostAdjustmentCommand,
  CostAdjustmentCommandResult,
  CostAdjustmentEvidencePage,
  CostAdjustmentEvidenceQuery,
  CostAdjustmentHistoryPage,
  CostAdjustmentQuery,
  TenantActiveConnectorCatalogItem,
  TenantActiveConnectorCatalogPage,
  TenantActiveConnectorCatalogQuery,
  ProviderReportedCost,
  ProfileGroup,
  ProfileGroupFunctionCatalog,
  ProfileGroupList,
  ProfileGroupRollback,
  ProfileGroupSave,
} from '@du/contracts';

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
  /** True only for a validated local USER session; identity material stays server-side. */
  localUser: boolean;
  /** Server-side CSRF proof; echo it in `X-CSRF-Token` on mutations. */
  csrfToken: string;
}

/** Server-side tenant triage filters exposed by the shared operations client. */
export interface AdminOperationsQuery {
  limit?: string;
  cursor?: string;
  state?: string;
  tenant?: string;
  id?: string;
  sort?: string;
  from?: string;
  to?: string;
  business?: string;
  action?: string;
  apiKey?: string;
  profile?: string;
  correlation?: string;
  provider?: string;
  model?: string;
  usage?: 'has-recorded-usage' | 'no-recorded-usage';
  reservation?: 'unknown';
  attention?: 'waiting-input';
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
  /** Operator label; null when the key was never named. */
  name: string | null;
  maskedHint: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** 0039: one key OF a profile — the credential, plus why it does or does not resolve. */
export interface ProfileApiKeyRow {
  id: string;
  tenantId: string;
  prefix: string;
  /** Operator label; null when the key was never named. */
  name: string | null;
  /** Key status from api_keys (ACTIVE / REVOKED). */
  status: string;
  createdAt: string;
  /** Membership state from profile_api_keys — authoritative for resolution. */
  membershipState: string;
  joinedAt: string;
  revokedAt: string | null;
}

/**
 * 0039: what the BFF relays back from a membership write.
 *
 * attach and rotate answer DIFFERENT fields, so only the key the caller asked
 * about is required: an attach returns `profileId`/`created`, a rotate returns
 * the replacement (`apiKeyId`) plus `revokedId` and the profile set it
 * inherited. `rawKey` is copy-once - it appears on issue/rotate responses only,
 * and the caller must drop it once shown.
 */
export interface ProfileKeyActionResult {
  /** attach: the attached key. rotate: the NEW key. */
  apiKeyId: string;
  /** attach: the profile it joined. rotate: the key that was replaced. */
  profileId?: string;
  revokedId?: string;
  /** attach: false when the key was already a member. */
  created?: boolean;
  state?: string;
  /** rotate: every profile the replacement inherited. */
  profiles?: string[];
  name?: string | null;
  /** Copy-once. Never persisted, never re-fetched. */
  rawKey?: string;
}

export interface ProfileApiKeyPage {
  items: ProfileApiKeyRow[];
  nextCursor: null;
  prevCursor: null;
  total: number;
  limit: number;
  profileId: string;
}

export interface ProfileWorkflowItem {
  slug: string;
  revision: number;
  status: 'active' | 'retired';
  enabled: boolean;
  createdAt: string;
}

export interface ProfileWorkflowPage {
  businessId: string;
  businessVersion: string;
  items: ProfileWorkflowItem[];
  total: number;
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

/** Safe metadata projection for the tenant-scoped profile catalog. */
export interface ProfileListRow {
  tenantId: string;
  businessId: string;
  businessVersion: string;
  profileName: string;
  revision: number;
  status: 'ACTIVE' | 'DISABLED' | 'UNKNOWN';
  /** Memberships whose profile link and API key are both active. */
  keyCount: number;
  boundActions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProfileListPage {
  items: ProfileListRow[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
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
  /** Exact safe connector revision pins on the active profile revision. */
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
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
  endpointSlug?: string;
  connectorBindings?: Record<string, { connectorId: string; revision: number }>;
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
  progress?: { percent: number; message?: string };
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

export interface OperationTaskLinkWire { taskId: string; joinPolicy: string }
export interface OperationTaskWire {
  id: string;
  taskKey: string;
  kind: string;
  state: string;
  /** Task ancestry from tasks.parent_id; this does not mean it waits on parent completion. */
  spawnedBy?: string | null;
  /** Durable reason this unclaimed task is parked from admission. Undefined means the server omitted the field. */
  admissionParkedReason?: string | null;
  admissionParkedAt?: string | null;
  leasedBy?: string | null;
  leaseExpiresAt?: string | null;
  dueAt?: string | null;
  /** Child tasks whose results this parent joins before continuing. */
  awaitedChildren?: OperationTaskLinkWire[];
  attempt: number;
  maxAttempts: number;
  errorCode: string | null;
}

export interface OperationDetail {
  tasks?: OperationTaskWire[];
  requestInput?: { data: unknown; status: 'REDACTED' | 'NO_RULES' | 'HIDDEN'; ruleCount: number };
  operation: OperationWire | null;
  resultSummary: string | null;
  artifacts: OperationArtifactWire[];
  serverNow: string | null;
  raw: Record<string, unknown>;
}

export interface UsageSummaryRow {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
  measurement: 'measured' | 'estimated' | 'mixed' | 'pending';
  costStatus?: 'measured' | 'estimated' | 'unpriced' | 'pending';
}

/** Exact tenant-scoped projection returned by GET /admin/api/usage. */
export type UsageSummary = Record<string, unknown> & {
  tenantId: string;
  from: string;
  to: string;
  rows: UsageSummaryRow[];
  totals: {
    operations: number;
    inputTokens: number;
    outputTokens: number;
    pages: number;
    costMicrousd: number;
    costStatus?: 'measured' | 'estimated' | 'unpriced' | 'pending';
  };
};

/** BASIC_ADMIN_USAGE_V1 filters accepted by the tenant-scoped Admin event view. */
export interface UsageEventQuery {
  tenantId: string;
  from: string;
  to: string;
  timeField?: 'receivedAt';
  limit?: number;
  cursor?: string;
  operationId?: string;
  provider?: string;
  model?: string;
}

/** Persisted runtime UsageEvent facts; null keeps missing cost attribution explicit. */
export interface AdminUsageEventRecord {
  eventId: string;
  operationId: string;
  taskId: string;
  invocationId: string;
  provider: string | null;
  model: string | null;
  units: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; pages?: number };
  costMicrousd: number | null;
  costStatus: 'measured' | 'estimated' | 'unpriced' | 'pending' | null;
  /** Diagnostic-only provider figure; trusted costMicrousd remains authoritative. */
  providerReportedCost?: ProviderReportedCost;
  /** Append-only adjustment projection; costMicrousd above remains the original charge. */
  financialAccounting: {
    rootEventId: string;
    initialChargeMicrousd: number | null;
    grossChargeMicrousd: number | null;
    refundedMicrousd: number | null;
    netChargeMicrousd: number | null;
    adjustmentRevision: number;
    headAdjustmentEventId: string | null;
    semantics: 'initial-charge-plus-direct-root-adjustments-v1';
  };
  measurement: 'measured' | 'estimated';
  occurredAt: string;
  receivedAt: string;
}

export interface AdminUsageEventPage {
  tenantId: string;
  events: AdminUsageEventRecord[];
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
  skippedInvalidEvents: number;
  timeSemantics: { field: 'receivedAt'; order: 'asc'; timezone: 'UTC' };
}

// COMPOSE-OPS-01 browser-safe mirror of the bounded admin/host DTOs.
export type ComposeAction = 'apply_release' | 'rollback_release' | 'restart_service';
export type ComposeJobState = 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL' | 'UNKNOWN' | 'RECONCILED';
export type ComposeAvailability = 'FRESH' | 'STALE' | 'UNAVAILABLE';
export type ComposeSafeErrorCode =
  | 'RUNNER_NOT_CONFIGURED' | 'SNAPSHOT_NOT_RECEIVED' | 'SNAPSHOT_INVALID' | 'MANIFEST_DIGEST_MISMATCH'
  | 'DOCKER_UNAVAILABLE' | 'INVENTORY_UNAVAILABLE' | 'HEALTHCHECK_FAILED' | 'COMMAND_FAILED' | 'COMMAND_TIMEOUT'
  | 'OUTPUT_LIMIT' | 'TARGET_BUSY' | 'STALE_SAMPLE' | 'STALE_PREVIEW' | 'TARGET_REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT' | 'EXECUTION_UNCERTAIN' | 'RUNNER_REPORT_REJECTED';
export type ComposeServiceState = 'CREATED' | 'RUNNING' | 'PAUSED' | 'RESTARTING' | 'EXITED' | 'DEAD' | 'REMOVING' | 'UNKNOWN';
export type ComposeHealth = 'HEALTHY' | 'UNHEALTHY' | 'STARTING' | 'NONE' | 'UNKNOWN' | null;
export interface ComposeObservedService {
  serviceId: string;
  containerId: string | null;
  imageId: string | null;
  imageDigest: string | null;
  state: ComposeServiceState;
  health: ComposeHealth;
  startedAt: string | null;
  finishedAt: string | null;
  observedReleaseId: string | null;
}
export interface ComposeCatalogService { serviceId: string; displayName: string; restartAllowed: boolean }
export interface ComposeCatalogRelease {
  releaseId: string;
  displayName: string;
  releaseDigest: string;
  targetServices: string[];
  images: Array<{ serviceId: string; imageDigest: string }>;
  migrationCompatibility: 'acknowledged' | 'not_acknowledged';
  rollbackAllowedFrom: string[];
}
export interface ComposeActiveJob { jobId: string; state: 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'UNKNOWN' }
export interface ComposeCatalogProject {
  projectId: string;
  displayName: string;
  catalogRevision: string | null;
  manifestDigest: string | null;
  availability: ComposeAvailability;
  sampledAt: string | null;
  receivedAt: string | null;
  lastErrorCode: ComposeSafeErrorCode | null;
  observedDigest: string | null;
  targetRevision: number;
  desiredReleaseId: string | null;
  activeJob: ComposeActiveJob | null;
  services: ComposeCatalogService[];
  releases: ComposeCatalogRelease[];
  observedServices: ComposeObservedService[];
}
export interface ComposeCatalog {
  configured: boolean;
  hostId: string | null;
  manifestDigest: string | null;
  availability: ComposeAvailability;
  receivedAt: string | null;
  lastErrorCode: ComposeSafeErrorCode | null;
  projects: ComposeCatalogProject[];
}
export interface ComposePreviewRequest {
  hostId: string;
  projectId: string;
  action: ComposeAction;
  releaseId?: string;
  serviceId?: string;
  reason: string;
}
export interface ComposePreview {
  previewId: string;
  hostId: string;
  projectId: string;
  action: ComposeAction;
  releaseId: string | null;
  serviceId: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  manifestDigest: string;
  observedDigest: string;
  expectedTargetRevision: number;
  targetServices: string[];
  targetReleaseDigest: string | null;
  impact: { affectedServices: string[]; downtime: 'possible' | 'likely'; statefulServicesExcluded: true };
  warnings: Array<'POSSIBLE_SERVICE_INTERRUPTION' | 'MIGRATION_COMPATIBILITY_ACKNOWLEDGED'>;
}
export interface ComposeSubmitJobRequest { previewId: string; expectedTargetRevision: number }
export interface ComposePerServiceOutcome {
  serviceId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';
  errorCode: ComposeSafeErrorCode | null;
}
export type ComposeUncertainReason = 'CLAIM_EXPIRED' | 'START_ACK_LOST' | 'RUNNER_LOST' | 'REPORT_LOST' | 'EXECUTOR_TIMEOUT' | 'EXECUTION_UNCERTAIN' | null;
export interface ComposeJob {
  jobId: string;
  previewId: string;
  hostId: string;
  projectId: string;
  action: ComposeAction;
  releaseId: string | null;
  serviceId: string | null;
  targetReleaseDigest: string | null;
  targetServices: string[];
  reason: string;
  actorLabel: string;
  state: ComposeJobState;
  stateVersion: number;
  expectedTargetRevision: number;
  targetRevision: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  claimExpiresAt: string | null;
  observedBeforeDigest: string;
  startExpectedObservedDigest: string;
  observedBefore: ComposeObservedService[];
  observedAfter: ComposeObservedService[] | null;
  observedAfterDigest: string | null;
  perServiceOutcomes: ComposePerServiceOutcome[];
  uncertainReason: ComposeUncertainReason;
}
export interface ComposeJobListQuery {
  hostId?: string;
  projectId?: string;
  state?: ComposeJobState;
  limit?: number;
  cursor?: string;
}
export interface ComposeJobPage { items: ComposeJob[]; limit: number; hasMore: boolean; nextCursor?: string }
export interface ComposeJobSubmission { job: ComposeJob; replayed: boolean }

export interface BusinessRow {
  businessId: string;
  activeVersion: string | null;
  activationRevision?: number | null;
  admissionEligible?: boolean | null;
  admissionReason?: string | null;
  submissionsPaused?: boolean | null;
  preDrainVersion?: string | null;
  version: string | null;
  status: string;
  updatedAt: string | null;
  enabled: boolean | null;
  lifecycleRevision: number | null;
}

export interface BusinessPage {
  items: BusinessRow[];
  total: number;
  limit: number;
  nextCursor?: string | null;
}

export interface BusinessVersionRow {
  version: string;
  status: string;
  isActive: boolean;
  admissionEligible?: boolean | null;
  admissionReason?: string | null;
  /** Unique nonterminal tasks with a durable admission park reason. */
  parkedTaskCount?: number | null;
  /** Unexpired RUNNING leases on versions other than the active version. */
  drainingTaskCount?: number | null;
  /** Unique nonterminal parked tasks grouped by their durable reason. */
  parkedReasons?: Record<string, number> | null;
  updatedAt: string | null;
}

export interface BusinessVersions {
  businessId: string;
  activeVersion: string | null;
  activationRevision?: number | null;
  submissionsPaused?: boolean | null;
  preDrainVersion?: string | null;
  remainingOperations?: number | null;
  rows: BusinessVersionRow[];
  enabled: boolean | null;
  lifecycleRevision: number | null;
}

export interface WorkerInstance {
  businessId: string;
  instanceId: string;
  businessVersion: string;
  state: 'ONLINE' | 'DRAINING' | 'OFFLINE';
  health: 'HEALTHY' | 'DEGRADED' | 'OFFLINE';
  capacity: number;
  reportedActiveTasks: number | null;
  reportedObservedAt: string | null;
  /** DB lease count sampled at heartbeat time, not the worker self-report. */
  activeLeases: number;
  durableLeases: number;
  acceptedTaskCount?: number;
  acceptedTaskCountSince?: string | null;
  acceptedTaskCountScope?: 'business-instance-lifetime' | string;
  lastSeenAt: string;
  observedAt: string;
}

export interface BusinessEnabledUpdate {
  enabled: boolean;
  expectedLifecycleRevision: number;
}

export interface BusinessEnabledResult {
  businessId: string;
  enabled: boolean;
  lifecycleRevision: number;
  replayed: boolean;
}

export interface WorkerInstanceList {
  items: WorkerInstance[];
  total: number;
  sampledAt: string;
  truncated: boolean;
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
  'storage.credential',
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

/** Bounded metadata-only Secret Catalog query. Tenant scope is checked by the BFF. */
export interface SecretCatalogListQuery {
  /** Selected owner tenant for platform Admin; BFF pins operator sessions. */
  tenantId?: string;
  q?: string;
  cursor?: string;
  limit?: string;
  state?: SecretState;
  purpose?: SecretPurpose;
  service?: SecretService;
  /** Accepted for compatibility; the server still uses its fixed newest-first order. */
  sort?: string;
}

/** Tenant comes from the validated session unless a platform Admin selects one. */
export type TenantActiveConnectorCatalogClientQuery =
  Omit<TenantActiveConnectorCatalogQuery, 'tenantId'> & { tenantId?: string };

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
  businessId?: string | null;
  businessVersion?: string | null;
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

export interface MigrationReadinessRun {
  sourceVersion: string; sourceSha256: string; planSha256: string; importedAt: string;
  sourceCounts: Record<string, number>; destinationCounts: Record<string, number>;
  latestInventory: null | { recordedAt: string; inventorySha256: string; targetCounts: Record<string, number>; issueCounts: Record<string, number>; totalIssues: number; verifiedBlobCount: number; failedBlobCount: number; externalGates: string[] };
  status: 'INVENTORY_REQUIRED' | 'RECONCILIATION_REQUIRED' | 'EXTERNAL_VERIFICATION_REQUIRED';
  cutoverReady: false;
}

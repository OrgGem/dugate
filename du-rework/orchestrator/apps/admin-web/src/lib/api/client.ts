import type { MigrationReadinessRun } from './types';
/**
 * Same-origin Admin BFF client (AWEB-02).
 *
 * - Talks ONLY to `/admin/api/*` with the session cookie; no token ever
 *   enters the bundle or a header it should not (the platform bearer lives
 *   server-side in the BFF).
 * - Carries the server-issued `X-CSRF-Token` on mutations and forwards an
 *   `Idempotency-Key` when the caller provides one.
 * - Maps every failure to the typed problem envelope; nothing throws for an
 *   HTTP-level failure (transport failures fold into an `ok:false` result
 *   with status 0).
 */
import type {
  AdminApiProblem,
  AdminApiResult,
  AdminOperationsQuery,
  AdminWorkbenchEndpointTestRequest,
  AdminWorkbenchOperationAccepted,
  AdminWorkbenchPromptWizardRequest,
  ApiKeyIssue,
  ApiKeyLifecyclePage,
  ApiKeyMutationResult,
  ApiKeyNote,
  ApiKeyRotate,
  ComposeCatalog,
  ComposeJob,
  ComposeJobListQuery,
  ComposeJobPage,
  ComposeJobSubmission,
  ComposePreview,
  ComposePreviewRequest,
  ComposeSubmitJobRequest,
  AdminUsageEventPage,
  AdminWebSession,
  ApiKeyPage,
  BusinessPage,
  BusinessVersions,
  ConnectorActivateParams,
  ConnectorCredentialStage,
  ConnectorDraftUpsert,
  ConnectorParityActivationResult,
  ConnectorParityDraftResult,
  ConnectorParityRevision,
  ConnectorRevision,
  ConnectorRevisionTarget,
  ConnectorUpsertParams,
  OperationDetail,
  OperationsPage,
  IdentityAssignableUserPage,
  IdentityAssignmentReplace,
  IdentityAssignmentSet,
  IdentityPasswordReset,
  IdentitySnapshot,
  IdentityUserPage,
  ParityIdentityUserResponse,
  ProviderTestRequest,
  ProviderTestResult,
  ProfileSelfServiceAssignedApiKeyPage,
  ProfileSelfServiceAssignedApiKeyQuery,
  ProfileSelfServiceAssignedPage,
  ProfileSelfServiceAssignedQuery,
  ProfileSelfServiceEditRequest,
  ProfileSelfServiceEditResponse,
  PolicyUpsertBody,
  ProfileApiKeyPage,
  ProfileKeyActionResult,
  ProfileListPage,
  ProfileWorkflowPage,
  ProfileDetail,
  ProfileMutationResult,
  ProfilePublishBody,
  ProfileRollbackBody,
  SecretCatalogCreateBody,
  SecretCatalogDisableBody,
  SecretCatalogEntryRead,
  SecretCatalogListPage,
  SecretCatalogListQuery,
  SecretCatalogRotateBody,
  SecretProbeResult,
  TenantPage,
  TenantAiDraftRequest,
  TenantAiRevision,
  TenantAiTestRequest,
  TenantAiTestResult,
  TenantGlobalSettingsRead,
  TenantPromptDraftRequest,
  TenantPromptRevision,
  PlatformRetentionDraftRequest,
  PlatformRetentionRead,
  GlobalSettingsPublishRequest,
  GlobalSettingsRollbackRequest,
  GlobalSettingsMutationResult,
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
  CostAlertRecipientCatalogQuery,
  CostAlertRecipientCatalog,
  CostAlertRecipient,
  CostAlertRecipientLifecycleWrite,
  CostAlertRecipientLifecycleResult,
  CostAdjustmentCommand,
  CostAdjustmentCommandResult,
  CostAdjustmentEvidencePage,
  CostAdjustmentEvidenceQuery,
  CostAdjustmentHistoryPage,
  CostAdjustmentQuery,
  TenantActiveConnectorCatalogClientQuery,
  TenantActiveConnectorCatalogPage,
  UsageEventQuery,
  UsageSummary,
  WorkflowCatalogPage,
  WorkflowDetailResponse,
  WorkerInstanceList,
} from './types';

export interface AdminApiClientOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Same-origin BFF base path. */
  basePath?: string;
}

export interface ActionOptions {
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface PostActionResult {
  action: string;
  [key: string]: unknown;
}

export interface AdminHealthSnapshot {
  status: 'ok' | 'degraded' | 'unknown';
  db: boolean | null;
  redis: boolean | null;
  activeLeases: number | null;
  queueIntegrity: {
    state: 'OK' | 'RECONSTRUCTING' | 'SUSPECT';
    orphansLast: number | null;
    stalled: number | null;
    lastSweepAt: string | null;
  } | null;
  outboxBacklog: number | null;
  sampledAt: string;
}

export interface AdminApiClient {
  getSession(options?: { recoverAuth?: boolean }): Promise<AdminApiResult<AdminWebSession>>;
  getComposeCatalog(): Promise<AdminApiResult<ComposeCatalog>>;
  createComposePreview(body: ComposePreviewRequest): Promise<AdminApiResult<ComposePreview>>;
  submitComposeJob(body: ComposeSubmitJobRequest, idempotencyKey: string): Promise<AdminApiResult<ComposeJobSubmission>>;
  listComposeJobs(query?: ComposeJobListQuery): Promise<AdminApiResult<ComposeJobPage>>;
  getComposeJob(jobId: string): Promise<AdminApiResult<ComposeJob>>;
  getServiceInventory(query?: Record<string, string>): Promise<AdminApiResult<ServiceInventory>>;
  getQueueInventory(query?: Record<string, string>): Promise<AdminApiResult<QueueInventory>>;
  previewQueueAction(body: QueueActionPreviewRequest): Promise<AdminApiResult<QueueActionPreview>>;
  executeQueueAction(body: ConfirmQueueAction): Promise<AdminApiResult<QueueActionJob>>;
  getQueueActionJob(jobId: string): Promise<AdminApiResult<QueueActionJob>>;
  previewMaintenance(body: MaintenancePreviewRequest): Promise<AdminApiResult<MaintenancePreview>>;
  startMaintenanceJob(body: StartMaintenanceJob): Promise<AdminApiResult<MaintenanceJob>>;
  getMaintenanceJob(jobId: string): Promise<AdminApiResult<MaintenanceJob>>;
  previewReplicaRollout(body: ReplicaRolloutPreviewRequest): Promise<AdminApiResult<ReplicaRolloutPreview>>;
  executeReplicaRollout(body: ExecuteReplicaRollout): Promise<AdminApiResult<ReplicaRolloutJob>>;
  getReplicaRolloutJob(jobId: string): Promise<AdminApiResult<ReplicaRolloutJob>>;
  previewReplicaRollback(jobId: string, body: PreviewReplicaRollback): Promise<AdminApiResult<ReplicaRollbackPreview>>;
  executeReplicaRollback(jobId: string, body: ExecuteReplicaRollback): Promise<AdminApiResult<ReplicaRolloutJob>>;
  getStorageGeneration(): Promise<AdminApiResult<StorageGenerationRead>>;
  listStorageGenerations(): Promise<AdminApiResult<StorageGenerationRead[]>>;
  stageStorageGeneration(body: StorageGenerationStageRequest): Promise<AdminApiResult<StorageGenerationRead>>;
  testStorageGeneration(generationId: string, body: StorageGenerationTestRequest): Promise<AdminApiResult<StorageGenerationTestResult>>;
  activateStorageGeneration(generationId: string, body: StorageGenerationActionRequest): Promise<AdminApiResult<StorageGenerationMutationResult>>;
  rollbackStorageGeneration(generationId: string, body: StorageGenerationActionRequest): Promise<AdminApiResult<StorageGenerationMutationResult>>;
  listCostBudgets(tenantId: string): Promise<AdminApiResult<CostControlBudgetList>>;
  getCostBudget(tenantId: string, budgetId: string): Promise<AdminApiResult<CostControlBudgetDetail>>;
  createCostBudgetDraft(body: BudgetDraftWrite, idempotencyKey: string): Promise<AdminApiResult<PersistedBudgetRevision>>;
  transitionCostBudget(budgetId: string, action: 'review' | 'publish' | 'retire', body: CostPolicyTransitionRequest, idempotencyKey: string): Promise<AdminApiResult<PersistedBudgetRevision>>;
  rollbackCostBudget(budgetId: string, body: CostPolicyRollbackRequest, idempotencyKey: string): Promise<AdminApiResult<PersistedBudgetRevision>>;
  listCostAlertChannels(tenantId: string): Promise<AdminApiResult<CostAlertChannelList>>;
  getCostPolicyScopeCatalog(tenantId: string, query: Omit<CostPolicyScopeCatalogQuery, 'tenantId'>): Promise<AdminApiResult<CostPolicyScopeCatalog>>;
  getCostBudgetAlertBinding(tenantId: string, budgetId: string, budgetRevision: number): Promise<AdminApiResult<CostBudgetAlertBinding>>;
  saveCostBudgetAlertBinding(body: CostBudgetAlertBindingWrite, idempotencyKey: string): Promise<AdminApiResult<CostBudgetAlertBinding>>;
  listCostAlerts(query: CostAlertListQuery): Promise<AdminApiResult<CostAlertList>>;
  getCostAdjustmentHistory(query: CostAdjustmentQuery): Promise<AdminApiResult<CostAdjustmentHistoryPage>>;
  createCostAdjustment(command: CostAdjustmentCommand, idempotencyKey: string): Promise<AdminApiResult<CostAdjustmentCommandResult>>;
  listCostAdjustmentEvidence(query: CostAdjustmentEvidenceQuery): Promise<AdminApiResult<CostAdjustmentEvidencePage>>;
  listTenantActiveConnectorRevisions(query: TenantActiveConnectorCatalogClientQuery): Promise<AdminApiResult<TenantActiveConnectorCatalogPage>>;
  listCostAlertRecipients(query: CostAlertRecipientCatalogQuery): Promise<AdminApiResult<CostAlertRecipientCatalog>>;
  ensureCostAlertSelfRecipient(): Promise<AdminApiResult<CostAlertRecipient>>;
  transitionCostAlertRecipient(principalId: string, body: CostAlertRecipientLifecycleWrite, idempotencyKey: string): Promise<AdminApiResult<CostAlertRecipientLifecycleResult>>;
  listCostAlertInbox(query: CostAlertInboxQuery): Promise<AdminApiResult<CostAlertInboxPage>>;
  markCostAlertInboxRead(alertId: string, tenantId: string): Promise<AdminApiResult<CostAlertInboxReadAck>>;
  getCostPrices(): Promise<AdminApiResult<CostControlPriceList>>;
  createCostPriceDraft(body: PriceDraftWrite, idempotencyKey: string): Promise<AdminApiResult<PersistedPriceRevision>>;
  transitionCostPrice(action: 'review' | 'publish' | 'retire', body: CostPolicyTransitionRequest, idempotencyKey: string): Promise<AdminApiResult<PersistedPriceRevision>>;
  rollbackCostPrice(body: CostPolicyRollbackRequest, idempotencyKey: string): Promise<AdminApiResult<PersistedPriceRevision>>;
  getGlobalSettings(tenantId?: string): Promise<AdminApiResult<TenantGlobalSettingsRead>>;
  getPlatformRetention(): Promise<AdminApiResult<PlatformRetentionRead>>;
  createTenantAiDraft(tenantId: string, body: TenantAiDraftRequest): Promise<AdminApiResult<TenantAiRevision | GlobalSettingsMutationResult>>;
  testTenantAiRevision(tenantId: string, body: TenantAiTestRequest): Promise<AdminApiResult<TenantAiTestResult>>;
  publishTenantAiRevision(tenantId: string, body: GlobalSettingsPublishRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  rollbackTenantAiRevision(tenantId: string, body: GlobalSettingsRollbackRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  createTenantPromptDraft(tenantId: string, body: TenantPromptDraftRequest): Promise<AdminApiResult<TenantPromptRevision | GlobalSettingsMutationResult>>;
  publishTenantPromptRevision(tenantId: string, body: GlobalSettingsPublishRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  rollbackTenantPromptRevision(tenantId: string, body: GlobalSettingsRollbackRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  createRetentionDraft(body: PlatformRetentionDraftRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  publishRetentionRevision(body: GlobalSettingsPublishRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  rollbackRetentionRevision(body: GlobalSettingsRollbackRequest): Promise<AdminApiResult<GlobalSettingsMutationResult>>;
  getHealth(): Promise<AdminApiResult<AdminHealthSnapshot>>;
  listTenants(query?: Record<string, string>): Promise<AdminApiResult<TenantPage>>;
  listAudit(query?: Record<string, string>): Promise<AdminApiResult<unknown>>;
  listApiKeys(query?: Record<string, string>): Promise<AdminApiResult<ApiKeyPage>>;
  getApiKey(keyId: string): Promise<AdminApiResult<ApiKeyPage>>;
  getConnectorRevision(
    connectorId: string,
    revision: string,
  ): Promise<AdminApiResult<ConnectorRevision>>;
  /**
   * CONNECTOR-WIRE-B reads. Both answer `unknown`: the list has two honest
   * shapes (real ledger / placeholder) and the reader in
   * `features/connectors/state.ts` is the only validator — typing them here
   * would assert a shape the browser has not checked.
   */
  listConnectors(): Promise<AdminApiResult<unknown>>;
  getConnectorCapabilities(): Promise<AdminApiResult<unknown>>;
  upsertConnector(
    params: ConnectorUpsertParams,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  activateConnector(
    params: ConnectorActivateParams,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  disableConnector(
    connectorId: string,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  retireConnector(
    target: ConnectorRevisionTarget,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  testConnector(connectorId: string, idempotencyKey?: string): Promise<AdminApiResult<PostActionResult>>;
  getProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
  ): Promise<AdminApiResult<ProfileDetail>>;
  listProfiles(query?: Record<string, string>): Promise<AdminApiResult<ProfileListPage>>;
  /** 0039: the key set this profile owns. */
  listProfileApiKeys(
    businessId: string,
    businessVersion: string,
    profileName: string,
  ): Promise<AdminApiResult<ProfileApiKeyPage>>;
  /** AWEB-14: workflow revisions owned by this profile's business/version. */
  listProfileWorkflows(
    businessId: string,
    businessVersion: string,
    profileName: string,
    tenantId: string,
  ): Promise<AdminApiResult<ProfileWorkflowPage>>;
  setProfileWorkflow(
    businessId: string,
    businessVersion: string,
    profileName: string,
    tenantId: string,
    body: { workflowSlug: string; workflowRevision: number; enabled: boolean },
    idempotencyKey?: string,
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  /** 0039: add a key to this profile, or rotate one it already has. */
  profileKeyAction(
    businessId: string,
    businessVersion: string,
    profileName: string,
    op: 'attach' | 'rotate',
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileKeyActionResult>>;
  upsertProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
    body: PolicyUpsertBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileMutationResult>>;
  publishProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
    body: ProfilePublishBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileMutationResult>>;
  rollbackProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
    body: ProfileRollbackBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileMutationResult>>;
  testProfileEndpoint(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  listAssignedProfileEndpoints(query?: ProfileSelfServiceAssignedQuery): Promise<AdminApiResult<ProfileSelfServiceAssignedPage>>;
  listAssignedProfileApiKeys(profileId: string, query?: ProfileSelfServiceAssignedApiKeyQuery): Promise<AdminApiResult<ProfileSelfServiceAssignedApiKeyPage>>;
  editAssignedProfile(body: Omit<ProfileSelfServiceEditRequest, 'tenantId' | 'businessId' | 'businessVersion' | 'profileName'> & { businessId: string; businessVersion: string; profileName: string }, idempotencyKey: string): Promise<AdminApiResult<ProfileSelfServiceEditResponse>>;
  previewWorkflowImport(body: import('./types').WorkflowImportPreviewRequest): Promise<AdminApiResult<import('./types').WorkflowImportPreviewResponse>>;
  submitAdminWorkbenchEndpointTest(body: AdminWorkbenchEndpointTestRequest, idempotencyKey: string): Promise<AdminApiResult<AdminWorkbenchOperationAccepted>>;
  runPromptWizard(body: AdminWorkbenchPromptWizardRequest, idempotencyKey: string): Promise<AdminApiResult<AdminWorkbenchOperationAccepted>>;
  getIdentitySnapshot(tenantId?: string): Promise<AdminApiResult<IdentitySnapshot>>;
  listIdentityUsers(query: Record<string, string>): Promise<AdminApiResult<IdentityUserPage>>;
  createIdentityUser(body: { username: string; password: string; role: 'ADMIN' | 'USER' | 'VIEWER' }, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ParityIdentityUserResponse>>;
  updateIdentityUser(userId: string, body: { role: 'ADMIN' | 'USER' | 'VIEWER'; enabled: boolean; expectedVersion: number }, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ParityIdentityUserResponse>>;
  resetIdentityPassword(userId: string, body: IdentityPasswordReset, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ParityIdentityUserResponse>>;
  getIdentityAssignments(userId: string, tenantId: string): Promise<AdminApiResult<IdentityAssignmentSet>>;
  replaceIdentityAssignments(userId: string, body: IdentityAssignmentReplace, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<IdentityAssignmentSet>>;
  searchAssignableIdentityUsers(query: Record<string, string>): Promise<AdminApiResult<IdentityAssignableUserPage>>;
  searchAssignablePlatformIdentityUsers(query?: Record<string, string>): Promise<AdminApiResult<IdentityAssignableUserPage>>;
  listApiKeyLifecycle(query: Record<string, string>): Promise<AdminApiResult<ApiKeyLifecyclePage>>;
  issueApiKey(body: Omit<ApiKeyIssue, 'idempotencyKey'>, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ApiKeyMutationResult>>;
  updateApiKeyNote(keyId: string, body: ApiKeyNote, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ApiKeyMutationResult>>;
  rotateApiKey(keyId: string, body: Omit<ApiKeyRotate, 'idempotencyKey'>, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ApiKeyMutationResult>>;
  revokeApiKey(keyId: string, expectedVersion: number, tenantId: string, idempotencyKey: string): Promise<AdminApiResult<ApiKeyMutationResult>>;
  getConnectorParityRevision(connectorId: string, revision: number, tenantId: string): Promise<AdminApiResult<ConnectorParityRevision>>;
  upsertConnectorDraft(connectorId: string, body: Omit<ConnectorDraftUpsert, 'idempotencyKey'>, idempotencyKey: string): Promise<AdminApiResult<ConnectorParityDraftResult>>;
  stageConnectorCredential(connectorId: string, body: Omit<ConnectorCredentialStage, 'idempotencyKey'>, idempotencyKey: string): Promise<AdminApiResult<ConnectorParityDraftResult>>;
  activateConnectorRevision(connectorId: string, revision: number, tenantId: string, expectedCurrentRevision: number, idempotencyKey: string): Promise<AdminApiResult<ConnectorParityActivationResult>>;
  rollbackConnectorRevision(connectorId: string, tenantId: string, sourceRevision: number, expectedHeadRevision: number, idempotencyKey: string): Promise<AdminApiResult<ConnectorParityDraftResult>>;
  testConnectorRevision(body: ProviderTestRequest): Promise<AdminApiResult<ProviderTestResult>>;
  listIncidents(query: IncidentListQuery): Promise<AdminApiResult<IncidentListPage>>;
  getIncident(incidentId: string): Promise<AdminApiResult<IncidentDetail>>;
  assignIncident(incidentId: string, body: IncidentAssignRequest): Promise<AdminApiResult<IncidentDetail>>;
  acknowledgeIncident(incidentId: string, body: IncidentAcknowledgeRequest): Promise<AdminApiResult<IncidentDetail>>;
  resolveIncident(incidentId: string, body: IncidentResolveRequest): Promise<AdminApiResult<IncidentDetail>>;
  listMaintenanceSuppressions(): Promise<AdminApiResult<MaintenanceSuppressionList>>;
  createMaintenanceSuppression(body: MaintenanceSuppressionCreate): Promise<AdminApiResult<MaintenanceSuppression>>;
  listOperations(query?: AdminOperationsQuery): Promise<AdminApiResult<OperationsPage>>;
  getOperationsMetrics?(query: Record<string, string>): Promise<AdminApiResult<unknown>>;
  operationAction(operationId: string, action: 'cancel' | 'retry', idempotencyKey: string): Promise<AdminApiResult<Record<string, unknown>>>;
  uploadWorkflowFile(tenantId: string, apiKeyId: string, file: File): Promise<AdminApiResult<{ artifactId: string; state: string; fileName: string; mimeType: string; sizeBytes: number }>>;
  getMigrationReadiness(tenantId: string): Promise<AdminApiResult<{ tenantId: string; runs: MigrationReadinessRun[] }>>;
  getSettings(query?: Record<string, string>): Promise<AdminApiResult<Record<string, unknown>>>;
  getOperationDeliveries(operationId: string): Promise<AdminApiResult<{ items: Array<{ deliveryId: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; nextAttemptAt: string | null; canRetry: boolean; disabledReason: string | null }> }>>;
  getOperation(operationId: string): Promise<AdminApiResult<OperationDetail>>;
  deleteOperation(operationId: string, idempotencyKey: string): Promise<AdminApiResult<{ success: boolean }>>;
  getUsage(query: Record<string, string>): Promise<AdminApiResult<UsageSummary>>;
  listUsageEvents(query: UsageEventQuery): Promise<AdminApiResult<AdminUsageEventPage>>;
  listBusinesses(query?: Record<string, string>): Promise<AdminApiResult<BusinessPage>>;
  getBusinessVersions(businessId: string): Promise<AdminApiResult<BusinessVersions>>;
  listWorkerInstances(query?: Record<string, string>): Promise<AdminApiResult<WorkerInstanceList>>;
  businessVersionAction(
    businessId: string,
    version: string,
    action: 'enable' | 'activate' | 'deactivate',
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  getCryptoConfig(tenantId?: string): Promise<AdminApiResult<Record<string, unknown>>>;
  updateCryptoConfig(
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  /** SC-03: catalog list; metadata only, never a value. */
  listSecrets(query?: SecretCatalogListQuery): Promise<AdminApiResult<SecretCatalogListPage>>;
  createSecret(
    body: SecretCatalogCreateBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<SecretCatalogEntryRead>>;
  rotateSecret(
    secretId: string,
    body: SecretCatalogRotateBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<SecretCatalogEntryRead>>;
  disableSecret(
    secretId: string,
    body: SecretCatalogDisableBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<SecretCatalogEntryRead>>;
  /** Safe probe: availability/error code only, never a value. */
  testSecret(secretId: string): Promise<AdminApiResult<SecretProbeResult>>;
  postAction(
    action: string,
    params: Record<string, unknown>,
    options?: ActionOptions,
  ): Promise<AdminApiResult<PostActionResult>>;
  listWorkflows(query?: Record<string, string>): Promise<AdminApiResult<WorkflowCatalogPage>>;
  getWorkflow(slug: string, query?: Record<string, string>): Promise<AdminApiResult<WorkflowDetailResponse>>;
  provisionWorkflow(
    params: {
      tenantId?: string;
      businessId?: string;
      businessVersion?: string;
      schema: unknown;
      approvedEgressOrigins?: string[];
      expectedRevision?: number | null;
    },
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  retireWorkflow(
    params: { tenantId?: string; slug: string; expectedRevision: number },
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
}

const TRANSPORT_PROBLEM: AdminApiProblem = {
  status: 0,
  code: 'TRANSPORT_ERROR',
  title: 'The admin API could not be reached.',
};

/** Payload-free notification that the same-origin admin session expired. */
export const ADMIN_AUTH_EXPIRED_EVENT = 'du-admin-auth-expired';

let browserAdminAuthExpired = false;
let browserAuthEpoch = 0;
let browserVerifiedSessionScope: string | null = null;

function sessionScopeFingerprint(session: AdminWebSession): string {
  // `displayName` and CSRF material are deliberately excluded: neither is a
  // stable principal key, and the CSRF token is secret-bearing state.
  return JSON.stringify({
    plane: session.plane,
    role: session.role,
    principal: { kind: session.principal.kind, tenantId: session.principal.tenantId },
    scope: session.scope === null ? null : { kind: session.scope.kind, tenantId: 'tenantId' in session.scope ? session.scope.tenantId : null },
  });
}

function markAdminAuthExpired(): void {
  if (typeof window === 'undefined' || browserAdminAuthExpired) return;
  browserAdminAuthExpired = true;
  browserAuthEpoch += 1;
  window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
}

function clearAdminAuthExpired(): void {
  if (typeof window !== 'undefined' && browserAdminAuthExpired) {
    browserAdminAuthExpired = false;
    browserAuthEpoch += 1;
  }
}

function authExpiredResult<T>(): AdminApiResult<T> {
  return {
    ok: false,
    status: 401,
    problem: { status: 401, code: 'UNAUTHENTICATED', title: 'The admin session has expired.' },
  };
}

export function createAdminApiClient(options: AdminApiClientOptions = {}): AdminApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basePath = options.basePath ?? '/admin/api';
  let csrfToken: string | null = null;
  let csrfEpoch = browserAuthEpoch;

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { query?: Record<string, string>; body?: unknown; rawBody?: File; csrf?: boolean; idempotencyKey?: string; authRecovery?: boolean },
  ): Promise<AdminApiResult<T>> {
    const requestEpoch = browserAuthEpoch;
    const authRecovery = init.authRecovery === true && method === 'GET' && path === '/session';
    if (typeof window !== 'undefined' && browserAdminAuthExpired && !authRecovery) return authExpiredResult<T>();
    if (csrfEpoch !== browserAuthEpoch) {
      csrfToken = null;
      csrfEpoch = browserAuthEpoch;
    }
    const url = basePath + path + buildQuery(init.query);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.rawBody) headers['content-type'] = init.rawBody.type || 'application/octet-stream';
    if (init.csrf === true) {
      if (csrfToken === null) {
        try {
          const sessionRes = await fetchImpl(basePath + '/session', {
            method: 'GET',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          });
          if (sessionRes.status === 401) {
            csrfToken = null;
            markAdminAuthExpired();
            csrfEpoch = browserAuthEpoch;
            return authExpiredResult<T>();
          }
          if (sessionRes.ok) {
            const sessionData = (await sessionRes.json().catch(() => null)) as { csrfToken?: string } | null;
            if (browserAuthEpoch !== requestEpoch || browserAdminAuthExpired) return authExpiredResult<T>();
            if (sessionData && typeof sessionData.csrfToken === 'string') {
              csrfToken = sessionData.csrfToken;
              csrfEpoch = browserAuthEpoch;
            }
          }
        } catch {
          // Transport error during session retrieval; proceed and let request fail-closed if needed
        }
      }
    // A 401 from another request may have arrived while CSRF was being loaded.
    // Never let a mutation cross that session boundary.
    if (typeof window !== 'undefined' && (browserAdminAuthExpired || browserAuthEpoch !== requestEpoch) && !authRecovery) {
      return authExpiredResult<T>();
    }
      if (csrfToken !== null) {
        headers['x-csrf-token'] = csrfToken;
      }
    }
    if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(init.rawBody ? { body: init.rawBody } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      if (typeof window !== 'undefined' && browserAuthEpoch !== requestEpoch) return authExpiredResult<T>();
      return { ok: false, status: 0, problem: TRANSPORT_PROBLEM };
    }

    if (typeof window !== 'undefined' && browserAuthEpoch !== requestEpoch) return authExpiredResult<T>();
    if (!response.ok) {
      if (response.status === 401) {
        csrfToken = null;
        markAdminAuthExpired();
        csrfEpoch = browserAuthEpoch;
      }
      const problem = await parseProblem(response);
      if (typeof window !== 'undefined' && browserAuthEpoch !== requestEpoch && response.status !== 401) {
        return authExpiredResult<T>();
      }
      return { ok: false, status: response.status, problem };
    }
    const data = (await response.json().catch(() => null)) as T | null;
    if (typeof window !== 'undefined' && browserAuthEpoch !== requestEpoch) return authExpiredResult<T>();
    if (data === null) {
      return {
        ok: false,
        status: response.status,
        problem: {
          status: 502,
          code: 'UNREADABLE_RESPONSE',
          title: 'The admin API returned an unreadable response.',
        },
      };
    }
    return { ok: true, status: response.status, data };
  }

  /**
   * POST /admin/api/actions — the one mutation wire. The BFF wraps a
   * successful upstream body in `{ data: … }`; unwrap it here so callers see
   * the action result directly (rawKey on issue, revision on connector.upsert).
   */
  async function runAction(
    action: string,
    params: Record<string, unknown>,
    actionOptions?: ActionOptions,
  ): Promise<AdminApiResult<PostActionResult>> {
    const body: Record<string, unknown> = { action, params };
    if (actionOptions?.expectedRevision !== undefined) {
      body.expectedRevision = actionOptions.expectedRevision;
    }
    const result = await request<{ data?: PostActionResult }>('POST', '/actions', {
      body,
      csrf: true,
      idempotencyKey: actionOptions?.idempotencyKey,
    });
    if (!result.ok) return result;
    const inner = result.data.data;
    return {
      ok: true,
      status: result.status,
      data:
        typeof inner === 'object' && inner !== null ? inner : (result.data as unknown as PostActionResult),
    };
  }

  return {
    getComposeCatalog() {
      return request<ComposeCatalog>('GET', '/compose/catalog', {});
    },
    createComposePreview(body) {
      return request<ComposePreview>('POST', '/compose/previews', { body, csrf: true });
    },
    submitComposeJob(body, idempotencyKey) {
      return request<ComposeJobSubmission>('POST', '/compose/jobs', { body, csrf: true, idempotencyKey });
    },
    listComposeJobs(query) {
      const params: Record<string, string> = {};
      if (query?.hostId !== undefined) params.hostId = query.hostId;
      if (query?.projectId !== undefined) params.projectId = query.projectId;
      if (query?.state !== undefined) params.state = query.state;
      if (query?.limit !== undefined) params.limit = String(query.limit);
      if (query?.cursor !== undefined) params.cursor = query.cursor;
      return request<ComposeJobPage>('GET', '/compose/jobs', { query: params });
    },
    getComposeJob(jobId) {
      return request<ComposeJob>('GET', `/compose/jobs/${encodeURIComponent(jobId)}`, {});
    },
    getServiceInventory(query) {
      return request<ServiceInventory>('GET', '/maintenance/services', { query });
    },
    getQueueInventory(query) {
      return request<QueueInventory>('GET', '/maintenance/queues', { query });
    },
    previewQueueAction(body) {
      return request<QueueActionPreview>('POST', '/maintenance/queue-actions/preview', { body, csrf: true });
    },
    executeQueueAction(body) {
      return request<QueueActionJob>('POST', '/maintenance/queue-actions', { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    getQueueActionJob(jobId) {
      return request<QueueActionJob>('GET', `/maintenance/queue-actions/${encodeURIComponent(jobId)}`, {});
    },
    previewMaintenance(body) {
      return request<MaintenancePreview>('POST', '/maintenance/previews', { body, csrf: true });
    },
    startMaintenanceJob(body) {
      return request<MaintenanceJob>('POST', '/maintenance/jobs', { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    getMaintenanceJob(jobId) {
      return request<MaintenanceJob>('GET', `/maintenance/jobs/${encodeURIComponent(jobId)}`, {});
    },
    previewReplicaRollout(body) {
      return request<ReplicaRolloutPreview>('POST', '/maintenance/rollouts/preview', { body, csrf: true });
    },
    executeReplicaRollout(body) {
      return request<ReplicaRolloutJob>('POST', '/maintenance/rollouts', { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    getReplicaRolloutJob(jobId) {
      return request<ReplicaRolloutJob>('GET', `/maintenance/rollouts/${encodeURIComponent(jobId)}`, {});
    },
    previewReplicaRollback(jobId, body) {
      return request<ReplicaRollbackPreview>('POST', `/maintenance/rollouts/${encodeURIComponent(jobId)}/rollback/preview`, { body, csrf: true });
    },
    executeReplicaRollback(jobId, body) {
      return request<ReplicaRolloutJob>('POST', `/maintenance/rollouts/${encodeURIComponent(jobId)}/rollback`, { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    getStorageGeneration() {
      return request<StorageGenerationRead>('GET', '/maintenance/storage-generations/current', {});
    },
    listStorageGenerations() {
      return request<StorageGenerationRead[]>('GET', '/maintenance/storage-generations', {});
    },
    stageStorageGeneration(body) {
      return request<StorageGenerationRead>('POST', '/maintenance/storage-generations/stage', { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    testStorageGeneration(generationId, body) {
      return request<StorageGenerationTestResult>('POST', `/maintenance/storage-generations/${encodeURIComponent(generationId)}/test`, { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    activateStorageGeneration(generationId, body) {
      return request<StorageGenerationMutationResult>('POST', `/maintenance/storage-generations/${encodeURIComponent(generationId)}/activate`, { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    rollbackStorageGeneration(generationId, body) {
      return request<StorageGenerationMutationResult>('POST', `/maintenance/storage-generations/${encodeURIComponent(generationId)}/rollback`, { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    listCostBudgets(tenantId) {
      return request<CostControlBudgetList>('GET', '/cost-control/budgets', { query: { tenantId } });
    },
    getCostBudget(tenantId, budgetId) {
      return request<CostControlBudgetDetail>('GET', `/cost-control/budgets/${encodeURIComponent(budgetId)}`, { query: { tenantId } });
    },
    createCostBudgetDraft(body, idempotencyKey) {
      return request<PersistedBudgetRevision>('POST', '/cost-control/budgets/draft', { body, csrf: true, idempotencyKey });
    },
    transitionCostBudget(budgetId, action, body, idempotencyKey) {
      return request<PersistedBudgetRevision>('POST', `/cost-control/budgets/${encodeURIComponent(budgetId)}/${action}`, { body, csrf: true, idempotencyKey });
    },
    rollbackCostBudget(budgetId, body, idempotencyKey) {
      return request<PersistedBudgetRevision>('POST', `/cost-control/budgets/${encodeURIComponent(budgetId)}/rollback`, { body, csrf: true, idempotencyKey });
    },
    listCostAlertChannels(tenantId) {
      return request<CostAlertChannelList>('GET', '/cost-alerts/channels', { query: { tenantId } });
    },
    getCostPolicyScopeCatalog(tenantId, query) {
      return request<CostPolicyScopeCatalog>('GET', '/cost-alerts/scope-catalog', { query: {
        tenantId,
        kind: query.kind,
        ...(query.q ? { q: query.q } : {}),
        ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}),
        ...(query.profileId ? { profileId: query.profileId } : {}),
      } });
    },
    getCostBudgetAlertBinding(tenantId, budgetId, budgetRevision) {
      return request<CostBudgetAlertBinding>('GET', `/cost-alerts/bindings/${encodeURIComponent(budgetId)}`, {
        query: { tenantId, budgetRevision: String(budgetRevision) },
      });
    },
    saveCostBudgetAlertBinding(body, idempotencyKey) {
      return request<CostBudgetAlertBinding>('PUT', '/cost-alerts/bindings', { body, csrf: true, idempotencyKey });
    },
    listCostAlerts(query) {
      const params: Record<string, string> = { tenantId: query.tenantId };
      if (query.limit !== undefined) params.limit = String(query.limit);
      if (query.cursor !== undefined) params.cursor = query.cursor;
      if (query.budgetId !== undefined) params.budgetId = query.budgetId;
      if (query.kind !== undefined) params.kind = query.kind;
      return request<CostAlertList>('GET', '/cost-alerts', { query: params });
    },
    getCostAdjustmentHistory(query) {
      const params: Record<string, string> = {
        tenantId: query.tenantId,
        rootEventId: query.rootEventId,
      };
      if (query.limit !== undefined) params.limit = String(query.limit);
      if (query.cursor !== undefined) params.cursor = query.cursor;
      return request<CostAdjustmentHistoryPage>('GET', '/cost-control/adjustments', { query: params });
    },
    createCostAdjustment(command, idempotencyKey) {
      return request<CostAdjustmentCommandResult>('POST', '/cost-control/adjustments', {
        body: command, csrf: true, idempotencyKey,
      });
    },
    listCostAdjustmentEvidence(query) {
      const params: Record<string, string> = { tenantId: query.tenantId };
      if (query.q !== undefined) params.q = query.q;
      if (query.limit !== undefined) params.limit = String(query.limit);
      if (query.cursor !== undefined) params.cursor = query.cursor;
      return request<CostAdjustmentEvidencePage>('GET', '/cost-control/adjustments/evidence', { query: params });
    },
    listTenantActiveConnectorRevisions(query) {
      const params: Record<string, string> = {};
      if (query.tenantId !== undefined) params.tenantId = query.tenantId;
      if (query.q !== undefined) params.q = query.q;
      if (query.limit !== undefined) params.limit = String(query.limit);
      if (query.cursor !== undefined) params.cursor = query.cursor;
      return request<TenantActiveConnectorCatalogPage>('GET', '/parity/tenant-connectors', { query: params });
    },
    listCostAlertRecipients(query) {
      return request<CostAlertRecipientCatalog>('GET', '/cost-alerts/recipients', { query: {
        ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      } });
    },
    ensureCostAlertSelfRecipient() {
      return request<CostAlertRecipient>('POST', '/cost-alerts/recipients/self', { body: {}, csrf: true });
    },
    transitionCostAlertRecipient(principalId, body, idempotencyKey) {
      return request<CostAlertRecipientLifecycleResult>('POST', `/cost-alerts/recipients/${encodeURIComponent(principalId)}/lifecycle`, { body, csrf: true, idempotencyKey });
    },
    listCostAlertInbox(query) {
      const params: Record<string, string> = { tenantId: query.tenantId };
      if (query.limit !== undefined) params.limit = String(query.limit);
      if (query.cursor !== undefined) params.cursor = query.cursor;
      if (query.unreadOnly !== undefined) params.unreadOnly = String(query.unreadOnly);
      return request<CostAlertInboxPage>('GET', '/cost-alerts/inbox', { query: params });
    },
    markCostAlertInboxRead(alertId, tenantId) {
      return request<CostAlertInboxReadAck>('POST', `/cost-alerts/inbox/${encodeURIComponent(alertId)}/read`, { body: { tenantId }, csrf: true });
    },
    getCostPrices() {
      return request<CostControlPriceList>('GET', '/cost-control/prices', {});
    },
    createCostPriceDraft(body, idempotencyKey) {
      return request<PersistedPriceRevision>('POST', '/cost-control/prices/draft', { body, csrf: true, idempotencyKey });
    },
    transitionCostPrice(action, body, idempotencyKey) {
      return request<PersistedPriceRevision>('POST', `/cost-control/prices/${action}`, { body, csrf: true, idempotencyKey });
    },
    rollbackCostPrice(body, idempotencyKey) {
      return request<PersistedPriceRevision>('POST', '/cost-control/prices/rollback', { body, csrf: true, idempotencyKey });
    },
    getGlobalSettings(tenantId) {
      return request<TenantGlobalSettingsRead>('GET', '/global-settings', {
        ...(tenantId ? { query: { tenantId } } : {}),
      });
    },
    getPlatformRetention() {
      return request<PlatformRetentionRead>('GET', '/global-settings/retention', {});
    },
    createTenantAiDraft(tenantId, body) {
      return request<TenantAiRevision | GlobalSettingsMutationResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/ai/draft`, { body, csrf: true });
    },
    testTenantAiRevision(tenantId, body) {
      return request<TenantAiTestResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/ai/test`, { body, csrf: true });
    },
    publishTenantAiRevision(tenantId, body) {
      return request<GlobalSettingsMutationResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/ai/publish`, { body, csrf: true });
    },
    rollbackTenantAiRevision(tenantId, body) {
      return request<GlobalSettingsMutationResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/ai/rollback`, { body, csrf: true });
    },
    createTenantPromptDraft(tenantId, body) {
      return request<TenantPromptRevision | GlobalSettingsMutationResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/prompts/draft`, { body, csrf: true });
    },
    publishTenantPromptRevision(tenantId, body) {
      return request<GlobalSettingsMutationResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/prompts/publish`, { body, csrf: true });
    },
    rollbackTenantPromptRevision(tenantId, body) {
      return request<GlobalSettingsMutationResult>('POST', `/global-settings/tenants/${encodeURIComponent(tenantId)}/prompts/rollback`, { body, csrf: true });
    },
    createRetentionDraft(body) {
      return request<GlobalSettingsMutationResult>('POST', '/global-settings/retention/draft', { body, csrf: true });
    },
    publishRetentionRevision(body) {
      return request<GlobalSettingsMutationResult>('POST', '/global-settings/retention/publish', { body, csrf: true });
    },
    rollbackRetentionRevision(body) {
      return request<GlobalSettingsMutationResult>('POST', '/global-settings/retention/rollback', { body, csrf: true });
    },
    async getSession(sessionOptions) {
      const result = await request<AdminWebSession>('GET', '/session', { authRecovery: sessionOptions?.recoverAuth === true });
      if (result.ok) {
        const fingerprint = sessionScopeFingerprint(result.data);
        if (browserVerifiedSessionScope !== null && browserVerifiedSessionScope !== fingerprint) {
          csrfToken = null;
          markAdminAuthExpired();
          csrfEpoch = browserAuthEpoch;
          return {
            ok: false,
            status: 409,
            problem: {
              status: 409,
              code: 'SESSION_CHANGED',
              title: 'The Admin role or tenant changed. Reload this page before continuing.',
            },
          };
        }
        browserVerifiedSessionScope = fingerprint;
        if (sessionOptions?.recoverAuth === true) clearAdminAuthExpired();
        csrfEpoch = browserAuthEpoch;
        csrfToken = result.data.csrfToken;
      }
      return result;
    },
    getHealth() {
      return request<AdminHealthSnapshot>('GET', '/health', {});
    },
    listTenants(query) {
      return request<TenantPage>('GET', '/tenants', { query });
    },
    listAudit(query) {
      return request<unknown>('GET', '/audit', { query });
    },
    listApiKeys(query) {
      return request<ApiKeyPage>('GET', '/api-keys', { query });
    },
    getApiKey(keyId) {
      return request<ApiKeyPage>('GET', `/api-keys/${encodeURIComponent(keyId)}`, {});
    },
    getConnectorRevision(connectorId, revision) {
      return request<ConnectorRevision>(
        'GET',
        `/connectors/${encodeURIComponent(connectorId)}/revisions/${encodeURIComponent(revision)}`,
        {},
      );
    },
    listConnectors() {
      return request<unknown>('GET', '/connectors', {});
    },
    getConnectorCapabilities() {
      // Static segment: the BFF matches it before `/connectors/:id/...`.
      return request<unknown>('GET', '/connectors/capabilities', {});
    },
    upsertConnector(params, idempotencyKey) {
      return runAction('connector.upsert', params as unknown as Record<string, unknown>, {
        idempotencyKey,
      });
    },
    activateConnector(params, idempotencyKey) {
      return runAction('connector.activate', params as unknown as Record<string, unknown>, {
        idempotencyKey,
      });
    },
    disableConnector(connectorId, idempotencyKey) {
      return runAction('connector.disable', { connectorId }, { idempotencyKey });
    },
    retireConnector(target, idempotencyKey) {
      const params = { connectorId: target.connectorId, revision: target.revision };
      return runAction('connector.retire', params, { idempotencyKey });
    },
    testConnector(connectorId, idempotencyKey) {
      return runAction('connector.test', { connectorId }, { idempotencyKey });
    },
    getProfile(businessId, businessVersion, profileName) {
      return request<ProfileDetail>(
        'GET',
        `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}`,
        {},
      );
    },
    listProfiles(query) {
      return request<ProfileListPage>('GET', '/profiles', { query });
    },
    // 0039: the key set a profile owns, and the two membership writes. Same
    // (business, version, name) address as the profile itself — the client
    // never carries a profile id.
    listProfileApiKeys(businessId, businessVersion, profileName) {
      return request<ProfileApiKeyPage>(
        'GET',
        `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/api-keys`,
        {},
      );
    },
    listProfileWorkflows(businessId, businessVersion, profileName, tenantId) {
      return request<ProfileWorkflowPage>(
        'GET',
        `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/workflows`,
        { query: { tenantId } },
      );
    },
    setProfileWorkflow(businessId, businessVersion, profileName, tenantId, body, idempotencyKey) {
      return request<Record<string, unknown>>(
        'POST',
        `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/workflows`,
        { query: { tenantId }, body, csrf: true, idempotencyKey },
      );
    },
    async profileKeyAction(businessId, businessVersion, profileName, op, body, idempotencyKey) {
      // NOT unwrapMutation: that helper is typed for the profile.* mutations
      // (revision in, profileId/revision out). A membership write answers a
      // different payload, so it unwraps the same envelope against its own type.
      const result = await request<{ data?: ProfileKeyActionResult }>(
        'POST',
        `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/api-keys/${op}`,
        { body, csrf: true, idempotencyKey },
      );
      if (!result.ok) return result;
      const inner = result.data.data;
      return {
        ok: true,
        status: result.status,
        data:
          typeof inner === 'object' && inner !== null
            ? inner
            : (result.data as unknown as ProfileKeyActionResult),
      };
    },
    async upsertProfile(businessId, businessVersion, profileName, body, idempotencyKey) {
      return unwrapMutation(
        await request<{ data?: ProfileMutationResult }>(
          'POST',
          `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/upsert`,
          { body, csrf: true, idempotencyKey },
        ),
      );
    },
    async publishProfile(businessId, businessVersion, profileName, body, idempotencyKey) {
      return unwrapMutation(
        await request<{ data?: ProfileMutationResult }>(
          'POST',
          `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/publish`,
          { body, csrf: true, idempotencyKey },
        ),
      );
    },
    async rollbackProfile(businessId, businessVersion, profileName, body, idempotencyKey) {
      return unwrapMutation(
        await request<{ data?: ProfileMutationResult }>(
          'POST',
          `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/rollback`,
          { body, csrf: true, idempotencyKey },
        ),
      );
    },
    async testProfileEndpoint(payload, idempotencyKey) {
      return request<Record<string, unknown>>('POST', '/profiles/test-endpoint', {
        body: payload,
        csrf: true,
        idempotencyKey,
      });
    },
    listAssignedProfileEndpoints(query) {
      const params: Record<string, string> = {};
      if (query?.query !== undefined) params.query = query.query;
      if (query?.cursor !== undefined) params.cursor = query.cursor;
      if (query?.limit !== undefined) params.limit = String(query.limit);
      return request<ProfileSelfServiceAssignedPage>('GET', '/profiles/assigned', { query: params });
    },
    listAssignedProfileApiKeys(profileId, query) {
      const params: Record<string, string> = {};
      if (query?.query !== undefined) params.query = query.query;
      if (query?.cursor !== undefined) params.cursor = query.cursor;
      if (query?.limit !== undefined) params.limit = String(query.limit);
      return request<ProfileSelfServiceAssignedApiKeyPage>('GET', `/profiles/assigned/${encodeURIComponent(profileId)}/api-keys`, { query: params });
    },
    editAssignedProfile(body, idempotencyKey) {
      const { businessId, businessVersion, profileName, ...patch } = body;
      return request<ProfileSelfServiceEditResponse>('PATCH', `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/self-service`, {
        body: patch, csrf: true, idempotencyKey,
      });
    },
    previewWorkflowImport(body) {
      return request<import('./types').WorkflowImportPreviewResponse>('POST', '/workflow-import/preview', { body, csrf: true });
    },
    submitAdminWorkbenchEndpointTest(body, idempotencyKey) {
      return request<AdminWorkbenchOperationAccepted>('POST', '/admin-workbench/test-endpoint', { body, csrf: true, idempotencyKey });
    },
    runPromptWizard(body, idempotencyKey) {
      return request<AdminWorkbenchOperationAccepted>('POST', '/admin-workbench/prompt-wizard', { body, csrf: true, idempotencyKey });
    },
    getIdentitySnapshot(tenantId) {
      return request<IdentitySnapshot>('GET', '/identity', { query: tenantId ? { tenantId } : {} });
    },
    listIdentityUsers(query) {
      return request<IdentityUserPage>('GET', '/identity/users', { query });
    },
    createIdentityUser(body, tenantId, idempotencyKey) {
      return request<ParityIdentityUserResponse>('POST', '/identity/users', { query: { tenantId }, body, csrf: true, idempotencyKey });
    },
    updateIdentityUser(userId, body, tenantId, idempotencyKey) {
      return request<ParityIdentityUserResponse>('PATCH', `/identity/users/${encodeURIComponent(userId)}`, { query: { tenantId }, body, csrf: true, idempotencyKey });
    },
    resetIdentityPassword(userId, body, tenantId, idempotencyKey) {
      return request<ParityIdentityUserResponse>('POST', `/identity/users/${encodeURIComponent(userId)}/password`, { query: { tenantId }, body, csrf: true, idempotencyKey });
    },
    getIdentityAssignments(userId, tenantId) {
      return request<IdentityAssignmentSet>('GET', `/identity/users/${encodeURIComponent(userId)}/assignments`, { query: { tenantId } });
    },
    replaceIdentityAssignments(userId, body, tenantId, idempotencyKey) {
      return request<IdentityAssignmentSet>('PUT', `/identity/users/${encodeURIComponent(userId)}/assignments`, { query: { tenantId }, body, csrf: true, idempotencyKey });
    },
    searchAssignableIdentityUsers(query) {
      return request<IdentityAssignableUserPage>('GET', '/identity/assignable-users', { query });
    },
    searchAssignablePlatformIdentityUsers(query) {
      return request<IdentityAssignableUserPage>('GET', '/identity/platform-assignable-users', { query });
    },
    listApiKeyLifecycle(query) {
      return request<ApiKeyLifecyclePage>('GET', '/parity/api-keys', { query });
    },
    issueApiKey(body, tenantId, idempotencyKey) {
      return request<ApiKeyMutationResult>('POST', '/parity/api-keys/issue', { query: { tenantId }, body: { ...body, idempotencyKey }, csrf: true, idempotencyKey });
    },
    updateApiKeyNote(keyId, body, tenantId, idempotencyKey) {
      return request<ApiKeyMutationResult>('PATCH', `/parity/api-keys/${encodeURIComponent(keyId)}`, { query: { tenantId }, body, csrf: true, idempotencyKey });
    },
    rotateApiKey(keyId, body, tenantId, idempotencyKey) {
      return request<ApiKeyMutationResult>('POST', `/parity/api-keys/${encodeURIComponent(keyId)}/rotate`, { query: { tenantId }, body: { ...body, idempotencyKey }, csrf: true, idempotencyKey });
    },
    revokeApiKey(keyId, expectedVersion, tenantId, idempotencyKey) {
      return request<ApiKeyMutationResult>('POST', `/parity/api-keys/${encodeURIComponent(keyId)}/revoke`, { query: { tenantId }, body: { expectedVersion }, csrf: true, idempotencyKey });
    },
    getConnectorParityRevision(connectorId, revision, tenantId) {
      return request<ConnectorParityRevision>('GET', `/parity/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}`, { query: { tenantId } });
    },
    upsertConnectorDraft(connectorId, body, idempotencyKey) {
      return request<ConnectorParityDraftResult>('PUT', `/parity/connectors/${encodeURIComponent(connectorId)}/draft`, { body: { ...body, idempotencyKey }, csrf: true, idempotencyKey });
    },
    stageConnectorCredential(connectorId, body, idempotencyKey) {
      return request<ConnectorParityDraftResult>('POST', `/parity/connectors/${encodeURIComponent(connectorId)}/credentials`, { body: { ...body, idempotencyKey }, csrf: true, idempotencyKey });
    },
    activateConnectorRevision(connectorId, revision, tenantId, expectedCurrentRevision, idempotencyKey) {
      return request<ConnectorParityActivationResult>('POST', `/parity/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}/activate`, { body: { tenantId, expectedCurrentRevision }, csrf: true, idempotencyKey });
    },
    rollbackConnectorRevision(connectorId, tenantId, sourceRevision, expectedHeadRevision, idempotencyKey) {
      return request<ConnectorParityDraftResult>('POST', `/parity/connectors/${encodeURIComponent(connectorId)}/rollback/draft`, { body: { tenantId, sourceRevision, expectedHeadRevision, idempotencyKey }, csrf: true, idempotencyKey });
    },
    testConnectorRevision(body) {
      return request<ProviderTestResult>('POST', '/parity/provider-tests', { body, csrf: true, idempotencyKey: body.idempotencyKey });
    },
    listIncidents(query) {
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params[key] = String(value);
      return request<IncidentListPage>('GET', '/incidents', { query: params });
    },
    getIncident(incidentId) {
      return request<IncidentDetail>('GET', `/incidents/${encodeURIComponent(incidentId)}`, {});
    },
    assignIncident(incidentId, body) {
      return request<IncidentDetail>('POST', `/incidents/${encodeURIComponent(incidentId)}/assign`, { body, csrf: true });
    },
    acknowledgeIncident(incidentId, body) {
      return request<IncidentDetail>('POST', `/incidents/${encodeURIComponent(incidentId)}/acknowledge`, { body, csrf: true });
    },
    resolveIncident(incidentId, body) {
      return request<IncidentDetail>('POST', `/incidents/${encodeURIComponent(incidentId)}/resolve`, { body, csrf: true });
    },
    listMaintenanceSuppressions() {
      return request<MaintenanceSuppressionList>('GET', '/incidents/maintenance-suppressions', {});
    },
    createMaintenanceSuppression(body) {
      return request<MaintenanceSuppression>('POST', '/incidents/maintenance-suppressions', { body, csrf: true });
    },
    listOperations(query) {
      return request<OperationsPage>('GET', '/operations', { query: query as Record<string, string> | undefined });
    },
    getOperationsMetrics(query) {
      return request<unknown>('GET', '/operations/metrics', { query });
    },
    operationAction(operationId, action, idempotencyKey) {
      return request<Record<string, unknown>>('POST', `/operations/${encodeURIComponent(operationId)}/${action}`, { body: {}, csrf: true, idempotencyKey });
    },
    uploadWorkflowFile(tenantId, apiKeyId, file) {
      return request('POST', '/operations/uploads', { query: { tenantId, apiKeyId, fileName: file.name }, rawBody: file, csrf: true });
    },
    getMigrationReadiness(tenantId) {
      return request('GET', '/legacy-migration/readiness', { query: { tenantId } });
    },
    getSettings(query) {
      return request<Record<string, unknown>>('GET', '/settings', { query });
    },
    getOperationDeliveries(operationId) { return request('GET', `/operations/${encodeURIComponent(operationId)}/deliveries`, {}); },
    getOperation(operationId) {
      return request<OperationDetail>('GET', `/operations/${encodeURIComponent(operationId)}`, {});
    },
    deleteOperation(operationId, idempotencyKey) {
      return request<{ success: boolean }>('DELETE', `/operations/${encodeURIComponent(operationId)}`, {
        csrf: true,
        idempotencyKey,
      });
    },
    getUsage(query) {
      return request<UsageSummary>('GET', '/usage', { query });
    },
    listUsageEvents(query) {
      const params: Record<string, string> = {
        tenantId: query.tenantId,
        from: query.from,
        to: query.to,
      };
      if (query.timeField !== undefined) params.timeField = query.timeField;
      if (query.limit !== undefined) params.limit = String(query.limit);
      if (query.cursor !== undefined) params.cursor = query.cursor;
      if (query.operationId !== undefined) params.operationId = query.operationId;
      if (query.provider !== undefined) params.provider = query.provider;
      if (query.model !== undefined) params.model = query.model;
      return request<AdminUsageEventPage>('GET', '/usage/events', { query: params });
    },
    listBusinesses(query) {
      return request<BusinessPage>('GET', '/businesses', { query });
    },
    getBusinessVersions(businessId) {
      return request<BusinessVersions>('GET', `/businesses/${encodeURIComponent(businessId)}/versions`, {});
    },
    listWorkerInstances(query) {
      return request<WorkerInstanceList>('GET', '/worker-instances', { query });
    },
    businessVersionAction(businessId, version, action) {
      return request<Record<string, unknown>>(
        'PUT',
        `/businesses/${encodeURIComponent(businessId)}/versions/${encodeURIComponent(version)}/${action}`,
        { csrf: true },
      );
    },
    getCryptoConfig(tenantId) {
      return request<Record<string, unknown>>('GET', '/crypto-config', {
        ...(tenantId !== undefined && tenantId.length > 0 ? { query: { tenantId } } : {}),
      });
    },
    async updateCryptoConfig(body, idempotencyKey) {
      return request<Record<string, unknown>>('POST', '/crypto-config', {
        body,
        csrf: true,
        idempotencyKey,
      });
    },
    listSecrets(query) {
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(query ?? {})) {
        if (typeof value === 'string' && value.length > 0) params[name] = value;
      }
      return request<SecretCatalogListPage>('GET', '/secrets', { query: params });
    },
    createSecret(body, idempotencyKey) {
      return request<SecretCatalogEntryRead>('POST', '/secrets', {
        body,
        csrf: true,
        idempotencyKey,
      });
    },
    rotateSecret(secretId, body, idempotencyKey) {
      return request<SecretCatalogEntryRead>(
        'POST',
        `/secrets/${encodeURIComponent(secretId)}/rotate`,
        { body, csrf: true, idempotencyKey },
      );
    },
    disableSecret(secretId, body, idempotencyKey) {
      return request<SecretCatalogEntryRead>(
        'POST',
        `/secrets/${encodeURIComponent(secretId)}/disable`,
        { body, csrf: true, idempotencyKey },
      );
    },
    testSecret(secretId) {
      return request<SecretProbeResult>(
        'POST',
        `/secrets/${encodeURIComponent(secretId)}/test`,
        { body: {}, csrf: true },
      );
    },
    postAction(action, params, actionOptions) {
      return runAction(action, params, actionOptions);
    },
    listWorkflows(query) {
      return request<WorkflowCatalogPage>('GET', '/workflows', { query });
    },
    getWorkflow(slug, query) {
      return request<WorkflowDetailResponse>('GET', `/workflows/${encodeURIComponent(slug)}`, { query });
    },
    provisionWorkflow(params, idempotencyKey) {
      return runAction('workflow.provision', params, { idempotencyKey });
    },
    retireWorkflow(params, idempotencyKey) {
      return runAction('workflow.retire', params, { idempotencyKey });
    },
  };
}

/** Unwrap the BFF `{ data: … }` envelope for profile mutations. */
function unwrapMutation(
  result: AdminApiResult<{ data?: ProfileMutationResult }>,
): AdminApiResult<ProfileMutationResult> {
  if (!result.ok) return result;
  const inner = result.data.data;
  return {
    ok: true,
    status: result.status,
    data: typeof inner === 'object' && inner !== null ? inner : (result.data as unknown as ProfileMutationResult),
  };
}

function buildQuery(query: Record<string, string> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value.length > 0) params.set(name, value);
  }
  const encoded = params.toString();
  return encoded.length > 0 ? '?' + encoded : '';
}

async function parseProblem(response: Response): Promise<AdminApiProblem> {
  const fallback: AdminApiProblem = {
    status: response.status,
    code: 'HTTP_' + response.status,
    title: 'The admin API rejected the request.',
  };
  const parsed = (await response.json().catch(() => null)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
  const candidate = parsed as Partial<AdminApiProblem>;
  const status = typeof candidate.status === 'number' ? candidate.status : response.status;
  return {
    ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
    ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.correlationId === 'string' ? { correlationId: candidate.correlationId } : {}),
    ...(Array.isArray(candidate.errors) ? { errors: candidate.errors } : {}),
    status,
  };
}

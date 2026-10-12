import type { ConnectorWorkflowOverrides, InvocationArtifactContent, InvocationArtifactPin, InvocationCostContext, ProviderReportedCost, UsageCostProvenance } from '@du/contracts';

export type AdapterMode = 'json' | 'multipart';

export type InvocationState =
  | 'NEW'
  | 'IN_FLIGHT'
  | 'PENDING'
  | 'POLLING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

export type ConnectorErrorCode =
  | 'INVALID_INPUT'
  | 'CAPABILITY_UNSUPPORTED'
  | 'GRANT_INVALID'
  | 'BINDING_DENIED'
  | 'CREDENTIAL_INVALID'
  | 'CONNECTOR_DISABLED'
  | 'PROVIDER_RATE_LIMITED'
  /** Provider answered 4xx: the request reached the provider and was rejected. Distinct from a 200 whose body does not match the contract. */
  | 'PROVIDER_REQUEST_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'INVOCATION_UNKNOWN'
  | 'INPUT_HASH_MISMATCH'
  | 'QUOTA_EXHAUSTED'
  | 'BUDGET_LIMIT_EXCEEDED'
  | 'CANCELLED';

export interface InvocationInput {
  prompt?: string;
  text?: string;
  task?: string;
  language?: string;
  artifacts?: readonly InvocationArtifactContent[];
  outputSchema?: unknown;
  parameters?: Readonly<Record<string, unknown>>;
}

export interface InvocationOptions {
  temperature?: number;
  model?: string;
  [key: string]: unknown;
}

export interface LocalInvocationRequest {
  contractVersion: '1';
  invocationId: string;
  tenantId: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: InvocationInput;
  options?: InvocationOptions;
  sessionRef?: string | null;
  deadlineAt: string;
  /** Trusted fields copied from the verified grant; never part of the provider payload. */
  connectorId?: string;
  connectorRevision?: number;
  /** Set only by the dedicated, verified admin provider-test path. */
  adminPurpose?: 'admin-provider-test';
  /** Deferred signed context is kept with the encrypted invocation for recovery. */
  costContext?: InvocationCostContext;
  /** Compiled workflow recipe is pinned separately from ordinary options. */
  workflowOverrides?: ConnectorWorkflowOverrides;
}

export interface GrantClaims {
  audience: 'connector';
  tenantId: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  invocationId: string;
  inputHash: string;
  connectorRevision: string;
  expiresAt: string;
  allowedModel?: string;
  artifactIds?: readonly string[];
  artifactPins?: readonly InvocationArtifactPin[];
  bindingSlot?: string;
  costContext?: InvocationCostContext;
  workflowOverridesDigest?: string;
}

export interface ProviderUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  pages?: number;
  costMicrousd?: number;
  costStatus?: 'measured' | 'estimated' | 'unpriced' | 'pending';
  costProvenance?: UsageCostProvenance;
  providerReportedCost?: ProviderReportedCost;
  measurement: 'measured' | 'estimated';
}

export interface NormalizedProviderResult {
  content?: string;
  data?: unknown;
  artifacts?: readonly { artifactId: string }[];
  sessionRef?: string | null;
  usage?: ProviderUsage;
  providerRequestId?: string;
  /** Provider response facts retained for source-bound test recovery. */
  providerStatusCode?: number;
  providerLatencyMs?: number;
  /** Internal marker set only after admin-test result content is redacted with
   * the resolved revision credential before it is persisted. */
  providerTestContentSanitized?: true;
  providerTestContentTruncated?: boolean;
}

export interface ProviderResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}

export interface ProviderRequest {
  url: string;
  method: 'POST' | 'GET' | 'PUT';
  headers: Readonly<Record<string, string>>;
  body: string | Uint8Array | FormData;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly mode: AdapterMode;
  /**
   * Async adapters replay the same POST with the same Idempotency-Key. The
   * provider MUST deduplicate that key and return the current state or terminal
   * result for a duplicate; distinct status URLs are not part of this contract.
   */
  readonly asyncPollingMode: 'idempotency-key-replay';
  buildRequest(request: LocalInvocationRequest, config: AdapterConfig): ProviderRequest;
  normalizeResponse(response: ProviderResponse, config: AdapterConfig): NormalizedProviderResult;
  classifyFailure(response: ProviderResponse | Error): ConnectorErrorCode;
}

export interface AdapterConfig {
  baseUrl: string;
  path: string;
  headers?: Readonly<Record<string, string>>;
  requestMapping?: Readonly<Record<string, string>>;
  responseMapping?: Readonly<Record<string, string>>;
  timeoutMs: number;
  capability?: string;
  /**
   * VAULT-05 (SEC-05): approved provider credential slot. undefined|'bearer'
   * = authorization: Bearer <secret> (historic default);
   * 'header:<Name>' = inject as that header instead. Never a secret itself.
   */
  credentialSlot?: string;
  /** Provider contract required before this HTTP endpoint may return 202. */
  asyncPollingMode?: 'idempotency-key-replay';
}

export interface InvocationRecord {
  request: LocalInvocationRequest;
  inputHash: string;
  state: InvocationState;
  result?: NormalizedProviderResult;
  errorCode?: ConnectorErrorCode;
  providerRequestId?: string;
  /**
   * CR06-04: provider-issued continuation session captured from an async 202
   * accept body. Persisted while the invocation is PENDING/POLLING so the
   * session survives the worker's pending-yield resume (the resume reuses the
   * stable invocationId and this record replays the session to the provider).
   * Never inferred or defaulted — absent means the provider offered none.
   */
  sessionRef?: string | null;
  nextPollAt?: string;
  providerPollAttempts?: number;
  pollLeaseToken?: string;
  pollLeaseExpiresAt?: string;
  quotaLease?: QuotaLease;
  updatedAt: string;
}

export interface InvocationLedger {
  get(invocationId: string): Promise<InvocationRecord | undefined>;
  claim(request: LocalInvocationRequest, inputHash: string): Promise<
    | { kind: 'claimed'; record: InvocationRecord }
    | { kind: 'replay'; record: InvocationRecord }
    | { kind: 'conflict'; record: InvocationRecord }
  >;
  claimPendingPoll(invocationId: string, inputHash: string, now: number, leaseMs: number): Promise<string | undefined>;
  /** Recheck the durable backup gate immediately before provider/poll transport. */
  activateEffect?(invocationId: string, pollLeaseToken?: string): Promise<boolean>;
  complete(
    invocationId: string,
    result: NormalizedProviderResult,
    pollLeaseToken?: string,
  ): Promise<InvocationRecord>;
  failPending(invocationId: string, inputHash: string, errorCode: ConnectorErrorCode): Promise<boolean>;
  fail(invocationId: string, errorCode: ConnectorErrorCode, pollLeaseToken?: string): Promise<InvocationRecord>;
  cancel(invocationId: string): Promise<InvocationRecord>;
  markUnknown(invocationId: string, pollLeaseToken?: string): Promise<InvocationRecord>;
  markPending(
    invocationId: string,
    nextPollAt: string,
    providerRequestId?: string,
    pollLeaseToken?: string,
    quotaLease?: QuotaLease,
    providerPollAttempt?: boolean,
    /**
     * CR06-04: continuation session offered by the provider in the 202 body.
     * Stored on the pending record; `undefined`/`null` keeps the existing
     * value (COALESCE semantics) so a later poll that omits it cannot erase
     * a session already captured.
     */
    sessionRef?: string | null,
  ): Promise<InvocationRecord>;
}

export interface QuotaLease {
  leaseId: string;
  key: string;
  expiresAt: number;
}

export interface QuotaStore {
  acquire(key: string, now: number, leaseMs: number, maxInFlight: number): Promise<QuotaLease | undefined>;
  renew(lease: QuotaLease, now: number, leaseMs: number): Promise<QuotaLease | undefined>;
  release(lease: QuotaLease): Promise<void>;
}

export interface ServiceIdentity {
  subject: string;
  scopes: readonly string[];
  audience: string;
}

export interface ServiceIdentityVerifier {
  verify(headers: Readonly<Record<string, string | undefined>>): Promise<ServiceIdentity>;
}

export interface CredentialGuard {
  isActive(): Promise<boolean>;
}

import type { InvocationArtifactContent, InvocationArtifactPin } from '@du/contracts';

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
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'INVOCATION_UNKNOWN'
  | 'INPUT_HASH_MISMATCH'
  | 'QUOTA_EXHAUSTED'
  | 'CANCELLED';

export interface InvocationInput {
  prompt?: string;
  text?: string;
  task?: string;
  language?: string;
  artifacts?: readonly InvocationArtifactContent[];
  outputSchema?: unknown;
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
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  pages?: number;
  costMicrousd?: number;
  measurement: 'measured' | 'estimated';
}

export interface NormalizedProviderResult {
  content?: string;
  data?: unknown;
  artifacts?: readonly { artifactId: string }[];
  sessionRef?: string | null;
  usage?: ProviderUsage;
  providerRequestId?: string;
}

export interface ProviderResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}

export interface ProviderRequest {
  url: string;
  method: 'POST' | 'GET';
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

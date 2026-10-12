import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { validateGrant, validateGrantClaims, type ProviderTestGrantVerifier } from './grants';
import { hashInvocationInput } from './hash';
import { abortInFlightProviderDispatch, invokeAdapter, type PreparedProviderDispatch, type ProviderTransport } from './invoke';
import { redactConnectorRevision } from './config';
import { ConnectorError } from './errors';
import type { ConnectorHttpStore, ConnectorRuntime, HttpInvocationResult } from './http/server';
import type { ConnectorConfigRepository, ConnectorRevision, NewConnectorRevision } from './db/repository';
import type { PostgresInvocationLedger } from './db/repository';
import type { PostgresUsageOutbox } from './db/usage-outbox';
import type { AdapterConfig, GrantClaims, InvocationRecord, LocalInvocationRequest, NormalizedProviderResult, ProviderAdapter, ProviderRequest, ProviderUsage, QuotaStore } from './types';
import { AdapterRegistry } from './adapters/registry';
import { applyCredentialSlot, parseCredentialSource, SecretResolver } from './vault/resolver';
import { deriveRevisionBinding, isBoundRevisionTenant, type RevisionScope } from './db/repository';
import { FetchProviderTransport } from './adapters/transport';
import { createTypedRecipeAdapter } from './adapters/recipe';
import type { PostgresConnectorParityRepository, ConnectorParityStoredRevision } from './db/parity-repository';
import { parseContractInvocationRequest, parseProviderTestInvocationRequest, parseProviderTestResult } from './contracts';
import {
  calculateOperationCost,
  OperationUsageMetricsSchema,
  PricingUnpricedUnitError,
  type CostPreflightResponse,
  type InvocationCostContext,
  type UsageCostProvenance,
} from '@du/contracts';
import {
  buildCostBoundProof,
  usageCostProvenance,
  type ConnectorCostControlClient,
} from './cost-control-client';
import { appendUsageEvent } from './usage';
import {
  type ConnectorProviderTestEvidence,
  type ConnectorProviderTestEvidenceQuery,
  type ConnectorSignalSnapshot,
  type ConnectorSignalSnapshotQuery,
  ConnectorRevisionBindingSchema,
  matchesVaultRevisionBinding,
  type ConnectorRevisionBinding,
  type InvocationRequest,
  type ProviderTestGrantClaims,
  type ProviderTestResult,
} from '@du/contracts';
import { assertArtifactGrantBindings } from './artifact-content';

const SENSITIVE_CONFIG_KEY = /(?:secret|password|passwd|token|credential|authorization|api[_-]?key|cookie|session)/i;
const PROVIDER_TEST_CONTENT_MAX = 16_384;

function collectSensitiveValues(
  secret: string | undefined,
  config: unknown,
  providerHeaders: Readonly<Record<string, string>>,
): { values: string[]; complete: boolean } {
  const values = new Set<string>();
  let complete = secret === undefined || (secret.length > 0 && secret.length <= 16_384);
  if (secret !== undefined && complete) values.add(secret);
  const headerEntries = Object.entries(providerHeaders);
  if (headerEntries.length > 64) complete = false;
  for (const [name, value] of headerEntries.slice(0, 64)) {
    if (name.length > 256 || typeof value !== 'string' || value.length > 4_096) {
      complete = false;
    } else if (value.length > 0) {
      // Scrub every actual outbound header value, including custom/static
      // values whose header name does not look credential-related.
      values.add(value);
    }
  }
  let visited = 0;
  const visit = (value: unknown, key = '', depth = 0): void => {
    if (depth > 8 || visited > 512) { complete = false; return; }
    visited += 1;
    if (typeof value === 'string') {
      if (SENSITIVE_CONFIG_KEY.test(key)) {
        if (value.length < 4 || value.length > 4_096) complete = false;
        else values.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 128)) visit(item, key, depth + 1);
      if (value.length > 128) complete = false;
      return;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 128) complete = false;
      for (const [childKey, childValue] of entries.slice(0, 128)) visit(childValue, childKey, depth + 1);
    }
  };
  visit(config);
  return { values: [...values].sort((a, b) => b.length - a.length), complete };
}

export function sanitizeProviderTestResult(
  result: NormalizedProviderResult,
  secret: string | undefined,
  revisionConfig: unknown,
  providerHeaders: Readonly<Record<string, string>> = {},
): NormalizedProviderResult {
  const content = typeof result.content === 'string' ? result.content : undefined;
  const collected = collectSensitiveValues(secret, revisionConfig, providerHeaders);
  if (!collected.complete || content === undefined) {
    return {
      ...result,
      content: undefined,
      providerTestContentSanitized: true,
      providerTestContentTruncated: content !== undefined,
    };
  }
  let safeContent = content;
  for (const value of collected.values) {
    safeContent = safeContent.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
  }
  const truncated = safeContent.length > PROVIDER_TEST_CONTENT_MAX;
  return {
    ...result,
    content: safeContent.slice(0, PROVIDER_TEST_CONTENT_MAX),
    providerTestContentSanitized: true,
    providerTestContentTruncated: truncated,
  };
}

export interface CredentialCipher {
  encrypt(secret: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

export class AesCredentialCipher implements CredentialCipher {
  public constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('Connector credential key must be 32 bytes.');
  }

  public encrypt(secret: string): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  public decrypt(value: Uint8Array): string {
    const bytes = Buffer.from(value);
    if (bytes.length < 28) throw new ConnectorError('CREDENTIAL_INVALID', 'Stored credential is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    try {
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Stored credential is invalid.');
    }
  }
}

export class DurableConnectorRuntime implements ConnectorRuntime {
  public constructor(
    private readonly ledger: PostgresInvocationLedger,
    private readonly repository: ConnectorConfigRepository,
    private readonly quota: QuotaStore,
    private readonly outbox: PostgresUsageOutbox,
    private readonly registry: AdapterRegistry,
    private readonly transport: ProviderTransport,
    private readonly cipher: CredentialCipher,
    private readonly grantVerifier: { verify(token: string): Promise<import('./types').GrantClaims> },
    /** VAULT-05: optional seam; absent = vault-backed revisions fail closed. */
    private readonly secretResolver?: SecretResolver,
    private readonly providerTestGrantVerifier?: ProviderTestGrantVerifier,
    /** Typed tenant-owned recipe chains take precedence over legacy revisions. */
    private readonly parityRepository?: PostgresConnectorParityRepository,
    /** Authenticated Orchestrator preflight and reservation-group transitions. */
    private readonly costControl?: ConnectorCostControlClient,
  ) {}

  public async invoke(body: unknown): Promise<HttpInvocationResult> {
    const request = parseContractInvocationRequest(body);
    let unsignedClaims: GrantClaims;
    try {
      unsignedClaims = await this.grantVerifier.verify(request.grant);
    } catch {
      throw new ConnectorError('GRANT_INVALID', 'Invocation grant is invalid.');
    }
    const local = toLocalRequest(request, unsignedClaims.tenantId);
    const claims = await validateGrant(request.grant, local, hashInvocationInput(local), {
      verify: async () => unsignedClaims,
    });
    local.costContext = claims.costContext;
    const { connectorId, revisionNumber } = parseConnectorRevision(claims.connectorRevision);
    local.connectorId = connectorId;
    local.connectorRevision = revisionNumber;
    assertCostControlBinding(local.costContext, this.costControl, request.grant);
    return this.executeInvocation(local, connectorId, revisionNumber, false, undefined, request.grant);
  }

  public async testExactRevision(body: unknown): Promise<ProviderTestResult> {
    const request = parseProviderTestInvocationRequest(body);
    if (!this.providerTestGrantVerifier) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider-test grant verification is not configured.');
    }
    let claims: ProviderTestGrantClaims;
    try {
      claims = await this.providerTestGrantVerifier.verify(request.grant);
    } catch {
      throw new ConnectorError('GRANT_INVALID', 'Provider-test grant is invalid.');
    }
    const now = Date.now();
    const deadlineAt = Date.parse(request.deadlineAt);
    if (claims.exp * 1000 <= now || claims.iat * 1000 > now + 60_000 || !Number.isFinite(deadlineAt) || deadlineAt <= now || deadlineAt > claims.exp * 1000) {
      throw new ConnectorError('GRANT_INVALID', 'Provider-test grant is expired or has an invalid deadline.');
    }
    const local: LocalInvocationRequest = {
      contractVersion: '1',
      invocationId: claims.invocationId,
      tenantId: claims.tenantId,
      operationId: claims.operationId,
      taskId: claims.taskId,
      stepKey: `admin-provider-test:${claims.endpointSlug}`,
      bindingSlot: claims.bindingSlot,
      input: request.input,
      ...(claims.allowedModel === undefined ? {} : { options: { model: claims.allowedModel } }),
      deadlineAt: request.deadlineAt,
      connectorId: claims.connectorId,
      connectorRevision: claims.connectorRevision,
      adminPurpose: 'admin-provider-test',
      costContext: claims.costContext,
    };
    assertCostControlBinding(local.costContext, this.costControl, request.grant);
    const hashClaims = {
      audience: 'connector' as const,
      tenantId: claims.tenantId,
      operationId: claims.operationId,
      taskId: claims.taskId,
      stepKey: local.stepKey,
      invocationId: claims.invocationId,
      inputHash: claims.inputHash,
      connectorRevision: `${claims.connectorId}:${claims.connectorRevision}`,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      allowedModel: claims.allowedModel,
      artifactIds: claims.artifactIds,
      artifactPins: claims.artifactPins,
    };
    validateGrantClaims(hashClaims, local, hashInvocationInput(local), now);
    assertArtifactGrantBindings(request.input.artifacts, claims.artifactIds, claims.artifactPins);

    const startedAt = Date.now();
    let invocation: InvocationRecord | undefined;
    try {
      const outcome = await this.executeInvocation(
        local,
        claims.connectorId,
        claims.connectorRevision,
        true,
        claims.revisionState,
        request.grant,
      );
      invocation = await this.ledger.get(claims.invocationId);
      if (outcome.state === 'completed' && invocation?.state === 'SUCCEEDED') {
        return this.toProviderTestResult(invocation, await this.getProviderTestEvidence({
          tenantId: claims.tenantId,
          operationId: claims.operationId,
          taskId: claims.taskId,
          invocationId: claims.invocationId,
          connectorId: claims.connectorId,
          revision: claims.connectorRevision,
        }), startedAt);
      }
      invocation ??= await this.ledger.get(claims.invocationId);
      if (invocation && this.isExactProviderTestRecord(invocation, claims)) {
        return this.toProviderTestResult(invocation, await this.getProviderTestEvidence({
          tenantId: claims.tenantId,
          operationId: claims.operationId,
          taskId: claims.taskId,
          invocationId: claims.invocationId,
          connectorId: claims.connectorId,
          revision: claims.connectorRevision,
        }), startedAt);
      }
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Provider-test result has no matching durable source record.');
    } catch (error) {
      invocation ??= await this.ledger.get(claims.invocationId);
      if (!invocation || !this.isExactProviderTestRecord(invocation, claims)) throw error;
      return this.toProviderTestResult(invocation, await this.getProviderTestEvidence({
        tenantId: claims.tenantId,
        operationId: claims.operationId,
        taskId: claims.taskId,
        invocationId: claims.invocationId,
        connectorId: claims.connectorId,
        revision: claims.connectorRevision,
      }), startedAt);
    }
  }

  private async executeInvocation(
    local: LocalInvocationRequest,
    connectorId: string,
    revisionNumber: number,
    allowPendingRevision: boolean,
    expectedRevisionState?: 'PENDING' | 'ACTIVE',
    invocationGrant?: string,
  ): Promise<HttpInvocationResult> {
    let adapter: ProviderAdapter;
    let config: AdapterConfig;
    let quotaKey: string;
    let secret: string | undefined;
    let providerHeaders: Readonly<Record<string, string>>;
    let sanitizerConfig: unknown;
    let credentialIsActive: () => Promise<boolean>;

    const hasTypedChain = this.parityRepository
      ? await this.parityRepository.hasTypedChain(local.tenantId, connectorId)
      : false;
    if (allowPendingRevision && !hasTypedChain) {
      throw new ConnectorError('BINDING_DENIED', 'Provider-test recipe revision binding is invalid.');
    }
    if (hasTypedChain) {
      const typedRevision = await this.parityRepository!.getRevision(local.tenantId, connectorId, revisionNumber);
      if (!typedRevision || typedRevision.connectorId !== connectorId || typedRevision.revision !== revisionNumber
        || typedRevision.tenantId.toLowerCase() !== local.tenantId.toLowerCase()) {
        // A typed chain never falls back to a generic revision with the same
        // connector ID/revision number.
        throw new ConnectorError('BINDING_DENIED', 'Typed Connector recipe revision binding is invalid.');
      }
      validateTypedRevisionState(typedRevision, allowPendingRevision, expectedRevisionState);
      if (local.workflowOverrides
        && (local.workflowOverrides.connectorId !== connectorId
          || local.workflowOverrides.connectorRevision !== revisionNumber)) {
        throw new ConnectorError('BINDING_DENIED', 'Workflow recipe override does not match the selected Connector revision.');
      }
      secret = await this.resolveTypedCredential(typedRevision);
      const built = createTypedRecipeAdapter(typedRevision.recipe, secret, local.workflowOverrides);
      adapter = built.adapter;
      providerHeaders = built.providerHeaders;
      sanitizerConfig = typedRevision.recipe;
      const endpoint = new URL(typedRevision.recipe.endpointUrl);
      config = {
        baseUrl: endpoint.origin,
        path: `${endpoint.pathname}${endpoint.search}`,
        timeoutMs: typedRevision.recipe.timeoutMs,
        capability: typedRevision.recipe.adapter,
      };
      quotaKey = typedRevision.credentialRef ?? `typed:${local.tenantId}:${connectorId}:${revisionNumber}`;
      // SecretResolver already checked the exact immutable Vault version. The
      // legacy pending replay path likewise does not switch credential pins.
      credentialIsActive = async () => true;
    } else {
      // W-VAULT01-BIND-1R: the tenant_id predicate is part of the row lookup,
      // so a foreign tenant's revision never leaves the database.
      const revision = await this.repository.getRevision(connectorId, revisionNumber, { tenantId: local.tenantId });
      if (!revision || revision.connectorId !== connectorId || revision.revision !== revisionNumber) {
        throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
      }
      if (isBoundRevisionTenant(revision.tenantId) && revision.tenantId !== local.tenantId) {
        throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
      }
      if (allowPendingRevision) {
        if ((revision.state !== 'PENDING' && revision.state !== 'ACTIVE') || revision.state !== expectedRevisionState) {
          throw new ConnectorError('CONNECTOR_DISABLED', 'Provider-test revision state no longer matches its signed grant.');
        }
      } else if (revision.state !== 'ACTIVE') {
        throw new ConnectorError('CONNECTOR_DISABLED', 'Connector revision is not active.');
      }
      const source = parseCredentialSource(revision.credentialSource);
      if (source.kind === 'vault-kv2') {
        if (!matchesVaultRevisionBinding(source, {
          tenantId: revision.tenantId,
          connectorId: revision.connectorId,
          accountId: revision.accountId,
        })) {
          throw new ConnectorError('BINDING_DENIED', 'Vault credential does not match the trusted revision binding.');
        }
        if (!this.secretResolver) {
          throw new ConnectorError('CREDENTIAL_INVALID', 'Vault-backed revision requires a configured SecretResolver.');
        }
        secret = (await this.secretResolver.resolve(source)).value;
      } else {
        if (isBoundRevisionTenant(revision.tenantId)) {
          throw new ConnectorError('CREDENTIAL_INVALID', 'Legacy-db credential on a tenant-bound revision is invalid.');
        }
        const credential = await this.repository.getActiveCredential(source.credentialRef, { tenantId: local.tenantId });
        if (!credential) throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential is not active.');
        secret = this.cipher.decrypt(credential);
      }
      adapter = this.registry.get(revision.adapter);
      config = applyCredentialSlot(revision.config, secret);
      quotaKey = revision.credentialRef;
      providerHeaders = config.headers ?? {};
      sanitizerConfig = revision.config;
      credentialIsActive = async () => source.kind === 'vault-kv2'
        || Boolean(await this.repository.getActiveCredential(source.credentialRef, { tenantId: local.tenantId }));
    }
    const outcome = await invokeAdapter(local, {
      ledger: this.ledger,
      quota: this.quota,
      adapter,
      config,
      transport: this.transport,
      // credentialRef identifies the shared provider account; tenant IDs must not
      // create separate maxInFlight buckets for the same provider credential.
      quotaKey,
      providerTimeoutMs: config.timeoutMs,
      credential: { isActive: credentialIsActive },
      ...(local.costContext === undefined ? {} : {
        prepareProviderDispatch: (providerRequest, retryCount) => this.prepareCostBoundDispatch(
          local,
          invocationGrant,
          providerRequest,
          retryCount,
        ),
      }),
      ...(local.adminPurpose === 'admin-provider-test'
        ? { sanitizeResult: (result: NormalizedProviderResult) => sanitizeProviderTestResult(result, secret, sanitizerConfig, providerHeaders) }
        : {}),
    });
    if (outcome.state === 'completed') {
      const event = outcome.result.usage
        ? local.costContext
          ? appendUsageEvent(local.invocationId, local.costContext.attempt, outcome.result.usage, {
            operationId: local.operationId,
            taskId: local.taskId,
          })
          : { eventId: `${local.invocationId}:1`, invocationId: local.invocationId, operationId: local.operationId, taskId: local.taskId, usage: outcome.result.usage, createdAt: new Date().toISOString() }
        : undefined;
      if (event) await this.outbox.append(event);
      return {
        invocationId: local.invocationId,
        state: 'completed',
        result: outcome.result as Record<string, unknown>,
        // CR06-04: the result carries the invocation session (provider's
        // result-side value, or the pending 202 value it did not echo back).
        sessionRef: outcome.result.sessionRef,
      };
    }
    return {
      invocationId: local.invocationId,
      state: 'pending',
      nextPollAt: outcome.nextPollAt,
      providerRequestId: outcome.providerRequestId,
      sessionRef: outcome.sessionRef,
    };
  }

  private async resolveTypedCredential(revision: ConnectorParityStoredRevision): Promise<string | undefined> {
    const source = revision.credentialSource;
    if (revision.recipe.auth.kind === 'none') {
      if (source !== null || revision.credentialRef !== null) {
        throw new ConnectorError('CREDENTIAL_INVALID', 'Typed recipe credential pin does not match its authentication mode.');
      }
      return undefined;
    }
    if (revision.recipe.auth.kind === 'oauth2-client-credentials') {
      throw new ConnectorError('CAPABILITY_UNSUPPORTED', 'OAuth credential acquisition is not supported by the typed recipe runtime.');
    }
    if (!source || !revision.credentialRef || revision.credentialVersion === null
      || source.kind !== 'vault-kv2' || source.version !== revision.credentialVersion
      || !matchesVaultRevisionBinding(source, {
        tenantId: revision.tenantId,
        connectorId: revision.connectorId,
        accountId: 'recipe',
      })) {
      throw new ConnectorError('BINDING_DENIED', 'Typed recipe credential does not match the immutable tenant pin.');
    }
    if (!this.secretResolver) throw new ConnectorError('CREDENTIAL_INVALID', 'Typed recipe requires a configured SecretResolver.');
    return (await this.secretResolver.resolve(source)).value;
  }

  private async prepareCostBoundDispatch(
    local: LocalInvocationRequest,
    grant: string | undefined,
    providerRequest: ProviderRequest,
    retryCount: number,
  ): Promise<PreparedProviderDispatch> {
    const context = local.costContext;
    const control = this.costControl;
    if (!context || !grant || !control || !local.connectorId || !local.connectorRevision) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Cost-control preflight is required before provider dispatch.');
    }
    const proof = buildCostBoundProof({
      providerRequest,
      request: local,
      connectorId: local.connectorId,
      connectorRevision: local.connectorRevision,
      retryCount,
    });
    const command = {
      grant,
      reservationGroupId: context.budgetReservationGroupId,
      operationId: local.operationId,
      taskId: local.taskId,
      invocationId: local.invocationId,
      attempt: context.attempt,
    };
    const releaseConfirmedNoSend = async (reasonCode: string): Promise<void> => {
      try {
        await control.transition({
          ...command,
          target: 'RELEASED',
          reasonCode,
          confirmedNotSent: true,
        });
      } catch {
        // No provider request has been sent. If this acknowledgement is lost,
        // the hold remains conservatively fenced for reconciliation.
      }
    };

    let selection: CostPreflightResponse;
    try {
      selection = await control.preflight(grant, proof);
    } catch (error) {
      // A preflight response can be lost after its transaction committed. The
      // signed group ID is stable, so an affirmative no-send release safely
      // clears a RESERVED group; 404/BLOCKED/replayed-terminal results are
      // harmlessly left to their durable state.
      await releaseConfirmedNoSend('COST_PREFLIGHT_UNACKNOWLEDGED');
      throw error;
    }
    if (selection.selection.reservationGroupId !== context.budgetReservationGroupId) {
      await releaseConfirmedNoSend('COST_GROUP_MISMATCH');
      throw new ConnectorError('BINDING_DENIED', 'Cost preflight did not match the signed reservation group.');
    }
    if (selection.decision === 'BLOCKED') {
      throw new ConnectorError('BUDGET_LIMIT_EXCEEDED', 'A published cost policy blocked this provider invocation.');
    }

    try {
      await control.transition({ ...command, target: 'RUNNING' });
    } catch (error) {
      // The transport is strictly after this acknowledgement. Even if the
      // RUNNING write committed but its response was lost, the local proof is
      // definitive: no provider bytes have been sent, so release is allowed.
      await releaseConfirmedNoSend('COST_RUNNING_UNACKNOWLEDGED');
      throw error;
    }

    return {
      request: providerRequest,
      markUnknown: async (reasonCode) => {
        const boundedReason = /^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)
          ? reasonCode
          : 'PROVIDER_OUTCOME_AMBIGUOUS';
        try {
          await control.transition({ ...command, target: 'UNKNOWN', reasonCode: boundedReason });
        } catch {
          // A failed/lost transition acknowledgement never makes an ambiguous
          // provider outcome safe to replay; the ledger remains UNKNOWN too.
        }
      },
      completeResult: (result) => attachCostUsage(result, {
        local,
        context,
        selection,
        proof,
      }),
    };
  }

  private isExactProviderTestRecord(record: InvocationRecord, claims: ProviderTestGrantClaims): boolean {
    return record.request.adminPurpose === 'admin-provider-test'
      && record.request.tenantId === claims.tenantId
      && record.request.operationId === claims.operationId
      && record.request.taskId === claims.taskId
      && record.request.invocationId === claims.invocationId
      && record.request.connectorId === claims.connectorId
      && record.request.connectorRevision === claims.connectorRevision
      && record.inputHash === claims.inputHash;
  }

  private toProviderTestResult(
    record: InvocationRecord,
    evidence: ConnectorProviderTestEvidence | undefined,
    startedAt: number,
  ): ProviderTestResult {
    const state: ProviderTestResult['state'] = record.state === 'SUCCEEDED' && record.result
      ? 'SUCCEEDED'
      : record.state === 'FAILED' || record.state === 'CANCELLED'
        ? 'FAILED'
        : 'UNKNOWN';
    const content = record.result?.providerTestContentSanitized === true && typeof record.result.content === 'string'
      ? record.result.content
      : null;
    return parseProviderTestResult({
      invocationId: record.request.invocationId,
      state,
      statusCode: Number.isInteger(record.result?.providerStatusCode) ? record.result!.providerStatusCode : null,
      content: content === null ? null : content.slice(0, 16_384),
      ...(record.result?.providerTestContentSanitized === true ? { contentSanitized: true as const } : {}),
      contentTruncated: record.result?.providerTestContentTruncated === true || (content !== null && content.length > 16_384),
      latencyMs: Number.isSafeInteger(record.result?.providerLatencyMs) && (record.result?.providerLatencyMs ?? -1) >= 0
        ? record.result!.providerLatencyMs
        : Math.max(0, Date.now() - startedAt),
      inputTokens: Number.isSafeInteger(record.result?.usage?.inputTokens) ? record.result!.usage!.inputTokens! : null,
      outputTokens: Number.isSafeInteger(record.result?.usage?.outputTokens) ? record.result!.usage!.outputTokens! : null,
      usageEventId: evidence?.usageEvent?.eventId ?? null,
      errorCode: state === 'SUCCEEDED' ? null : record.errorCode ?? 'INVOCATION_UNKNOWN',
    });
  }

  public async get(invocationId: string, invocationGrant?: string): Promise<HttpInvocationResult | undefined> {
    const record = await this.ledger.get(invocationId);
    if (!record) return undefined;
    await this.authorizeInvocation(record, invocationGrant);
    return toHttpResult(record);
  }

  public async getProviderTestEvidence(
    query: ConnectorProviderTestEvidenceQuery,
  ): Promise<ConnectorProviderTestEvidence | undefined> {
    return this.ledger.getProviderTestEvidence(query);
  }

  public async getSignalSnapshot(query: ConnectorSignalSnapshotQuery): Promise<ConnectorSignalSnapshot> {
    return this.ledger.getSignalSnapshot(query);
  }

  public async cancel(invocationId: string, _reason: string, invocationGrant?: string): Promise<HttpInvocationResult> {
    const record = await this.ledger.get(invocationId);
    if (!record) throw new ConnectorError('INVALID_INPUT', 'Invocation not found.');
    await this.authorizeInvocation(record, invocationGrant);
    const cancelled = await this.ledger.cancel(invocationId);
    // WFA-T7 layer 3: reach the provider socket. Flipping the ledger row alone
    // leaves the outbound provider request running until its own deadline.
    abortInFlightProviderDispatch(invocationId);
    if (record.quotaLease) {
      try {
        await this.quota.release(record.quotaLease);
      } catch {
        // The lease has a deadline-bounded Redis expiry; a failed eager release
        // cannot leave capacity reserved indefinitely.
      }
    }
    return toHttpResult(cancelled);
  }

  private async authorizeInvocation(record: InvocationRecord, invocationGrant?: string): Promise<void> {
    if (!invocationGrant) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant is required to read or cancel this invocation.');
    }
    await validateGrant(invocationGrant, record.request, record.inputHash, this.grantVerifier);
  }
}

export class DurableConnectorManagement implements ConnectorHttpStore {
  public constructor(
    private readonly repository: ConnectorConfigRepository,
    private readonly cipher: CredentialCipher,
    private readonly registry: AdapterRegistry,
    private readonly secretResolver?: SecretResolver,
  ) {}

  public async list(): Promise<ConnectorRevision[]> {
    return (await this.repository.list()).map(redactConnectorRevision);
  }

  public async get(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    const revision = await this.repository.get(connectorId, scope);
    return revision ? redactConnectorRevision(revision) : undefined;
  }

  public async createRevision(input: NewConnectorRevision): Promise<ConnectorRevision> {
    this.registry.get(input.adapter);
    if (!Number.isFinite(input.config.timeoutMs) || input.config.timeoutMs <= 0) {
      throw new ConnectorError('INVALID_INPUT', 'Connector timeout must be positive.');
    }
    const credentialSource = parseCredentialSource(input.credentialSource ?? {
      kind: 'legacy-db',
      credentialRef: input.credentialRef,
    });
    if (credentialSource.kind === 'vault-kv2') {
      if (!matchesVaultRevisionBinding(credentialSource, {
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        accountId: input.accountId,
      })) {
        throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
      }
    }
    if (credentialSource.kind === 'legacy-db' && credentialSource.credentialRef !== input.credentialRef) {
      throw new ConnectorError('INVALID_INPUT', 'Legacy credential source does not match credentialRef.');
    }
    return this.repository.createRevision({ ...input, credentialSource });
  }

  /** VAULT-06: clone CURRENT's adapter/config/credentialRef into a new PENDING. */
  public async createPendingRevision(
    connectorId: string,
    credentialSource: unknown,
    binding: ConnectorRevisionBinding,
  ): Promise<ConnectorRevision> {
    const source = parseCredentialSource(credentialSource);
    if (source.kind !== 'vault-kv2') {
      throw new ConnectorError('INVALID_INPUT', 'createPendingRevision requires a vault-kv2 credential source.');
    }
    const parsedBinding = ConnectorRevisionBindingSchema.safeParse(binding);
    if (!parsedBinding.success
      || parsedBinding.data.connectorId !== connectorId
      || !matchesVaultRevisionBinding(source, parsedBinding.data)) {
      throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
    }
    // Scope comes from the trusted writer context; it is never inferred from
    // the ref path. The ref is checked against this independent binding.
    const current = await this.repository.getActiveRevision(connectorId, { tenantId: parsedBinding.data.tenantId });
    if (!current) throw new ConnectorError('INVALID_INPUT', 'Connector has no ACTIVE revision to extend.');
    if (current.accountId !== parsedBinding.data.accountId) {
      throw new ConnectorError('BINDING_DENIED', 'Connector account binding cannot change within a revision chain.');
    }
    this.registry.get(current.adapter);
    return this.repository.createRevision({
      connectorId,
      adapter: current.adapter,
      config: current.config,
      credentialRef: current.credentialRef,
      state: 'PENDING',
      tenantId: parsedBinding.data.tenantId,
      accountId: parsedBinding.data.accountId,
      credentialSource: source,
    });
  }

  /**
   * W-VAULT-LEGACY-TRANSITION-1: open the tenant-bound chain for a connector
   * whose CURRENT is still the unbound legacy-db revision. The transition
   * key facts mirror migration 008 instead of fighting it: the shared legacy
   * credential_ref can never join a bound chain, so bootstrap derives a
   * fresh chain key and clones adapter/config from the validated legacy row.
   * The storage layer re-checks the legacy precondition inside the write
   * transaction; a replay against an already-open identical pin returns the
   * existing ACTIVE row.
   */
  public async bootstrapRevision(
    connectorId: string,
    credentialSource: unknown,
    binding: ConnectorRevisionBinding,
  ): Promise<{ revision: ConnectorRevision; replayed: boolean }> {
    const source = parseCredentialSource(credentialSource);
    if (source.kind !== 'vault-kv2') {
      throw new ConnectorError('INVALID_INPUT', 'bootstrapRevision requires a vault-kv2 credential source.');
    }
    const parsedBinding = ConnectorRevisionBindingSchema.safeParse(binding);
    if (!parsedBinding.success
      || parsedBinding.data.connectorId !== connectorId
      || !matchesVaultRevisionBinding(source, parsedBinding.data)) {
      throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
    }
    const legacy = await this.repository.get(connectorId, {});
    if (!legacy) {
      throw new ConnectorError('INVALID_INPUT', 'Connector has no unbound legacy revision to transition.');
    }
    if (legacy.credentialSource.kind !== 'legacy-db') {
      throw new ConnectorError('INVALID_INPUT', 'The unbound revision is not legacy-db.');
    }
    const credentialRef = 'cred-' + connectorId + '-' + parsedBinding.data.accountId;
    if (credentialRef === legacy.credentialRef) {
      throw new ConnectorError('INVALID_INPUT', 'The derived credential_ref collides with the shared legacy ref.');
    }
    this.registry.get(legacy.adapter);
    return this.repository.bootstrapVaultRevision({
      connectorId,
      adapter: legacy.adapter,
      config: legacy.config,
      credentialRef,
      credentialSource: source,
      tenantId: parsedBinding.data.tenantId,
      accountId: parsedBinding.data.accountId,
    });
  }

  public async getCurrentRevision(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    return redacted(this.repository.getActiveRevision(connectorId, scope));
  }

  public async getRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    return redacted(this.repository.getRevision(connectorId, revision, scope));
  }

  public async activateRevision(
    connectorId: string,
    revision: number,
    expectedCurrentRevision: number,
    scope?: RevisionScope,
  ): Promise<boolean> {
    return this.repository.activateRevision(connectorId, revision, expectedCurrentRevision, scope);
  }

  public async retireRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<void> {
    await this.repository.retireRevision(connectorId, revision, scope);
  }

  public async rotateCredential(connectorId: string, secret: string, scope?: RevisionScope): Promise<void> {
    const revision = await this.repository.get(connectorId, scope);
    if (!revision) throw new ConnectorError('INVALID_INPUT', 'Connector does not exist.');
    await this.repository.put(revision.credentialRef, this.cipher.encrypt(secret));
  }

  public async disable(connectorId: string, scope?: RevisionScope): Promise<void> {
    await this.repository.disable(connectorId, scope);
  }

  public async test(connectorId: string, scope?: RevisionScope): Promise<{ ok: boolean; errorCode?: string }> {
    const revision = await this.repository.get(connectorId, scope);
    if (!revision || revision.state !== 'ACTIVE') return { ok: false, errorCode: 'CONNECTOR_DISABLED' };
    this.registry.get(revision.adapter);
    // VAULT-05 (SEC-05): test must verify the secret ref AND a real read —
    // an ACTIVE adapter row alone is not proof the credential works.
    let source: ReturnType<typeof parseCredentialSource>;
    try {
      source = parseCredentialSource(revision.credentialSource);
    } catch (err) {
      return { ok: false, errorCode: err instanceof ConnectorError ? err.code : 'CREDENTIAL_INVALID' };
    }
    if (source.kind === 'vault-kv2') {
      if (!matchesVaultRevisionBinding(source, {
        tenantId: revision.tenantId,
        connectorId,
        accountId: revision.accountId,
      })) {
        return { ok: false, errorCode: 'BINDING_DENIED' };
      }
      if (!this.secretResolver) return { ok: false, errorCode: 'CREDENTIAL_INVALID' };
      return this.secretResolver.probe(source);
    }
    const active = await this.repository.getActiveCredential(source.credentialRef, scope);
    return active ? { ok: true } : { ok: false, errorCode: 'CREDENTIAL_INVALID' };
  }
}

function validateTypedRevisionState(
  revision: ConnectorParityStoredRevision,
  allowPendingRevision: boolean,
  expectedRevisionState?: 'PENDING' | 'ACTIVE',
): void {
  if (allowPendingRevision) {
    if ((revision.state !== 'PENDING' && revision.state !== 'ACTIVE') || revision.state !== expectedRevisionState) {
      throw new ConnectorError('CONNECTOR_DISABLED', 'Provider-test revision state no longer matches its signed grant.');
    }
  } else if (revision.state !== 'ACTIVE' && revision.state !== 'RETIRED') {
    // A normal grant is already bound to this exact immutable operation pin.
    // Retiring a revision closes future bindings in Orchestrator while its
    // accepted operations retain the credential/recipe history they pinned.
    throw new ConnectorError('CONNECTOR_DISABLED', 'Typed Connector recipe revision is not active.');
  }
}

async function redacted(
  promise: Promise<ConnectorRevision | undefined>,
): Promise<ConnectorRevision | undefined> {
  const revision = await promise;
  return revision ? redactConnectorRevision(revision) : undefined;
}

function toLocalRequest(request: InvocationRequest, tenantId: string): LocalInvocationRequest {
  const { grant: _grant, ...local } = request;
  return { ...local, tenantId };
}

function assertCostControlBinding(
  context: InvocationCostContext | undefined,
  client: ConnectorCostControlClient | undefined,
  grant: string,
): void {
  if (context && !client) {
    throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Signed cost context requires configured cost-control preflight.');
  }
  if (client && !context) {
    throw new ConnectorError('GRANT_INVALID', 'Cost-controlled Connector requires a signed invocation cost context.');
  }
  if (context && grant.length === 0) {
    throw new ConnectorError('GRANT_INVALID', 'Signed invocation cost context has no grant token.');
  }
}

function attachCostUsage(
  result: NormalizedProviderResult,
  input: {
    local: LocalInvocationRequest;
    context: InvocationCostContext;
    selection: CostPreflightResponse;
    proof: ReturnType<typeof buildCostBoundProof>;
  },
): NormalizedProviderResult {
  const { local, context, selection, proof } = input;
  const tier = selection.selection.pricingTier;
  const latency = Number.isSafeInteger(result.providerLatencyMs) && (result.providerLatencyMs ?? -1) >= 0
    ? result.providerLatencyMs!
    : 0;
  // Provider identity comes from the exact rendered outbound request, never
  // from response usage fields. A response can supply token counts, but it
  // cannot choose a different model, rate, cost status, or signed attribution.
  const actualProvider = proof.provider;
  const actualModel = proof.model;
  const units = parseReportedUsage(result.usage);
  const providerReportedCost = parseProviderReportedCost(result.usage);
  const usageIsKnown = units !== undefined;
  let costMicrousd = 0;
  let costStatus: NonNullable<ProviderUsage['costStatus']>;

  // Provider response bodies are not an authoritative billing source. The
  // adapter may expose provider JSON under usage, so raw costMicrousd or
  // costStatus fields must never override the immutable rate snapshot selected
  // by Orchestrator preflight.
  if (!usageIsKnown) {
    // Do not treat an absent usage object as measured zero. The durable event
    // carries pending/unpriced and zero amount until source evidence arrives.
    costStatus = tier ? 'pending' : 'unpriced';
  } else if (!tier || tier.modelId !== actualModel || (tier.provider !== undefined && tier.provider !== actualProvider)) {
    costStatus = 'unpriced';
  } else {
    try {
      const inputTokens = units.inputTokens;
      const outputTokens = units.outputTokens;
      if (!Number.isSafeInteger(inputTokens + outputTokens)) throw new RangeError('usage token sum is not a safe integer');
      const metrics = OperationUsageMetricsSchema.parse({
        operationId: local.operationId,
        inputTokens,
        outputTokens,
        cachedInputTokens: units.cachedInputTokens ?? 0,
        totalTokens: inputTokens + outputTokens,
        ...(units.pages === undefined ? {} : { pages: units.pages }),
        costMicrousd: 0,
        costStatus: 'estimated',
        durationMs: latency,
      });
      costMicrousd = calculateOperationCost(metrics, tier);
      costStatus = 'estimated';
    } catch (error) {
      costStatus = error instanceof PricingUnpricedUnitError ? 'unpriced' : 'pending';
    }
  }

  const costProvenance: UsageCostProvenance = usageCostProvenance({
    context,
    selection,
    proof,
    tenantId: local.tenantId,
    stepKey: local.stepKey,
    connectorId: local.connectorId!,
    connectorRevision: local.connectorRevision!,
    durationMs: latency,
  });
  return {
    ...result,
    usage: {
      inputTokens: usageIsKnown ? units.inputTokens : 0,
      outputTokens: usageIsKnown ? units.outputTokens : 0,
      ...(usageIsKnown && units.cachedInputTokens !== undefined ? { cachedInputTokens: units.cachedInputTokens } : {}),
      ...(usageIsKnown && units.pages !== undefined ? { pages: units.pages } : {}),
      provider: actualProvider,
      model: actualModel,
      costMicrousd,
      costStatus,
      measurement: usageIsKnown ? 'measured' : 'estimated',
      costProvenance,
      ...(providerReportedCost === undefined ? {} : { providerReportedCost }),
    },
  };
}

function parseProviderReportedCost(value: unknown): ProviderUsage['providerReportedCost'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const amount = (value as Record<string, unknown>).costMicrousd;
  if (!safeUsageCount(amount)) return undefined;
  // The amount is explicitly an unverified provider-response diagnostic. It
  // is never fed to pricing, preflight, reservation, or settlement.
  return { costMicrousd: amount, currency: 'USD', source: 'provider-response', status: 'unverified' };
}

interface ReportedUsageUnits {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  pages?: number;
}

/**
 * Keep only provider-reported unit counts that are safe to use in integer
 * billing. The Connector accepts its canonical names and OpenAI's documented
 * usage names, because the built-in JSON adapter preserves that `usage`
 * object. Unknown, partial, fractional, unsafe, or contradictory counts stay
 * pending instead of being coerced or rounded into a settlement.
 */
function parseReportedUsage(value: unknown): ReportedUsageUnits | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);
  const canonicalPresent = owns('inputTokens') || owns('outputTokens') || owns('cachedInputTokens') || owns('pages');
  const openAiCountsPresent = owns('prompt_tokens') || owns('completion_tokens');
  if (!canonicalPresent && !openAiCountsPresent) return undefined;

  const canonicalInput = raw.inputTokens;
  const canonicalOutput = raw.outputTokens;
  if (canonicalPresent && (!safeUsageCount(canonicalInput) || !safeUsageCount(canonicalOutput))) return undefined;

  const openAiInput = raw.prompt_tokens;
  const openAiOutput = raw.completion_tokens;
  if (openAiCountsPresent && (!safeUsageCount(openAiInput) || !safeUsageCount(openAiOutput))) return undefined;

  const inputTokens = canonicalPresent ? canonicalInput as number : openAiInput as number;
  const outputTokens = canonicalPresent ? canonicalOutput as number : openAiOutput as number;
  if (canonicalPresent && openAiCountsPresent
    && (canonicalInput !== openAiInput || canonicalOutput !== openAiOutput)) return undefined;
  const total = inputTokens + outputTokens;
  if (!Number.isSafeInteger(total)) return undefined;

  let cachedInputTokens: number | undefined;
  if (owns('cachedInputTokens')) {
    if (!safeUsageCount(raw.cachedInputTokens)) return undefined;
    cachedInputTokens = raw.cachedInputTokens;
  }
  if (owns('prompt_tokens_details')) {
    const details = raw.prompt_tokens_details;
    if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined;
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (cached !== undefined) {
      if (!safeUsageCount(cached) || (cachedInputTokens !== undefined && cachedInputTokens !== cached)) return undefined;
      cachedInputTokens = cached;
    }
  }
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) return undefined;

  for (const key of ['totalTokens', 'total_tokens']) {
    if (owns(key) && (!safeUsageCount(raw[key]) || raw[key] !== total)) return undefined;
  }
  const pages = raw.pages;
  if (pages !== undefined && !safeUsageCount(pages)) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(pages === undefined ? {} : { pages: pages as number }),
  };
}

function safeUsageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseConnectorRevision(value: string): { connectorId: string; revisionNumber: number } {
  const parts = value.split(':');
  if (parts.length !== 2 || !parts[0] || !/^[1-9]\d*$/.test(parts[1] ?? '')) {
    throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
  }
  const revisionNumber = Number(parts[1]);
  if (!Number.isSafeInteger(revisionNumber)) {
    throw new ConnectorError('BINDING_DENIED', 'Invocation grant connector revision binding is invalid.');
  }
  return { connectorId: parts[0], revisionNumber };
}

function toHttpResult(record: import('./types').InvocationRecord): HttpInvocationResult {
  const state = record.state === 'SUCCEEDED'
    ? 'completed'
    : record.state === 'PENDING' || record.state === 'POLLING'
      ? 'pending'
      : record.state === 'UNKNOWN' || record.state === 'IN_FLIGHT'
        ? 'unknown'
        : record.state === 'CANCELLED'
          ? 'cancelled'
          : 'failed';
  const errorCode = record.errorCode
    ?? (record.state === 'IN_FLIGHT' || record.state === 'UNKNOWN' ? 'INVOCATION_UNKNOWN' : undefined);
  return {
    invocationId: record.request.invocationId,
    state,
    result: record.result as Record<string, unknown> | undefined,
    providerRequestId: record.providerRequestId,
    error: errorCode ? { code: errorCode, message: 'Invocation did not complete.' } : undefined,
    nextPollAt: record.nextPollAt,
    // CR06-04: pending records expose the provider-issued session; completed
    // records expose the result-side session (which already falls back to the
    // pending one inside invokeAdapter).
    sessionRef: record.sessionRef ?? record.result?.sessionRef,
  };
}

import { createHash } from 'node:crypto';
import {
  COST_BOUND_CAPABILITIES,
  CostPreflightResponseSchema,
  CostReservationGroupAckSchema,
  CostReservationGroupTransitionSchema,
  type CostBoundProof,
  type CostPreflightResponse,
  type CostReservationGroupTransition,
  type InvocationCostContext,
  type ModelPricingTier,
  type UsageCostProvenance,
} from '@du/contracts';
import { ConnectorError } from './errors';
import type { LocalInvocationRequest, ProviderRequest } from './types';

const COST_PATH = '/api/internal/cost-control/reservations';
const REQUEST_TIMEOUT_MS = 5_000;

export interface ConnectorCostControlClient {
  preflight(grant: string, proof: CostBoundProof): Promise<CostPreflightResponse>;
  transition(command: Omit<CostReservationGroupTransition, 'grant'> & { grant: string }): Promise<void>;
}

/** Connector-to-Orchestrator caller using its dedicated cost-control bearer. */
export class HttpConnectorCostControlClient implements ConnectorCostControlClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;

  public constructor(baseUrl: string, private readonly token: string, fetcher: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password
        || this.baseUrl.search || this.baseUrl.hash || !token || token.length < 32 || token.length > 512) {
      throw new Error('Cost-control Connector client configuration is invalid.');
    }
    this.fetcher = fetcher;
  }

  public async preflight(grant: string, proof: CostBoundProof): Promise<CostPreflightResponse> {
    const body = { grant, proof };
    const response = await this.post(`${COST_PATH}/preflight`, body);
    if (response.status === 422) {
      const code = await responseCode(response);
      if (code === 'BUDGET_BOUND_UNSUPPORTED') {
        throw new ConnectorError('CAPABILITY_UNSUPPORTED', 'Published block policy has no verified bound for this request.');
      }
      throw new ConnectorError('INVALID_INPUT', 'Cost preflight rejected the request.');
    }
    if (!response.ok) throw upstreamUnavailable();
    let value: unknown;
    try { value = await response.json(); } catch { throw upstreamUnavailable(); }
    const parsed = CostPreflightResponseSchema.safeParse(value);
    if (!parsed.success) throw upstreamUnavailable();
    return parsed.data;
  }

  public async transition(command: Omit<CostReservationGroupTransition, 'grant'> & { grant: string }): Promise<void> {
    const parsed = CostReservationGroupTransitionSchema.safeParse(command);
    if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Cost transition is invalid.');
    const response = await this.post(`${COST_PATH}/transitions`, parsed.data);
    if (!response.ok) throw upstreamUnavailable();
    let value: unknown;
    try { value = await response.json(); } catch { throw upstreamUnavailable(); }
    const ack = CostReservationGroupAckSchema.safeParse(value);
    if (!ack.success || ack.data.reservationGroupId !== command.reservationGroupId || ack.data.state !== command.target) {
      throw upstreamUnavailable();
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const url = new URL(this.baseUrl.toString());
    const prefix = url.pathname.replace(/\/+$/, '');
    url.pathname = `${prefix}${path}`;
    const serialized = JSON.stringify(body);
    // Both cost calls are idempotent on the signed reservationGroupId and
    // canonical proof/transition body. A single identical retry recovers a
    // lost response without creating a second reservation or transition.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
          },
          body: serialized,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status < 500 || attempt === 1) return response;
        await response.body?.cancel().catch(() => {});
      } catch {
        if (attempt === 1) throw upstreamUnavailable();
      }
    }
    throw upstreamUnavailable();
  }
}

export function buildCostBoundProof(input: {
  providerRequest: ProviderRequest;
  request: LocalInvocationRequest;
  connectorId: string;
  connectorRevision: number;
  retryCount: number;
}): CostBoundProof {
  const { providerRequest, request } = input;
  const endpoint = safeUrl(providerRequest.url);
  const body = parseJsonBody(providerRequest.body);
  const model = typeof body?.model === 'string' ? safeIdentifier(body.model) : 'unknown';
  const capability = endpoint && body && providerRequest.method === 'POST'
    ? COST_BOUND_CAPABILITIES.find((candidate) => candidate.origin === endpoint.origin
      && candidate.path === endpoint.pathname && endpoint.search === '')
    : undefined;
  // Exact code-owned provider/model snapshots use the canonical provider ID
  // from the capability catalogue even when some other proof dimension (for
  // example, an artifact) makes the request unbounded. For every other target
  // the actual host remains the provider identity used for pricing lookup.
  const providerCapability = capability?.model === model ? capability : undefined;
  const provider = safeIdentifier(providerCapability?.provider ?? endpoint?.hostname ?? 'unknown');
  const outputField = capability?.outputLimitField;
  const rawOutputLimit = outputField && body ? body[outputField] : undefined;
  const outputLimit = Number.isSafeInteger(rawOutputLimit) && Number(rawOutputLimit) > 0
    ? Number(rawOutputLimit)
    : null;
  const boundCapability = capability
    && capability.model === model
    && outputLimit !== null
    && outputLimit <= capability.maxOutputTokens
    ? capability
    : undefined;
  const recognized = boundCapability !== undefined;
  const contentType = header(providerRequest, 'content-type');
  const artifacts = request.input.artifacts ?? [];
  const hasSession = request.sessionRef !== undefined && request.sessionRef !== null;
  const hasTools = Boolean(body && ['tools', 'tool_choice', 'functions', 'function_call'].some((key) => Object.hasOwn(body, key)));
  const hasUnknownUnits = !recognized
    || providerRequest.method !== 'POST'
    || contentType?.toLowerCase().split(';')[0]?.trim() !== 'application/json'
    || !isSupportedTextChatBody(body, boundCapability?.outputLimitField)
    || artifacts.length > 0
    || hasSession
    || hasTools
    || input.retryCount !== 0;
  const safeBody = typeof providerRequest.body === 'string' ? providerRequest.body : null;
  const digestInput = {
    method: providerRequest.method,
    origin: endpoint?.origin ?? null,
    path: endpoint?.pathname ?? null,
    body: safeBody,
  };
  const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')}`;
  return {
    version: 'cost-bound-v1',
    capabilityId: recognized ? boundCapability!.capabilityId : null,
    connectorId: input.connectorId,
    connectorRevision: input.connectorRevision,
    provider,
    model,
    requestDigest,
    inputUpperBoundTokens: recognized ? boundCapability!.inputContextTokens : null,
    outputLimit: recognized ? outputLimit! : null,
    outputLimitField: recognized ? boundCapability!.outputLimitField : null,
    artifactCount: artifacts.length,
    hasSession,
    hasTools,
    hasUnknownUnits,
    retryCount: input.retryCount,
  };
}

export function usageCostProvenance(input: {
  context: InvocationCostContext;
  selection: CostPreflightResponse;
  proof: CostBoundProof;
  tenantId: string;
  stepKey: string;
  connectorId: string;
  connectorRevision: number;
  durationMs: number;
}): UsageCostProvenance {
  const { context, selection, proof } = input;
  const tier: ModelPricingTier | null = selection.selection.pricingTier;
  const upperBound = selection.confidence === 'upper-bound';
  const priceSnapshot = tier === null ? null : {
    provider: tier.provider ?? proof.provider,
    modelId: tier.modelId,
    priceVersion: tier.priceVersion,
    effectiveFrom: tier.effectiveFrom,
    ...(tier.effectiveTo === undefined ? {} : { effectiveTo: tier.effectiveTo }),
    currency: tier.currency,
    inputMicrousdPerMillion: tier.inputMicrousdPerMillion,
    outputMicrousdPerMillion: tier.outputMicrousdPerMillion,
    ...(tier.cachedInputMicrousdPerMillion === undefined ? {} : { cachedInputMicrousdPerMillion: tier.cachedInputMicrousdPerMillion }),
    ...(tier.pageMicrousdPerPage === undefined ? {} : { pageMicrousdPerPage: tier.pageMicrousdPerPage }),
  };
  return {
    version: 1,
    tenantId: input.tenantId,
    apiKeyId: context.apiKeyId,
    profileId: context.profileId,
    profileRevision: context.profileRevision,
    businessId: context.businessId,
    businessVersion: context.businessVersion,
    action: context.action,
    attempt: context.attempt,
    stepKey: input.stepKey,
    connectorId: input.connectorId,
    connectorRevision: input.connectorRevision,
    durationMs: input.durationMs,
    reservationGroupId: selection.selection.reservationGroupId,
    selectedAt: selection.selection.selectedAt,
    confidence: upperBound ? 'upper-bound' : 'best-effort',
    priceRevision: selection.selection.priceRevision,
    priceSnapshot,
    budgetPins: selection.selection.budgetPins,
    costBoundCapabilityId: upperBound ? proof.capabilityId! : null,
    inputUpperBoundTokens: upperBound ? proof.inputUpperBoundTokens! : null,
    outputLimitTokens: upperBound ? proof.outputLimit! : null,
  };
}

function safeUrl(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

function parseJsonBody(value: ProviderRequest['body']): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

function isSupportedTextChatBody(body: Record<string, unknown> | undefined, outputField?: string): boolean {
  if (!body || !outputField) return false;
  const allowed = new Set(['model', 'messages', outputField, 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'response_format']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return false;
  if (typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 256) return false;
  if (!Number.isSafeInteger(body[outputField]) || Number(body[outputField]) < 1) return false;
  if (Object.hasOwn(body, 'n') || Object.hasOwn(body, 'stream')) return false;
  return body.messages.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const message = entry as Record<string, unknown>;
    return Object.keys(message).every((key) => key === 'role' || key === 'content' || key === 'name')
      && ['system', 'developer', 'user', 'assistant'].includes(String(message.role))
      && typeof message.content === 'string'
      && (message.name === undefined || typeof message.name === 'string');
  });
}

function header(request: ProviderRequest, name: string): string | undefined {
  const key = Object.keys(request.headers).find((item) => item.toLowerCase() === name);
  return key === undefined ? undefined : request.headers[key];
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value) ? value : 'unknown';
}

async function responseCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || !('error' in body)) return undefined;
    const error = (body as { error?: unknown }).error;
    return error !== null && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  } catch { return undefined; }
}

function upstreamUnavailable(): ConnectorError {
  return new ConnectorError('PROVIDER_UNAVAILABLE', 'Cost-control service did not return a valid acknowledgement.', { safeToRetry: true });
}

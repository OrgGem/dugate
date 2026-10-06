import {
  ConnectorErrorCodes,
  InvocationGrantClaimsSchema,
  InvocationRequestSchema,
  InvocationResponseSchema,
  UsageEventSchema,
  type InvocationGrantClaims,
  type InvocationRequest,
  type InvocationResponse,
  type UsageEvent,
} from '@du/contracts';
import { ConnectorError, isRetryableErrorCode } from './errors';
import type { ConnectorErrorCode, GrantClaims, LocalInvocationRequest, NormalizedProviderResult } from './types';

export type ContractInvocationRequest = InvocationRequest;
export type ContractInvocationResponse = InvocationResponse;
export type ContractUsageEvent = UsageEvent;
export type ContractGrantClaims = InvocationGrantClaims;

export function parseContractInvocationRequest(value: unknown): InvocationRequest {
  return InvocationRequestSchema.parse(value);
}

export function parseContractGrantClaims(value: unknown): InvocationGrantClaims {
  return InvocationGrantClaimsSchema.parse(value);
}

export function parseContractUsageEvent(value: unknown): UsageEvent {
  return UsageEventSchema.parse(value);
}

export function toContractInvocationRequest(request: LocalInvocationRequest, grant: string): InvocationRequest {
  return InvocationRequestSchema.parse({
    ...request,
    grant,
  });
}

export function toContractInvocationResponse(
  invocationId: string,
  result: {
    state: 'completed' | 'pending' | 'unknown' | 'failed' | 'cancelled';
    result?: NormalizedProviderResult;
    error?: { code: string; message: string; retryAfterMs?: number };
    nextPollAt?: string;
    providerRequestId?: string;
    /**
     * CR06-04: invocation continuation session. For PENDING responses this is
     * the session captured from the provider's 202 body; for SUCCEEDED it is
     * the result-side session (the pending session when the provider omitted
     * one on completion). Carried top-level so a pending-yield resume does not
     * lose the session.
     */
    sessionRef?: string | null;
  },
): InvocationResponse {
  const state = {
    completed: 'SUCCEEDED',
    pending: 'PENDING',
    unknown: 'UNKNOWN',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
  } as const;
  const response = {
    invocationId,
    state: state[result.state],
    result: result.result
      ? {
        content: result.result.content,
        data: result.result.data,
        artifacts: result.result.artifacts?.map((artifact) => ({ ...artifact, role: 'output' })),
        sessionRef: result.result.sessionRef,
      }
      : undefined,
    usage: result.result?.usage
      ? {
        inputTokens: result.result.usage.inputTokens ?? 0,
        outputTokens: result.result.usage.outputTokens ?? 0,
        pages: result.result.usage.pages,
        costMicrousd: result.result.usage.costMicrousd ?? 0,
        measurement: result.result.usage.measurement,
      }
      : undefined,
    providerRequestId: result.providerRequestId ?? result.result?.providerRequestId,
    error: result.error
      ? {
        code: result.error.code,
        message: result.error.message,
        // The cast is safe in the fail-closed direction: an unrecognised code is not
        // in the retryable set, so it is reported as non-retryable rather than retried.
        retryable: isRetryableErrorCode(result.error.code as ConnectorErrorCode),
        retryAfterMs: result.error.retryAfterMs,
      }
      : undefined,
    nextPollAt: result.nextPollAt,
    // CR06-04: top-level continuation session (pending → provider 202 value;
    // completed → result-side value, falling back to the invocation record's).
    sessionRef: result.sessionRef ?? result.result?.sessionRef,
  };
  return InvocationResponseSchema.parse(response);
}

export function localGrantClaimsFromContract(claims: InvocationGrantClaims): GrantClaims {
  return {
    audience: claims.audience,
    tenantId: claims.tenantId,
    operationId: claims.operationId,
    taskId: claims.taskId,
    stepKey: claims.stepKey,
    invocationId: claims.invocationId,
    inputHash: claims.inputHash,
    connectorRevision: `${claims.connectorId}:${claims.connectorRevision}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    allowedModel: claims.allowedModel ?? undefined,
    artifactIds: claims.artifactIds,
    artifactPins: claims.artifactPins,
  };
}

export function assertContractErrorCode(code: string): void {
  if (!(ConnectorErrorCodes as readonly string[]).includes(code)) {
    throw new ConnectorError('INVALID_INPUT', 'Unsupported connector error code.');
  }
}

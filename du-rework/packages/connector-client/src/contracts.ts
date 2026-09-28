import {
  InvocationRequestSchema,
  InvocationResponseSchema,
  type InvocationRequest,
  type InvocationResponse,
} from '@du/contracts';
import type { ClientInvocationRequest, ClientInvocationResult } from './types';

export function toContractRequest(request: ClientInvocationRequest): InvocationRequest {
  return InvocationRequestSchema.parse(request);
}

export function fromContractResponse(response: InvocationResponse): ClientInvocationResult {
  const state = {
    NEW: 'pending',
    IN_FLIGHT: 'pending',
    PENDING: 'pending',
    SUCCEEDED: 'completed',
    FAILED: 'failed',
    UNKNOWN: 'unknown',
    CANCELLED: 'cancelled',
  } as const;
  return {
    invocationId: response.invocationId,
    state: state[response.state],
    result: response.result
      ? {
        ...response.result,
        artifacts: response.result.artifacts,
      }
      : undefined,
    usage: response.usage ?? undefined,
    providerRequestId: response.providerRequestId,
    nextPollAt: response.nextPollAt ?? undefined,
    error: response.error
      ? {
          code: response.error.code,
          message: response.error.message,
          retryable: response.error.retryable,
          retryAfterMs: response.error.retryAfterMs,
        }
      : undefined,
  };
}

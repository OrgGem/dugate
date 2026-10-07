import type { InvocationInput } from '@du/contracts';

export type ClientInvocationState = 'completed' | 'pending' | 'unknown' | 'failed' | 'cancelled';

export interface ClientInvocationRequest {
  contractVersion: '1';
  invocationId: string;
  grant: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: InvocationInput;
  options?: Record<string, unknown>;
  sessionRef?: string | null;
  deadlineAt: string;
}

export interface ClientInvocationResult {
  invocationId: string;
  state: ClientInvocationState;
  result?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  providerRequestId?: string;
  /** Additive (W39-CC2): wire `error.retryable` passthrough for SDK classification. */
  error?: { code: string; message: string; retryable?: boolean; retryAfterMs?: number };
  nextPollAt?: string;
}

/**
 * Access material for polling or cancelling an invocation from a recreated
 * client. Pass a newly issued signed grant when the transport's local cache
 * does not contain the original invocation grant.
 */
export interface InvocationAccessOptions {
  invocationGrant?: string;
  signal?: AbortSignal;
}

export interface ConnectorTransport {
  invoke(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult>;
  get(invocationId: string, signal?: AbortSignal, invocationGrant?: string): Promise<ClientInvocationResult>;
  cancel(invocationId: string, reason: string, signal?: AbortSignal, invocationGrant?: string): Promise<ClientInvocationResult>;
}

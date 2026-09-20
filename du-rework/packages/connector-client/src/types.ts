export type ClientInvocationState = 'completed' | 'pending' | 'unknown' | 'failed' | 'cancelled';

export interface ClientInvocationRequest {
  contractVersion: '1';
  invocationId: string;
  grant: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: Record<string, unknown>;
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
  error?: { code: string; message: string; retryAfterMs?: number };
  nextPollAt?: string;
}

export interface ConnectorTransport {
  invoke(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult>;
  get(invocationId: string, signal?: AbortSignal): Promise<ClientInvocationResult>;
  cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<ClientInvocationResult>;
}

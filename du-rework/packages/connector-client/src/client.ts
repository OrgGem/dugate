import { ConnectorClientError } from './errors';
import type {
  ClientInvocationRequest,
  ClientInvocationResult,
  ConnectorTransport,
} from './types';

export class ConnectorClient {
  public constructor(private readonly transport: ConnectorTransport) {}

  public async invoke(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult> {
    return this.unwrap(await this.transport.invoke(request, signal));
  }

  public async replay(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult> {
    return this.invoke(request, signal);
  }

  public async poll(invocationId: string, signal?: AbortSignal): Promise<ClientInvocationResult> {
    return this.unwrap(await this.transport.get(invocationId, signal));
  }

  public async cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<ClientInvocationResult> {
    return this.unwrap(await this.transport.cancel(invocationId, reason, signal));
  }

  public async wait(
    invocationId: string,
    options: { deadlineAt: string; poll: (result: ClientInvocationResult) => Promise<void> },
    signal?: AbortSignal,
  ): Promise<ClientInvocationResult> {
    let result = await this.poll(invocationId, signal);
    while (result.state === 'pending') {
      if (Date.parse(options.deadlineAt) <= Date.now()) {
        throw new ConnectorClientError('PROVIDER_TIMEOUT', 'Invocation deadline reached while polling.');
      }
      await options.poll(result);
      result = await this.poll(invocationId, signal);
    }
    return result;
  }

  private unwrap(result: ClientInvocationResult): ClientInvocationResult {
    if (result.state === 'failed' || result.state === 'unknown') {
      throw new ConnectorClientError(result.error?.code ?? 'INVOCATION_UNKNOWN', result.error?.message ?? 'Connector invocation failed.', result.error?.retryAfterMs);
    }
    return result;
  }
}

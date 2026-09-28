import { ConnectorClientError } from './errors';
import type {
  ClientInvocationRequest,
  ClientInvocationResult,
  ConnectorTransport,
  InvocationAccessOptions,
} from './types';

export class ConnectorClient {
  public constructor(private readonly transport: ConnectorTransport) {}

  public async invoke(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult> {
    return this.unwrap(await this.transport.invoke(request, signal));
  }

  public async replay(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult> {
    return this.invoke(request, signal);
  }

  public async poll(
    invocationId: string,
    access?: AbortSignal | InvocationAccessOptions,
  ): Promise<ClientInvocationResult> {
    const { signal, invocationGrant } = resolveAccess(access);
    return this.unwrap(await this.transport.get(invocationId, signal, invocationGrant));
  }

  public async cancel(
    invocationId: string,
    reason: string,
    access?: AbortSignal | InvocationAccessOptions,
  ): Promise<ClientInvocationResult> {
    const { signal, invocationGrant } = resolveAccess(access);
    return this.unwrap(await this.transport.cancel(invocationId, reason, signal, invocationGrant));
  }

  public async wait(
    invocationId: string,
    options: {
      deadlineAt: string;
      poll: (result: ClientInvocationResult) => Promise<void>;
      invocationGrant?: string;
    },
    signal?: AbortSignal,
  ): Promise<ClientInvocationResult> {
    const access = { signal, invocationGrant: options.invocationGrant };
    let result = await this.poll(invocationId, access);
    while (result.state === 'pending') {
      if (Date.parse(options.deadlineAt) <= Date.now()) {
        throw new ConnectorClientError('PROVIDER_TIMEOUT', 'Invocation deadline reached while polling.');
      }
      await options.poll(result);
      result = await this.poll(invocationId, access);
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

function resolveAccess(access?: AbortSignal | InvocationAccessOptions): InvocationAccessOptions {
  if (!access) return {};
  return 'aborted' in access ? { signal: access } : access;
}

import { ConnectorError } from '../errors';
import type { ProviderAdapter } from '../types';
import { jsonHttpAdapter, multipartHttpAdapter } from './http';

export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  public constructor(adapters: readonly ProviderAdapter[] = [jsonHttpAdapter, multipartHttpAdapter]) {
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }

  public get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new ConnectorError('CAPABILITY_UNSUPPORTED', `Adapter ${id} is not supported.`);
    return adapter;
  }

  public list(): Array<{ adapterId: string; capabilities: string[]; supportsAsyncPoll: boolean; supportsIdempotencyKey: boolean }> {
    return [...this.adapters.values()].map((adapter) => ({
      adapterId: adapter.id,
      capabilities: [adapter.mode],
      supportsAsyncPoll: true,
      supportsIdempotencyKey: true,
    }));
  }
}

import type { ProviderRequest, ProviderResponse } from '../../src/types';

export type MockProviderMode = 'success' | 'rate-limited' | 'malformed' | 'async' | 'network-cut';

export class MockProvider {
  public calls = 0;
  public mode: MockProviderMode = 'success';
  public readonly received: ProviderRequest[] = [];

  public async send(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    this.received.push(request);
    if (this.mode === 'network-cut') throw new Error('connection closed after dispatch');
    if (this.mode === 'rate-limited') return { status: 429, body: { error: 'busy' }, headers: { 'retry-after': '2' } };
    if (this.mode === 'malformed') return { status: 200, body: ['not', 'an', 'object'] };
    if (this.mode === 'async') return { status: 202, body: { state: 'pending', nextPollAt: new Date(Date.now() + 1000).toISOString() } };
    return { status: 200, body: { content: 'mock result', providerRequestId: `provider-${this.calls}` } };
  }
}

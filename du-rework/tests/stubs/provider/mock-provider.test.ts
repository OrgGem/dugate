import { MockProviderServer } from './mock-provider';

describe('P1-05: Controllable Mock Provider Server', () => {
  const provider = new MockProviderServer();

  beforeAll(async () => {
    await provider.start();
  });

  afterAll(async () => {
    await provider.stop();
  });

  beforeEach(() => {
    provider.reset();
  });

  test('records calls and responds with normalized completions', async () => {
    const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Test invoice extract' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.content).toBe('Mock provider structured analysis result');
    expect(data.usage.inputTokens).toBe(100);

    expect(provider.callCount).toBe(1);
    expect(provider.callHistory[0]!.url).toBe('/v1/chat/completions');
    expect(JSON.parse(provider.callHistory[0]!.body)).toEqual({ prompt: 'Test invoice extract' });
  });

  test('received-but-response-lost hook destroys socket after request processing', async () => {
    provider.setFaults({ simulateResponseLost: true });

    // Client fetch should fail with network / socket hangup error
    await expect(
      fetch(`${provider.baseUrl}/v1/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'extract' }),
      }),
    ).rejects.toThrow();

    // Provider recorded that it received the call before the connection was dropped
    expect(provider.callCount).toBe(1);
  });

  test('rate limit fault returns HTTP 429 with Retry-After header', async () => {
    provider.setFaults({ rateLimit: { retryAfterSeconds: 5 } });

    const response = await fetch(`${provider.baseUrl}/v1/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  test('service unavailable fault returns HTTP 503', async () => {
    provider.setFaults({ unavailable: true });

    const response = await fetch(`${provider.baseUrl}/v1/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
  });

  test('malformed JSON fault produces unparseable body', async () => {
    provider.setFaults({ malformedJson: true });

    const response = await fetch(`${provider.baseUrl}/v1/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).rejects.toThrow();
  });
});

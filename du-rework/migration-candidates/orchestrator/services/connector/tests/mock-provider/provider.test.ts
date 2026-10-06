import { MockProvider } from './provider';

test('mock provider exposes deterministic call counter and fault modes', async () => {
  const provider = new MockProvider();
  const response = await provider.send({ url: 'https://provider.test', method: 'POST', headers: {}, body: '{}' });
  expect(response.status).toBe(200);
  expect(provider.calls).toBe(1);
  provider.mode = 'network-cut';
  await expect(provider.send({ url: 'https://provider.test', method: 'POST', headers: {}, body: '{}' })).rejects.toThrow('connection closed');
  expect(provider.calls).toBe(2);
});

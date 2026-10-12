import type { EffectiveProfile } from '../src/modules/profiles/profiles';
const fetcher = jest.fn<Promise<Response>, [unknown, RequestInit?]>();
jest.mock('@du/egress', () => ({ ...jest.requireActual('@du/egress'), createPinnedFetch: () => fetcher }));
import { acquireLegacyUrl } from '../src/compat/legacy-url-input';
const budget = { maxBytes: 1024, timeoutMs: 1000 };
const profile = { mode: 'pinned', policy: { allowedFileExtensions: '.txt', allowedOrigins: ['https://example.com'], fileUrlAuthConfig: { type: 'bearer', token: 'source-secret' } } } as unknown as EffectiveProfile;
beforeEach(() => fetcher.mockReset());
test('ORV11 source credential stays on allowlisted origin through redirect', async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example/doc.txt' } })).mockResolvedValueOnce(new Response('document', { headers: { 'content-type': 'text/plain' } }));
  const result = await acquireLegacyUrl({ url: 'https://example.com/doc.txt', mimeType: 'text/markdown' }, profile, budget);
  expect(result.type).toBe('text/markdown');
  expect(result.bytes.toString()).toBe('document');
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer source-secret');
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has('authorization')).toBe(false);
});
test('ORV11 refuses credential origin before network', async () => {
  await expect(acquireLegacyUrl({ url: 'https://other.example/doc.txt' }, profile, budget)).rejects.toMatchObject({ status: 403 });
  expect(fetcher).not.toHaveBeenCalled();
});
test('ORV11 cancels a response that exceeds remaining aggregate bytes', async () => {
  fetcher.mockResolvedValueOnce(new Response('too many bytes'));
  await expect(acquireLegacyUrl({ url: 'https://example.com/doc.txt' }, { mode: 'legacy' }, { ...budget, maxBytes: 2 })).rejects.toMatchObject({ status: 413 });
});
test('ORV11 disallows credentialed HTTPS downgrade', async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://example.com/doc.txt' } }));
  await expect(acquireLegacyUrl({ url: 'https://example.com/doc.txt' }, profile, budget)).rejects.toMatchObject({ status: 403 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('ORV11 preserves unauthenticated public HTTP sources through the pinned transport', async () => {
  fetcher.mockResolvedValueOnce(new Response('legacy public document'));
  const result = await acquireLegacyUrl({ url: 'http://example.com/doc.txt' }, { mode: 'legacy' }, budget);
  expect(result.bytes.toString()).toBe('legacy public document');
  expect(String(fetcher.mock.calls[0]![0])).toBe('http://example.com/doc.txt');
});

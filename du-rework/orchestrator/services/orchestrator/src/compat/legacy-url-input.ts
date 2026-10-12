import { createPinnedFetch, DestinationDeniedError } from '@du/egress';
import type { EffectiveProfile } from '../modules/profiles/profiles';
import { HttpError } from '../http/errors';
import { extensionDeniedReason } from '../modules/profiles/policy';

/** Bounded, DNS-pinned source transfer. Credentials never cross an origin. */
async function acquireLegacyUrlImpl(entry: Record<string, unknown>, profile: EffectiveProfile, budget: { maxBytes: number; timeoutMs: number }): Promise<{ name: string; type: string; size: number; bytes: Buffer }> {
  let url = new URL(String(entry.url));
  const originalOrigin = url.origin;
  const name = typeof entry.fileName === 'string' ? entry.fileName : typeof entry.filename === 'string' ? entry.filename : decodeURIComponent(url.pathname.split('/').pop() || 'document');
  const auth = profile.mode === 'pinned' ? profile.policy.fileUrlAuthConfig : null;
  if (profile.mode === 'pinned') {
    const denied = extensionDeniedReason(profile.policy.allowedFileExtensions, name);
    if (denied) throw new HttpError(422, 'PROFILE_EXTENSION_DENIED', denied);
    if (auth && auth.type !== 'none' && !profile.policy.allowedOrigins?.includes(originalOrigin)) {
      throw new HttpError(403, 'DESTINATION_DENIED', 'Source credential origin is not allowlisted');
    }
  }
  const headers = new Headers();
  if (auth?.type === 'bearer') {
    if (!auth.token) throw new HttpError(422, 'INVALID_SCHEMA', 'Source bearer token is missing');
    headers.set('authorization', `Bearer ${auth.token}`);
  } else if (auth?.type === 'header') {
    if (!auth.header_name || !auth.header_value) throw new HttpError(422, 'INVALID_SCHEMA', 'Source header credential is incomplete');
    headers.set(auth.header_name, auth.header_value);
  } else if (auth?.type === 'query') {
    if (!auth.query_key || !auth.query_value) throw new HttpError(422, 'INVALID_SCHEMA', 'Source query credential is incomplete');
    url.searchParams.set(auth.query_key, auth.query_value);
  }
  const fetcher = createPinnedFetch({ timeoutMs: budget.timeoutMs });
  const signal = AbortSignal.timeout(budget.timeoutMs);
  for (let hop = 0; hop <= 5; hop += 1) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(422, 'INVALID_URL', 'Source URLs require HTTP or HTTPS');
    if (auth && auth.type !== 'none' && url.protocol !== 'https:') throw new HttpError(403, 'DESTINATION_DENIED', 'Source credentials require HTTPS, including redirects');
    const response = await fetcher(url, { headers: url.origin === originalOrigin ? headers : undefined, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new HttpError(422, 'INVALID_URL', 'Source redirect has no location');
      url = new URL(location, url);
      if (auth?.type === 'query' && url.origin !== originalOrigin && auth.query_key) url.searchParams.delete(auth.query_key);
      continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new HttpError(422, 'SOURCE_FETCH_FAILED', 'Source download failed'); }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > budget.maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Source exceeds 64 MiB');
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return { name, size, type: typeof entry.mimeType === 'string' && entry.mimeType.trim() ? entry.mimeType : response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream', bytes: Buffer.concat(chunks) };
  }
  throw new HttpError(422, 'INVALID_URL', 'Source redirect limit exceeded');
}

export async function acquireLegacyUrl(entry: Record<string, unknown>, profile: EffectiveProfile, budget: { maxBytes: number; timeoutMs: number }): Promise<{ name: string; type: string; size: number; bytes: Buffer }> {
  try { return await acquireLegacyUrlImpl(entry, profile, budget); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DestinationDeniedError) throw new HttpError(403, 'DESTINATION_DENIED', 'Source destination is not permitted');
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new HttpError(504, 'SOURCE_TIMEOUT', 'Source download timed out');
    throw new HttpError(422, 'SOURCE_FETCH_FAILED', 'Source download failed');
  }
}

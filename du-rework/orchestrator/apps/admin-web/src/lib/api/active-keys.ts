import type { AdminApiClient } from './client';
import type { ApiKeyRow } from './types';

/** Follow server cursors; preserve cancellation when an operator changes tenant. */
export async function loadActiveKeys(client: AdminApiClient, tenantId: string, cancelled: () => boolean): Promise<ApiKeyRow[]> {
  const keys: ApiKeyRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await client.listApiKeys({ tenantId, limit: '100', ...(cursor ? { cursor } : {}) });
    if (cancelled()) return [];
    if (!result.ok) throw new Error(result.problem.title ?? 'API keys could not be loaded');
    keys.push(...result.data.items.filter(key => key.status === 'ACTIVE'));
    cursor = result.data.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('API key pagination repeated; refresh and retry');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...new Map(keys.map(key => [key.id, key])).values()];
}

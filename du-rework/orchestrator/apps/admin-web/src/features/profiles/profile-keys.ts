/** Runtime parsing for a profile's key set (unknown -> typed, rows dropped if malformed). */
import type { ProfileApiKeyPage, ProfileApiKeyRow } from '@/lib/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseProfileApiKeyPage(value: unknown): ProfileApiKeyPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: ProfileApiKeyRow[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) continue;
    const id = str(raw['id']);
    const tenantId = str(raw['tenantId']);
    const prefix = str(raw['prefix']);
    const status = str(raw['status']);
    // membershipState is REQUIRED, not optional: without it a row cannot say
    // whether it still resolves, which is the whole point of this table.
    const membershipState = str(raw['membershipState']);
    if (id === null || tenantId === null || prefix === null || status === null || membershipState === null) {
      continue;
    }
    items.push({
      id,
      tenantId,
      prefix,
      name: str(raw['name']),
      status,
      createdAt: str(raw['createdAt']) ?? '',
      membershipState,
      joinedAt: str(raw['joinedAt']) ?? '',
      revokedAt: str(raw['revokedAt']),
    });
  }
  return {
    items,
    nextCursor: null,
    prevCursor: null,
    total: typeof value['total'] === 'number' ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' ? value['limit'] : items.length,
    profileId: str(value['profileId']) ?? '',
  };
}

export function keyStatusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = status.toUpperCase();
  if (value === 'ACTIVE') return 'success';
  if (value === 'REVOKING') return 'warning';
  if (value === 'REVOKED') return 'danger';
  return 'neutral';
}

export function membershipVariant(state: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = state.toUpperCase();
  if (value === 'ACTIVE') return 'success';
  if (value === 'REVOKED') return 'danger';
  return 'neutral';
}

/** Runtime parsing for the api-keys page (unknown → typed, rows dropped if malformed). */
import type { ApiKeyGrant, ApiKeyPage, ApiKeyRow } from '@/lib/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseApiKeyPage(value: unknown): ApiKeyPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: ApiKeyRow[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) continue;
    const id = str(raw['id']);
    const tenantId = str(raw['tenantId']);
    const prefix = str(raw['prefix']);
    const status = str(raw['status']);
    if (id === null || tenantId === null || prefix === null || status === null) continue;
    items.push({
      id,
      tenantId,
      prefix,
      maskedHint: str(raw['maskedHint']) ?? prefix,
      status,
      createdAt: str(raw['createdAt']) ?? '',
      updatedAt: str(raw['updatedAt']) ?? '',
    });
  }
  const grants: ApiKeyGrant[] = [];
  if (Array.isArray(value['grants'])) {
    for (const raw of value['grants']) {
      if (!isRecord(raw)) continue;
      const businessId = str(raw['businessId']);
      const action = str(raw['action']);
      if (businessId === null || action === null) continue;
      grants.push({
        businessId,
        businessVersion: str(raw['businessVersion']) ?? '',
        action,
        grantedAt: str(raw['grantedAt']) ?? '',
      });
    }
  }
  return {
    items,
    nextCursor: str(value['nextCursor']),
    prevCursor: str(value['prevCursor']),
    total: typeof value['total'] === 'number' ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' ? value['limit'] : items.length,
    grants,
    createCopyOnce: value['createCopyOnce'] ?? null,
  };
}

export function apiKeyStatusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = status.toUpperCase();
  if (value === 'ACTIVE') return 'success';
  if (value === 'REVOKED') return 'danger';
  if (value === 'EXPIRED' || value === 'DISABLED') return 'warning';
  return 'neutral';
}

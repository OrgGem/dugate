/** Runtime parsing for the business registry reads. */
import type { BusinessPage, BusinessRow, BusinessVersions, BusinessVersionRow } from '@/lib/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseBusinessPage(value: unknown): BusinessPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: BusinessRow[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) continue;
    const businessId = str(raw['businessId'] ?? raw['business_id']);
    if (businessId === null) continue;
    items.push({
      businessId,
      activeVersion: str(raw['activeVersion']),
      version: str(raw['version']),
      status: str(raw['status']) ?? '—',
      updatedAt: str(raw['updatedAt']),
    });
  }
  return {
    items,
    total: typeof value['total'] === 'number' ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' ? value['limit'] : items.length,
  };
}

export function parseBusinessVersions(value: unknown): BusinessVersions | null {
  if (!isRecord(value)) return null;
  const businessId = str(value['businessId'] ?? value['business_id']);
  if (businessId === null) return null;
  const rowsRaw = Array.isArray(value['rows']) ? value['rows'] : [];
  const rows: BusinessVersionRow[] = [];
  for (const raw of rowsRaw) {
    if (!isRecord(raw)) continue;
    const version = str(raw['version']);
    if (version === null) continue;
    rows.push({
      version,
      status: str(raw['status']) ?? '—',
      isActive: raw['isActive'] === true || raw['is_active'] === true,
      updatedAt: str(raw['updatedAt']),
    });
  }
  return { businessId, activeVersion: str(value['activeVersion']), rows };
}

export function businessStatusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = status.toUpperCase();
  if (value === 'ENABLED' || value === 'ACTIVE') return 'success';
  if (value === 'DRAINING') return 'warning';
  if (value === 'DISABLED' || value === 'RETIRED' || value === 'INACTIVE') return 'neutral';
  return 'neutral';
}

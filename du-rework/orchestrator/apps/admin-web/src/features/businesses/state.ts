/** Runtime parsing for the business registry reads. */
import type { BusinessPage, BusinessRow, BusinessVersions, BusinessVersionRow } from '@/lib/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countsByReason(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).flatMap(([reason, rawCount]) => {
    const parsedCount = count(rawCount);
    return reason.length > 0 && parsedCount !== null ? [[reason, parsedCount]] : [];
  }));
}

export function activationRevisionMatches(
  displayedRevision: number | null | undefined,
  refreshedRevision: number | null | undefined,
): displayedRevision is number {
  return typeof displayedRevision === 'number' && Number.isSafeInteger(displayedRevision)
    && displayedRevision > 0 && refreshedRevision === displayedRevision;
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
      activationRevision: revision(raw['activationRevision']),
      admissionEligible: typeof raw['admissionEligible'] === 'boolean' ? raw['admissionEligible'] : null,
      admissionReason: str(raw['admissionReason']),
      submissionsPaused: typeof raw['submissionsPaused'] === 'boolean' ? raw['submissionsPaused'] : null,
      preDrainVersion: str(raw['preDrainVersion']),
      version: str(raw['version']),
      status: str(raw['status']) ?? '—',
      updatedAt: str(raw['updatedAt']),
      enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : null,
      lifecycleRevision: revision(raw['lifecycleRevision']),
    });
  }
  return {
    items,
    total: typeof value['total'] === 'number' ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' ? value['limit'] : items.length,
    nextCursor: typeof value['nextCursor'] === 'string' ? value['nextCursor'] : null,
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
      admissionEligible: typeof raw['admissionEligible'] === 'boolean' ? raw['admissionEligible'] : null,
      admissionReason: str(raw['admissionReason']),
      parkedTaskCount: count(raw['parkedTaskCount']),
      drainingTaskCount: count(raw['drainingTaskCount']),
      parkedReasons: countsByReason(raw['parkedReasons']),
      updatedAt: str(raw['updatedAt']),
    });
  }
  return {
    businessId,
    activeVersion: str(value['activeVersion']),
    activationRevision: revision(value['activationRevision']),
    submissionsPaused: typeof value['submissionsPaused'] === 'boolean' ? value['submissionsPaused'] : null,
    preDrainVersion: str(value['preDrainVersion']),
    remainingOperations: count(value['remainingOperations']),
    rows,
    enabled: typeof value['enabled'] === 'boolean' ? value['enabled'] : null,
    lifecycleRevision: revision(value['lifecycleRevision']),
  };
}

export function businessStatusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = status.toUpperCase();
  if (value === 'ENABLED' || value === 'ACTIVE') return 'success';
  if (value === 'DRAINING') return 'warning';
  if (value === 'DISABLED' || value === 'RETIRED' || value === 'INACTIVE') return 'neutral';
  return 'neutral';
}

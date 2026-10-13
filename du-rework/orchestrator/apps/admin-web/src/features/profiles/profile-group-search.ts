import type { ProfileGroupFunction, ProfileGroupFunctionCatalog } from '@du/contracts';
import type { BusinessRow } from '@/lib/api';

export interface ProfileGroupBusinessSuggestion {
  type: 'business';
  key: string;
  businessId: string;
}

export interface ProfileGroupFunctionSuggestion {
  type: 'function';
  key: string;
  businessId: string;
  businessVersion: string;
  descriptor: ProfileGroupFunction;
}

export type ProfileGroupSearchSuggestion = ProfileGroupBusinessSuggestion | ProfileGroupFunctionSuggestion;

/** Shares the discovery request cap across canceled/replaced index generations. */
export function createBoundedSearchRequestScheduler(maxConcurrent: number) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive safe integer');
  }
  let active = 0;
  let waiters: Array<() => void> = [];
  return {
    async run<T>(request: () => Promise<T>, isCurrent: () => boolean): Promise<T | null> {
      while (active >= maxConcurrent) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        active -= 1;
        waiters.shift()?.();
      };
      try {
        if (!isCurrent()) return null;
        return await request();
      } finally {
        release();
      }
    },
  };
}

function normalized(value: string): string {
  return value.toLocaleLowerCase();
}

function functionSearchText(businessId: string, descriptor: ProfileGroupFunction): string {
  return normalized([
    businessId,
    descriptor.kind,
    descriptor.endpointSlug ?? '',
    descriptor.action,
    descriptor.functionId,
  ].join(' '));
}

export function profileGroupFunctionLabel(descriptor: ProfileGroupFunction): string {
  return descriptor.kind === 'endpoint'
    ? descriptor.endpointSlug ?? descriptor.functionId
    : descriptor.action;
}

export function buildProfileGroupSearchSuggestions(
  businesses: BusinessRow[],
  catalogs: ProfileGroupFunctionCatalog[],
  query: string,
  limit = 8,
): ProfileGroupSearchSuggestion[] {
  const needle = normalized(query.trim());
  if (!needle || !Number.isSafeInteger(limit) || limit < 1) return [];

  const enabled = new Set(businesses.filter((business) => business.enabled === true).map((business) => business.businessId));
  const suggestions: ProfileGroupSearchSuggestion[] = [];
  for (const business of businesses) {
    if (business.enabled !== true || !normalized(business.businessId).includes(needle)) continue;
    suggestions.push({ type: 'business', key: `business:${business.businessId}`, businessId: business.businessId });
  }
  for (const catalog of catalogs) {
    if (!enabled.has(catalog.businessId) || !catalog.businessEnabled) continue;
    for (const descriptor of catalog.functions) {
      if (!functionSearchText(catalog.businessId, descriptor).includes(needle)) continue;
      suggestions.push({
        type: 'function',
        key: `function:${JSON.stringify([catalog.businessId, catalog.businessVersion, descriptor.functionId])}`,
        businessId: catalog.businessId,
        businessVersion: catalog.businessVersion,
        descriptor,
      });
    }
  }
  return suggestions.slice(0, limit);
}

export function filterProfileGroupBusinesses(
  businesses: BusinessRow[],
  catalogs: ProfileGroupFunctionCatalog[],
  query: string,
): BusinessRow[] {
  const needle = normalized(query.trim());
  const enabled = businesses.filter((business) => business.enabled === true);
  if (!needle) return enabled;

  const matchingFunctions = new Set<string>();
  for (const catalog of catalogs) {
    if (!catalog.businessEnabled) continue;
    if (catalog.functions.some((descriptor) => functionSearchText(catalog.businessId, descriptor).includes(needle))) {
      matchingFunctions.add(catalog.businessId);
    }
  }
  return enabled.filter((business) => normalized(business.businessId).includes(needle) || matchingFunctions.has(business.businessId));
}

import { useCallback, useId, useMemo } from 'react';
import { FormField } from '@/components/ui/field';
import { ReferenceInput, type ReferenceOptionPage } from '@/components/ui/reference-input';
import { createAdminApiClient } from '@/lib/api';
import { parseBusinessPage, parseBusinessVersions } from './state';

/** Business IDs and versions are registry references; typing remains available
 * when a caller is absent from the registry or a bounded suggestion read fails. */
export function BusinessInputs({
  businessId, businessVersion, onBusinessChange, onVersionChange, businessInputId, versionInputId,
}: {
  businessId: string;
  businessVersion: string;
  onBusinessChange: (value: string) => void;
  onVersionChange: (value: string) => void;
  businessInputId?: string;
  versionInputId?: string;
}) {
  const client = useMemo(() => createAdminApiClient(), []);
  const id = useId().replaceAll(':', '');
  const businessFieldId = businessInputId ?? `${id}-business`;
  const versionFieldId = versionInputId ?? `${id}-version`;

  const loadBusinessSuggestions = useCallback(async (
    query: string,
    scopeKey: string,
    cursor: string | null,
  ): Promise<ReferenceOptionPage> => {
    if (scopeKey !== 'business-registry') return { items: [], nextCursor: null };
    const result = await client.listBusinesses({ limit: '50', ...(cursor ? { cursor } : {}) });
    if (!result.ok) throw new Error('Business registry suggestions are unavailable.');
    const page = parseBusinessPage(result.data);
    if (page === null) throw new Error('Business registry returned an unreadable response.');
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = page.items.map((business) => ({
      value: business.businessId,
      label: business.businessId,
      ...(business.activeVersion ? { description: `Active version ${business.activeVersion}` } : {}),
    })).filter((option) => `${option.value} ${option.label} ${option.description ?? ''}`
      .toLocaleLowerCase().includes(normalizedQuery));
    return { items, nextCursor: page.nextCursor ?? null };
  }, [client]);

  const loadVersionSuggestions = useCallback(async (
    query: string,
    scopeKey: string,
    cursor: string | null,
  ): Promise<ReferenceOptionPage> => {
    if (!scopeKey || scopeKey !== businessId.trim() || cursor) return { items: [], nextCursor: null };
    const result = await client.getBusinessVersions(scopeKey);
    if (!result.ok) throw new Error('Business version suggestions are unavailable.');
    const page = parseBusinessVersions(result.data);
    if (page === null || page.businessId !== scopeKey) throw new Error('Business versions did not match the selected Business ID.');
    const options = [
      { value: 'latest', label: 'latest', description: page.activeVersion ? `Active version ${page.activeVersion}` : 'Resolve the active version' },
      ...page.rows.map((row) => ({
        value: row.version,
        label: row.version,
        description: `${row.status}${row.isActive ? ' · active' : ''}`,
      })),
    ];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = options.filter((option) => `${option.value} ${option.label} ${option.description}`
      .toLocaleLowerCase().includes(normalizedQuery));
    return { items: [...new Map(items.map((option) => [option.value, option])).values()], nextCursor: null };
  }, [businessId, client]);

  return (
    <>
      <div className="w-full max-w-sm">
        <FormField id={businessFieldId} label="Business ID" description="Choose a registered business or enter its ID. More registry rows can be loaded as needed.">
          <ReferenceInput
            id={businessFieldId}
            aria-label="businessId"
            value={businessId}
            onValueChange={(value) => { onBusinessChange(value); onVersionChange(''); }}
            scopeKey="business-registry"
            loadOptions={loadBusinessSuggestions}
            maxLength={256}
            autoComplete="off"
            placeholder="Business ID"
          />
        </FormField>
      </div>
      <div className="w-full max-w-sm">
        <FormField id={versionFieldId} label="Business version" description="Choose a registered version, latest, or enter a version.">
          <ReferenceInput
            id={versionFieldId}
            aria-label="businessVersion"
            value={businessVersion}
            onValueChange={onVersionChange}
            scopeKey={businessId.trim() || null}
            loadOptions={loadVersionSuggestions}
            maxLength={256}
            autoComplete="off"
            placeholder="latest"
          />
        </FormField>
      </div>
    </>
  );
}

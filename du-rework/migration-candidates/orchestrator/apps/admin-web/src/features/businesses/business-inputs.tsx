import { useEffect, useId, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { createAdminApiClient } from '@/lib/api';
import { parseBusinessPage, parseBusinessVersions } from './state';

/** Suggestions are session-scoped reads. Manual entry remains available when
 * the registry is incomplete or the current account cannot list it. */
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
  const id = useId();
  const businessFieldId = businessInputId ?? `${id}-business`;
  const versionFieldId = versionInputId ?? `${id}-version`;
  const [businesses, setBusinesses] = useState<string[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [businessHint, setBusinessHint] = useState('Loading business suggestions…');
  const [versionHint, setVersionHint] = useState('Select or enter a business first.');

  useEffect(() => {
    let active = true;
    void client.listBusinesses().then((result) => {
      if (!active) return;
      const page = result.ok ? parseBusinessPage(result.data) : null;
      setBusinesses(page?.items.map((row) => row.businessId) ?? []);
      setBusinessHint(page !== null && page.items.length > 0
        ? 'Choose a registered business or enter its ID.'
        : 'Business suggestions unavailable; enter the ID manually.');
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    let active = true;
    setVersions([]);
    const business = businessId.trim();
    if (business.length === 0) {
      setVersionHint('Select or enter a business first.');
      return;
    }
    setVersionHint('Loading version suggestions…');
    const timer = window.setTimeout(() => {
      void client.getBusinessVersions(business).then((result) => {
        if (!active) return;
        const page = result.ok ? parseBusinessVersions(result.data) : null;
        setVersions(page?.rows.map((row) => row.version) ?? []);
        setVersionHint(page !== null && page.rows.length > 0
          ? 'Choose a registered version, latest, or enter a version.'
          : 'Version suggestions unavailable; enter a version or use latest.');
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [client, businessId]);

  return (
    <>
      <div className="w-full max-w-sm">
        <label htmlFor={businessFieldId} className="block text-sm font-medium">Business ID</label>
        <Input id={businessFieldId} aria-label="businessId" aria-describedby={`${id}-business-hint`} list={`${id}-businesses`} value={businessId}
          onChange={(event) => { onBusinessChange(event.target.value); onVersionChange('latest'); }} placeholder="Business ID" />
        <datalist id={`${id}-businesses`}>{[...new Set(businesses)].map((value) => <option key={value} value={value} />)}</datalist>
        <p id={`${id}-business-hint`} className="mt-1 text-xs text-[var(--text-sub)]">{businessHint}</p>
      </div>
      <div className="w-full max-w-sm">
        <label htmlFor={versionFieldId} className="block text-sm font-medium">Business version</label>
        <Input id={versionFieldId} aria-label="businessVersion" aria-describedby={`${id}-version-hint`} list={`${id}-versions`} value={businessVersion}
          onChange={(event) => onVersionChange(event.target.value)} placeholder="latest" />
        <datalist id={`${id}-versions`}>{[...new Set(['latest', ...versions])].map((value) => <option key={value} value={value} />)}</datalist>
        <p id={`${id}-version-hint`} className="mt-1 text-xs text-[var(--text-sub)]">{versionHint}</p>
      </div>
    </>
  );
}

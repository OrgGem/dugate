import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import { createAdminApiClient } from '@/lib/api';

import type { MigrationReadinessRun } from '@/lib/api/types';
const statusLabels = { INVENTORY_REQUIRED: 'Inventory report required', RECONCILIATION_REQUIRED: 'Reconciliation required', EXTERNAL_VERIFICATION_REQUIRED: 'External verification required' };
export function MigrationReadiness({ tenantId }: { tenantId: string | null | undefined }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const request = useRef(0);
  const [runs, setRuns] = useState<MigrationReadinessRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const seq = ++request.current;
    setError(null); setRuns(null);
    if (!tenantId) { setBusy(false); return; }
    setBusy(true);
    try {
      const result = await client.getMigrationReadiness(tenantId);
      if (seq !== request.current) return;
      if (!result.ok) { setError(result.problem.title ?? 'Migration readiness unavailable'); return; }
      if (result.data.tenantId !== tenantId || !Array.isArray(result.data.runs)) { setError('Migration readiness response did not match the selected organization.'); return; }
      setRuns(result.data.runs);
    } catch { if (seq === request.current) setError('Migration readiness could not be reached.'); }
    finally { if (seq === request.current) setBusy(false); }
  }, [client, tenantId]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  return <Card><CardHeader><CardTitle>Migration readiness</CardTitle><CardDescription>Recorded import and reconciliation evidence for the selected organization. This report does not approve a production cutover.</CardDescription></CardHeader><CardContent className='space-y-4'>
    <Button variant='outline' disabled={!tenantId || busy} onClick={() => void load()}>Refresh migration readiness</Button>
    {!tenantId && <p>Select an organization to inspect its migration runs.</p>}
    {busy && <p role='status'>Loading migration evidence…</p>}
    {error && <AlertBanner variant='error' title='Readiness unavailable'>{error}</AlertBanner>}
    {runs?.length === 0 && <p>No recorded import runs for this organization. No cutover readiness can be inferred.</p>}
    {runs?.map(run => {
      const inventory = run.latestInventory;
      const entities = [...new Set([...Object.keys(run.sourceCounts), ...Object.keys(run.destinationCounts), ...Object.keys(inventory?.targetCounts ?? {})])];
      return <section key={`${run.sourceVersion}:${run.importedAt}`} aria-label={`Migration ${run.sourceVersion}`} className='border rounded p-3 space-y-3'>
        <div className='flex flex-wrap items-center gap-2'><h3 className='font-semibold break-all'>{run.sourceVersion}</h3><Badge variant='warning'>{statusLabels[run.status] ?? 'Review required'}</Badge><Badge variant='warning'>Cutover on hold</Badge></div>
        <p className='text-xs'>Import recorded {new Date(run.importedAt).toLocaleString()}{inventory ? ` · Inventory recorded ${new Date(inventory.recordedAt).toLocaleString()}` : ''}</p>
        <div className='overflow-x-auto'><table className='w-full text-sm'><thead><tr className='text-left'><th className='p-2'>Entity</th><th className='p-2'>Source</th><th className='p-2'>Imported destination</th><th className='p-2'>Latest inventory</th></tr></thead><tbody>{entities.map(entity => <tr key={entity} className='border-t'><td className='p-2'>{entity}</td><td className='p-2'>{run.sourceCounts[entity] ?? 'Not reported'}</td><td className='p-2'>{run.destinationCounts[entity] ?? 'Not reported'}</td><td className='p-2'>{inventory?.targetCounts[entity] ?? 'Not reported'}</td></tr>)}</tbody></table></div>
        {inventory ? <><p className='text-sm'>Reconciliation issues: {inventory.totalIssues} · Verified blobs: {inventory.verifiedBlobCount} · Failed blob checks: {inventory.failedBlobCount}</p>{Object.keys(inventory.issueCounts).length > 0 && <ul className='list-disc pl-5 text-sm'>{Object.entries(inventory.issueCounts).map(([code, count]) => <li key={code}><code>{code}</code>: {count}</li>)}</ul>}<h4 className='text-sm font-semibold'>Required external verification</h4><ul className='list-disc pl-5 text-sm'>{inventory.externalGates.map(gate => <li key={gate}>{gate}</li>)}</ul></> : <p className='text-sm'>Record an inventory report with the migration inventory tool before assessing missing entities, conflicts and blob integrity.</p>}
        <details><summary className='text-xs cursor-pointer'>Evidence fingerprints</summary><dl className='text-xs break-all'><dt>Source snapshot</dt><dd>{run.sourceSha256}</dd><dt>Mapping plan</dt><dd>{run.planSha256}</dd>{inventory && <><dt>Inventory</dt><dd>{inventory.inventorySha256}</dd></>}</dl></details>
      </section>;
    })}
  </CardContent></Card>;
}

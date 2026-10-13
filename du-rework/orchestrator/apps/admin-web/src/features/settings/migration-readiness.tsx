import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TablePagination, TableRow } from '@/components/ui/table';
import { createAdminApiClient } from '@/lib/api';

import type { MigrationReadinessRun } from '@/lib/api/types';
const statusLabels = { INVENTORY_REQUIRED: 'Inventory report required', RECONCILIATION_REQUIRED: 'Reconciliation required', EXTERNAL_VERIFICATION_REQUIRED: 'External verification required' };
const PAGE_SIZE = 5;
const migrationKey = (run: MigrationReadinessRun) => `${run.sourceVersion}:${run.importedAt}`;
export function MigrationReadiness({ tenantId }: { tenantId: string | null | undefined }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const request = useRef(0);
  const [runs, setRuns] = useState<MigrationReadinessRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
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
  const runCount = runs?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(runCount / PAGE_SIZE));
  const visibleRuns = runs?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];
  const selectedRun = runs?.find((run) => migrationKey(run) === selectedRunKey) ?? runs?.[0] ?? null;
  const rangeStart = runCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(runCount, (page + 1) * PAGE_SIZE);
  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  return <Card><CardHeader><CardTitle>Migration readiness</CardTitle><CardDescription>Recorded import and reconciliation evidence for the selected organization. This report does not approve a production cutover.</CardDescription></CardHeader><CardContent className='space-y-4'>
    <Button variant='outline' disabled={!tenantId || busy} onClick={() => void load()}>Refresh migration readiness</Button>
    {!tenantId && <p>Select an organization to inspect its migration runs.</p>}
    {busy && <p role='status'>Loading migration evidence…</p>}
    {error && <AlertBanner variant='error' title='Readiness unavailable'>{error}</AlertBanner>}
    {runs?.length === 0 && <p>No recorded import runs for this organization. No cutover readiness can be inferred.</p>}
    {runs && runs.length > 0 && <>
      <TableContainer maxHeight={320} aria-label='Migration runs'>
        <Table aria-label='Migration readiness runs' density='compact'>
          <TableHeader sticky><TableRow><TableHead>Source version</TableHead><TableHead>Imported</TableHead><TableHead>Readiness</TableHead><TableHead>Selection</TableHead></TableRow></TableHeader>
          <TableBody>{visibleRuns.map((run) => <TableRow key={migrationKey(run)} data-state={selectedRun && migrationKey(selectedRun) === migrationKey(run) ? 'selected' : undefined} onClick={() => setSelectedRunKey(migrationKey(run))}>
            <TableCell className='max-w-64 break-all font-medium'>{run.sourceVersion}</TableCell>
            <TableCell className='whitespace-nowrap text-xs'>{new Date(run.importedAt).toLocaleString()}</TableCell>
            <TableCell><Badge variant='warning'>{statusLabels[run.status] ?? 'Review required'}</Badge><span className='mt-1 block text-xs text-[var(--text-sub)]'>Cutover on hold</span></TableCell>
            <TableCell><Button type='button' variant='link' className='h-auto justify-start p-0 text-left' aria-label={`Review migration ${run.sourceVersion}`} onClick={(event) => { event.stopPropagation(); setSelectedRunKey(migrationKey(run)); }}>Review</Button></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer>
      <TablePagination hasPreviousPage={page > 0} hasNextPage={page + 1 < pageCount} onPreviousPage={() => setPage((current) => Math.max(0, current - 1))} onNextPage={() => setPage((current) => Math.min(pageCount - 1, current + 1))} pending={busy} status={`Showing ${rangeStart}–${rangeEnd} of ${runCount} loaded migration runs. Page ${page + 1} of ${pageCount}.`} ariaLabel='Migration run pagination' />
    </>}
    {selectedRun && (() => {
      const run = selectedRun;
      const inventory = run.latestInventory;
      const entities = [...new Set([...Object.keys(run.sourceCounts), ...Object.keys(run.destinationCounts), ...Object.keys(inventory?.targetCounts ?? {})])];
      return <section key={`${run.sourceVersion}:${run.importedAt}`} aria-label={`Migration ${run.sourceVersion}`} className='border rounded p-3 space-y-3'>
        <div className='flex flex-wrap items-center gap-2'><h3 className='font-semibold break-all'>{run.sourceVersion}</h3><Badge variant='warning'>{statusLabels[run.status] ?? 'Review required'}</Badge><Badge variant='warning'>Cutover on hold</Badge></div>
        <p className='text-xs'>Import recorded {new Date(run.importedAt).toLocaleString()}{inventory ? ` · Inventory recorded ${new Date(inventory.recordedAt).toLocaleString()}` : ''}</p>
        <TableContainer maxHeight={240} aria-label={`Entity counts for migration ${run.sourceVersion}`}>
          <Table aria-label={`Migration ${run.sourceVersion} entity counts`} density='compact'>
            <TableHeader sticky><TableRow><TableHead>Entity</TableHead><TableHead>Source</TableHead><TableHead>Imported destination</TableHead><TableHead>Latest inventory</TableHead></TableRow></TableHeader>
            <TableBody>{entities.map(entity => <TableRow key={entity}><TableHead scope='row' className='break-all normal-case tracking-normal'>{entity}</TableHead><TableCell>{run.sourceCounts[entity] ?? 'Not reported'}</TableCell><TableCell>{run.destinationCounts[entity] ?? 'Not reported'}</TableCell><TableCell>{inventory?.targetCounts[entity] ?? 'Not reported'}</TableCell></TableRow>)}</TableBody>
          </Table>
        </TableContainer>
        {inventory ? <><p className='text-sm'>Reconciliation issues: {inventory.totalIssues} · Verified blobs: {inventory.verifiedBlobCount} · Failed blob checks: {inventory.failedBlobCount}</p>{Object.keys(inventory.issueCounts).length > 0 && <ul className='list-disc pl-5 text-sm'>{Object.entries(inventory.issueCounts).map(([code, count]) => <li key={code}><code>{code}</code>: {count}</li>)}</ul>}<h4 className='text-sm font-semibold'>Required external verification</h4><ul className='list-disc pl-5 text-sm'>{inventory.externalGates.map(gate => <li key={gate}>{gate}</li>)}</ul></> : <p className='text-sm'>Record an inventory report with the migration inventory tool before assessing missing entities, conflicts and blob integrity.</p>}
        <details><summary className='cursor-pointer text-xs'>Evidence fingerprints</summary><dl className='break-all text-xs'><dt>Source snapshot</dt><dd>{run.sourceSha256}</dd><dt>Mapping plan</dt><dd>{run.planSha256}</dd>{inventory && <><dt>Inventory</dt><dd>{inventory.inventorySha256}</dd></>}</dl></details>
      </section>;
    })()}
  </CardContent></Card>;
}

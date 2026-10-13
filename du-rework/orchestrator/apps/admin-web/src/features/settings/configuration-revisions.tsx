import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TablePagination, TableRow } from '@/components/ui/table';

export interface ConfigurationRevision {
  revision: number;
  state: 'DRAFT' | 'VALIDATED' | 'APPLIED';
  baseActiveRevision: number | null;
  baseProfileRevision: number;
  createdAt: string;
  appliedAt: string | null;
  restoresRevision: number | null;
  changes: Record<string, unknown>;
  diff: Array<{ path: string; before: unknown; after: unknown }>;
  validation: { valid: boolean; issues: Array<{ code: string; message: string }>; checks: string[] } | null;
}

export interface EffectiveConfiguration {
  activeRevisionMatchesEffective?: boolean;
  activeRevision: number | null;
  profile: { profileId: string; revision: number; activeKeyCount: number; connectorBindings: Record<string, { connectorId: string; revision: number }> } | null;
  historyLimit: number;
  revisions: Array<Pick<ConfigurationRevision, 'revision' | 'state' | 'createdAt' | 'appliedAt' | 'baseActiveRevision'>>;
  selectedRevision?: ConfigurationRevision;
}

export type RevisionCommand = 'validate' | 'apply' | 'rollback';

const PAGE_SIZE = 8;
const display = (value: unknown) => value === undefined
  ? 'Not set'
  : value === null
    ? 'None'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);

export function ConfigurationRevisions({ configuration, scopeLabel, busy, canEdit, onSelect, onCommand }: {
  configuration: EffectiveConfiguration;
  scopeLabel: string;
  busy: boolean;
  canEdit: boolean;
  onSelect: (revision: number) => void;
  onCommand: (command: RevisionCommand, revision: number) => void;
}) {
  const selected = configuration.selectedRevision;
  const hasEffectiveDrift = configuration.activeRevision !== null && configuration.activeRevisionMatchesEffective === false;
  const [confirmation, setConfirmation] = useState<{ command: 'apply' | 'rollback'; revision: number } | null>(null);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(configuration.revisions.length / PAGE_SIZE));
  const visibleRevisions = configuration.revisions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rangeStart = configuration.revisions.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(configuration.revisions.length, (page + 1) * PAGE_SIZE);

  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  return <Card>
    <CardHeader>
      <CardTitle>Configuration revisions</CardTitle>
      <CardDescription>Draft → validate → apply → restore. Validation checks dependencies and policy; it does not call providers. Applying changes affects new submissions only.</CardDescription>
    </CardHeader>
    <CardContent className='space-y-4'>
      <p className='text-sm'>Active configuration: {configuration.activeRevision ?? 'No managed revision'} · Profile {configuration.profile?.profileId ?? 'unavailable'} revision {configuration.profile?.revision ?? 'unavailable'}.</p>
      {hasEffectiveDrift && <p role='status' className='rounded border border-amber-500 p-2 text-sm'>The active revision no longer matches the effective profile or prompt state. Reload and create a fresh draft before changing it.</p>}
      <div className='space-y-2'>
        <h3 className='text-sm font-medium'>Revision history</h3>
        <TableContainer maxHeight={300} aria-label='Configuration revision history'>
          <Table aria-label='Configuration revisions' density='compact'>
            <TableHeader sticky>
              <TableRow><TableHead>Revision</TableHead><TableHead>State</TableHead><TableHead>Created</TableHead><TableHead>Applied</TableHead><TableHead>Base active</TableHead><TableHead>Action</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {visibleRevisions.map((revision) => (
                <TableRow key={revision.revision} data-state={selected?.revision === revision.revision ? 'selected' : undefined} aria-disabled={busy || undefined} onClick={() => { if (busy) return; setConfirmation(null); onSelect(revision.revision); }}>
                  <TableCell className='whitespace-nowrap font-medium'>Revision {revision.revision}{revision.revision === configuration.activeRevision ? ' · current' : ''}</TableCell>
                  <TableCell><Badge variant={revision.state === 'APPLIED' ? 'success' : revision.state === 'DRAFT' ? 'warning' : 'info'}>{revision.state}</Badge></TableCell>
                  <TableCell className='whitespace-nowrap text-xs'>{new Date(revision.createdAt).toLocaleString()}</TableCell>
                  <TableCell className='whitespace-nowrap text-xs'>{revision.appliedAt ? new Date(revision.appliedAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>{revision.baseActiveRevision ?? 'Initial state'}</TableCell>
                  <TableCell>
                    <Button type='button' variant='link' className='h-auto justify-start p-0 text-left' aria-label={`Inspect configuration revision ${revision.revision}`} disabled={busy} onClick={(event) => { event.stopPropagation(); setConfirmation(null); onSelect(revision.revision); }}>Inspect</Button>
                  </TableCell>
                </TableRow>
              ))}
              {configuration.revisions.length === 0 && <TableRow><TableCell colSpan={6} className='py-6 text-center text-[var(--text-sub)]'>No revisions yet. Create a draft using the editor above.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          hasPreviousPage={page > 0}
          hasNextPage={page + 1 < pageCount}
          onPreviousPage={() => setPage((current) => Math.max(0, current - 1))}
          onNextPage={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          pending={busy}
          status={`Showing ${rangeStart}–${rangeEnd} of ${configuration.revisions.length} loaded revisions (history limit ${configuration.historyLimit ?? 20}). Page ${page + 1} of ${pageCount}.`}
          ariaLabel='Configuration revision pagination'
        />
      </div>

      {selected && <section aria-label={`Configuration revision ${selected.revision}`} className='space-y-3'>
        <div className='flex flex-wrap items-center gap-2'><h3 className='font-semibold'>Revision {selected.revision}</h3><Badge variant={selected.state === 'APPLIED' ? 'success' : 'info'}>{selected.state}</Badge></div>
        <p className='break-words text-xs'>Based on configuration {selected.baseActiveRevision ?? 'initial state'} and profile revision {selected.baseProfileRevision}.{selected.restoresRevision !== null ? ` Restores revision ${selected.restoresRevision}.` : ''}</p>
        <TableContainer maxHeight={320} aria-label={`Revision ${selected.revision} change details`}>
          <Table aria-label={`Revision ${selected.revision} changes`} density='compact'>
            <TableHeader sticky><TableRow><TableHead>Setting</TableHead><TableHead>Before</TableHead><TableHead>After</TableHead></TableRow></TableHeader>
            <TableBody>{selected.diff.map(change => <TableRow key={change.path}>
              <TableHead scope='row' className='max-w-56 align-top break-all normal-case tracking-normal'>{change.path}</TableHead>
              <TableCell className='align-top'><pre className='max-h-40 max-w-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs'>{display(change.before)}</pre></TableCell>
              <TableCell className='align-top'><pre className='max-h-40 max-w-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs'>{display(change.after)}</pre></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </TableContainer>
        {selected.diff.length === 0 && <p>No effective changes in this revision.</p>}
        {selected.validation ? <div aria-live='polite'><p className='font-medium'>{selected.validation.valid ? 'Configuration validation passed' : 'Configuration validation needs attention'}</p>{selected.validation.issues.length > 0 && <ul className='list-disc break-words pl-5 text-sm'>{selected.validation.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message} <code>({issue.code})</code></li>)}</ul>}<ul className='list-disc break-words pl-5 text-xs'>{selected.validation.checks.map(check => <li key={check}>{check}</li>)}</ul></div> : <p className='text-sm'>Not yet validated. Review the diff, then validate before applying.</p>}
        <div className='flex flex-wrap gap-2'>
          <Button type='button' variant='outline' disabled={busy || !canEdit || hasEffectiveDrift || selected.state === 'APPLIED'} onClick={() => onCommand('validate', selected.revision)}>Validate configuration</Button>
          <Button type='button' disabled={busy || !canEdit || hasEffectiveDrift || selected.state !== 'VALIDATED' || !selected.validation?.valid} onClick={() => setConfirmation({ command: 'apply', revision: selected.revision })}>Review apply revision {selected.revision}</Button>
          {selected.state === 'APPLIED' && <Button type='button' variant='outline' disabled={busy || !canEdit || hasEffectiveDrift || selected.revision === configuration.activeRevision} onClick={() => setConfirmation({ command: 'rollback', revision: selected.revision })}>Review restore revision {selected.revision}</Button>}
        </div>
        {confirmation && confirmation.revision === selected.revision && <div role='group' aria-labelledby='settings-revision-confirm-title' className='space-y-2 rounded border p-3'>
          <h4 id='settings-revision-confirm-title' className='font-semibold'>{confirmation.command === 'apply' ? 'Confirm configuration apply' : 'Confirm configuration restore'}</h4>
          <p className='break-words text-sm'>{confirmation.command === 'apply' ? `Apply revision ${confirmation.revision} to ${scopeLabel}? Only new submissions use these values.` : `Create a new applied revision from revision ${confirmation.revision} for ${scopeLabel}? Dependency checks run before the restore.`}</p>
          {confirmation.command === 'rollback' && <p className='text-xs'>Existing operations keep their original pins.</p>}
          <div className='flex flex-wrap gap-2'>
            <Button type='button' disabled={busy || !canEdit || hasEffectiveDrift} onClick={() => { const action = confirmation; setConfirmation(null); onCommand(action.command, action.revision); }}>Confirm {confirmation.command === 'apply' ? 'apply' : 'restore'}</Button>
            <Button type='button' variant='outline' disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
          </div>
        </div>}
        {selected.state === 'APPLIED' && selected.revision !== configuration.activeRevision && <p className='text-xs'>Restore creates a new applied revision from this snapshot after checking current dependencies. Existing operations keep their original pins.</p>}
      </section>}
    </CardContent>
  </Card>;
}

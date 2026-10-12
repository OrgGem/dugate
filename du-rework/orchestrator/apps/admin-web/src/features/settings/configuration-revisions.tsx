import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
const display = (value: unknown) => value === undefined ? 'Not set' : value === null ? 'None' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

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
  return <Card><CardHeader><CardTitle>Configuration revisions</CardTitle><CardDescription>Draft → validate → apply → restore. Validation checks dependencies and policy; it does not call providers. Applying changes affects new submissions only.</CardDescription></CardHeader><CardContent className='space-y-4'>
    <p className='text-sm'>Active configuration: {configuration.activeRevision ?? 'No managed revision'} · Profile {configuration.profile?.profileId ?? 'unavailable'} revision {configuration.profile?.revision ?? 'unavailable'}.</p>
    {hasEffectiveDrift && <p role='status' className='rounded border border-amber-500 p-2 text-sm'>The active revision no longer matches the effective profile or prompt state. Reload and create a fresh draft before changing it.</p>}
    <label htmlFor='settings-revision-history' className='block text-sm'>Revision history<select id='settings-revision-history' className='block w-full min-w-0 rounded border p-2' disabled={busy} value={selected?.revision ?? ''} onChange={event => { setConfirmation(null); if (event.target.value) onSelect(Number(event.target.value)); }}><option value=''>Select a revision to inspect</option>{configuration.revisions.map(revision => <option key={revision.revision} value={revision.revision}>Revision {revision.revision} · {revision.state} · {new Date(revision.createdAt).toLocaleString()}{revision.revision === configuration.activeRevision ? ' · current' : ''}</option>)}</select></label>
    <p className='text-xs'>Showing the latest {configuration.historyLimit ?? 20} revisions for this key and endpoint.</p>
    {configuration.revisions.length === 0 && <p className='text-sm'>No revisions yet. Create a draft using the editor above.</p>}
    {selected && <section aria-label={`Configuration revision ${selected.revision}`} className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'><h3 className='font-semibold'>Revision {selected.revision}</h3><Badge variant={selected.state === 'APPLIED' ? 'success' : 'info'}>{selected.state}</Badge></div>
      <p className='text-xs'>Based on configuration {selected.baseActiveRevision ?? 'initial state'} and profile revision {selected.baseProfileRevision}.{selected.restoresRevision !== null ? ` Restores revision ${selected.restoresRevision}.` : ''}</p>
      <div className='overflow-x-auto' role='region' aria-label={`Revision ${selected.revision} change details`} tabIndex={0}><table className='w-full min-w-[36rem] text-sm'><thead><tr className='text-left'><th scope='col' className='p-2'>Setting</th><th scope='col' className='p-2'>Before</th><th scope='col' className='p-2'>After</th></tr></thead><tbody>{selected.diff.map(change => <tr key={change.path} className='border-t'><th scope='row' className='p-2 align-top break-all text-left font-normal'>{change.path}</th><td className='p-2 align-top'><pre className='max-w-sm whitespace-pre-wrap break-all'>{display(change.before)}</pre></td><td className='p-2 align-top'><pre className='max-w-sm whitespace-pre-wrap break-all'>{display(change.after)}</pre></td></tr>)}</tbody></table></div>
      {selected.diff.length === 0 && <p>No effective changes in this revision.</p>}
      {selected.validation ? <div aria-live='polite'><p className='font-medium'>{selected.validation.valid ? 'Configuration validation passed' : 'Configuration validation needs attention'}</p>{selected.validation.issues.length > 0 && <ul className='list-disc pl-5 text-sm'>{selected.validation.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message} <code>({issue.code})</code></li>)}</ul>}<ul className='list-disc pl-5 text-xs'>{selected.validation.checks.map(check => <li key={check}>{check}</li>)}</ul></div> : <p className='text-sm'>Not yet validated. Review the diff, then validate before applying.</p>}
      <div className='flex flex-wrap gap-2'>
        <Button type='button' variant='outline' disabled={busy || !canEdit || hasEffectiveDrift || selected.state === 'APPLIED'} onClick={() => onCommand('validate', selected.revision)}>Validate configuration</Button>
        <Button type='button' disabled={busy || !canEdit || hasEffectiveDrift || selected.state !== 'VALIDATED' || !selected.validation?.valid} onClick={() => setConfirmation({ command: 'apply', revision: selected.revision })}>Review apply revision {selected.revision}</Button>
        {selected.state === 'APPLIED' && <Button type='button' variant='outline' disabled={busy || !canEdit || hasEffectiveDrift || selected.revision === configuration.activeRevision} onClick={() => setConfirmation({ command: 'rollback', revision: selected.revision })}>Review restore revision {selected.revision}</Button>}
      </div>
      {confirmation && confirmation.revision === selected.revision && <div role='group' aria-labelledby='settings-revision-confirm-title' className='space-y-2 rounded border p-3'>
        <h4 id='settings-revision-confirm-title' className='font-semibold'>{confirmation.command === 'apply' ? 'Confirm configuration apply' : 'Confirm configuration restore'}</h4>
        <p className='text-sm'>{confirmation.command === 'apply' ? `Apply revision ${confirmation.revision} to ${scopeLabel}? Only new submissions use these values.` : `Create a new applied revision from revision ${confirmation.revision} for ${scopeLabel}? Dependency checks run before the restore.`}</p>
        {confirmation.command === 'rollback' && <p className='text-xs'>Existing operations keep their original pins.</p>}
        <div className='flex flex-wrap gap-2'>
          <Button type='button' disabled={busy || !canEdit || hasEffectiveDrift} onClick={() => { const action = confirmation; setConfirmation(null); onCommand(action.command, action.revision); }}>Confirm {confirmation.command === 'apply' ? 'apply' : 'restore'}</Button>
          <Button type='button' variant='outline' disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
        </div>
      </div>}
      {selected.state === 'APPLIED' && selected.revision !== configuration.activeRevision && <p className='text-xs'>Restore creates a new applied revision from this snapshot after checking current dependencies. Existing operations keep their original pins.</p>}
    </section>}
  </CardContent></Card>;
}

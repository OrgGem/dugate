import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { createAdminApiClient } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { loadConnectorPinOptions, type ConnectorPinOption } from './connector-pin-options';
export type InitialBinding = { slot: string; connectorId: string; revision: number };
export function InitialBindings({ value, onChange }: { value: InitialBinding[]; onChange: (rows: InitialBinding[]) => void }) {
  const { tenantId } = useTenant();
  const [options, setOptions] = useState<ConnectorPinOption[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    if (!tenantId) {
      setOptions([]);
      setError('Choose a tenant to read its Connector revisions.');
      return () => { current = false; };
    }
    setError('');
    void loadConnectorPinOptions(createAdminApiClient(), tenantId).then((catalog) => {
      if (!current) return;
      setOptions(catalog.items);
      setError(catalog.problem ?? '');
    }).catch(() => {
      if (current) setError('Connector catalog unavailable.');
    });
    return () => { current = false; };
  }, [tenantId]);
  return <section className="min-w-0 space-y-3">
    <div>
      <h3 className="font-medium">Initial connector bindings</h3>
      <p className="text-sm">Use the slot names required by the business manifest or workflow schema. Select a configured connector revision for every required slot. <Link className="underline" to="/connectors">Manage connectors</Link></p>
    </div>
    {error && <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{error}</p>}
    {value.map((row, index) => <div className="grid min-w-0 grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1.5fr)_auto]" key={index}>
      <label className="min-w-0 text-xs font-medium">Connector slot
        <input aria-label={`Connector slot ${index+1}`} className="mt-1 h-9 w-full min-w-0 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" placeholder="Slot name, e.g. reasoning" value={row.slot} onChange={e => onChange(value.map((r,i) => i === index ? { ...r, slot:e.target.value } : r))} />
      </label>
      <label className="min-w-0 text-xs font-medium">Connector revision
        <select aria-label={`Connector revision ${index+1}`} className="mt-1 h-9 w-full min-w-0 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={row.connectorId ? `${row.connectorId}@${row.revision}` : ''} onChange={e => { const selected=options.find(c => `${c.connectorId}@${c.revision}`===e.target.value); if(selected) onChange(value.map((r,i) => i===index?{...r,connectorId:selected.connectorId,revision:selected.revision}:r)); }}><option value="">Select connector revision</option>{options.map(c => <option key={`${c.connectorId}@${c.revision}`} value={`${c.connectorId}@${c.revision}`}>{c.connectorId} · revision {c.revision}{c.provider ? ` · ${c.provider}` : ''}{c.model ? ` · ${c.model}` : ''}</option>)}</select>
      </label>
      <div className="pt-5 sm:pt-[1.35rem]"><Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => onChange(value.filter((_,i)=>i!==index))}>Remove slot</Button></div>
    </div>)}
    <Button size="sm" variant="outline" onClick={() => onChange([...value,{slot:'',connectorId:'',revision:1}])}>Add connector slot</Button>
  </section>;
}

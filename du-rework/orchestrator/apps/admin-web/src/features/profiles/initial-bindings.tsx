import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { createAdminApiClient, type ConnectorManagementRevision } from '@/lib/api';
import { parseConnectorList } from '@/features/connectors/state';
export type InitialBinding = { slot: string; connectorId: string; revision: number };
export function InitialBindings({ value, onChange }: { value: InitialBinding[]; onChange: (rows: InitialBinding[]) => void }) {
  const [options, setOptions] = useState<ConnectorManagementRevision[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { let current = true; void createAdminApiClient().listConnectors().then(result => { if (!current) return; const parsed = result.ok ? parseConnectorList(result.data) : null; if (parsed) setOptions(parsed.items.filter(c => c.state === 'ACTIVE')); else setError('Connector catalog unavailable. Open Connectors to configure a revision.'); }).catch(() => { if (current) setError('Connector catalog unavailable.'); }); return () => { current = false; }; }, []);
  return <section className="space-y-2"><h3 className="font-medium">Initial connector bindings</h3><p className="text-sm">Use the slot names required by the business manifest or workflow schema. Select a configured connector revision for every required slot. <Link className="underline" to="/connectors">Manage connectors</Link></p>{error && <p role="alert">{error}</p>}
    {value.map((row, index) => <div className="flex flex-wrap gap-2" key={index}><input aria-label={`Connector slot ${index+1}`} className="border rounded p-2" placeholder="Slot name, e.g. reasoning" value={row.slot} onChange={e => onChange(value.map((r,i) => i === index ? { ...r, slot:e.target.value } : r))} /><select aria-label={`Connector revision ${index+1}`} className="border rounded p-2 max-w-full" value={row.connectorId ? `${row.connectorId}@${row.revision}` : ''} onChange={e => { const selected=options.find(c => `${c.connectorId}@${c.revision}`===e.target.value); if(selected) onChange(value.map((r,i) => i===index?{...r,connectorId:selected.connectorId,revision:selected.revision}:r)); }}><option value="">Select connector revision</option>{options.map(c => <option key={`${c.connectorId}@${c.revision}`} value={`${c.connectorId}@${c.revision}`}>{c.connectorId} · revision {c.revision}</option>)}</select><Button size="sm" variant="outline" onClick={() => onChange(value.filter((_,i)=>i!==index))}>Remove slot</Button></div>)}
    <Button size="sm" variant="outline" onClick={() => onChange([...value,{slot:'',connectorId:'',revision:1}])}>Add connector slot</Button>
  </section>;
}

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';
import { IncidentsConsole } from '@/features/system-operations/incidents-console';
import { OperationsWorkspace, type OperationsSection } from '@/features/system-operations/operations-workspace';
import { SystemOperationsScreen } from '@/features/system-operations/system-operations-screen';

/** Route entry for system projections and bounded, preview-first Compose operations. */
export function SystemOperationsRoute() {
  const { section } = useParams();
  return section ? <SystemOperationsSection section={section} /> : <SystemOperationsScreen />;
}

function SystemOperationsSection({ section }: { section: string }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<{ kind: 'loading' } | { kind: 'ready'; data: AdminWebSession } | { kind: 'error'; message: string }>({ kind: 'loading' });
  const operationsSections: OperationsSection[] = ['services', 'workers-queues', 'deployments', 'maintenance'];

  useEffect(() => {
    let active = true;
    setSession({ kind: 'loading' });
    void client.getSession().then((result) => {
      if (!active) return;
      setSession(result.ok ? { kind: 'ready', data: result.data } : { kind: 'error', message: result.problem.title ?? `HTTP ${result.status}` });
    }).catch(() => { if (active) setSession({ kind: 'error', message: 'Admin session could not be read.' }); });
    return () => { active = false; };
  }, [client]);

  if (session.kind === 'loading') return <LoadingState title="Checking Admin session" description="The server authorized scope is checked before reading operational details." />;
  if (session.kind === 'error') return <ErrorState title="Admin session unavailable" description={session.message} />;
  if (section === 'incidents') return <IncidentsConsole session={session.data} />;
  if (operationsSections.includes(section as OperationsSection)) return <OperationsWorkspace key={`${section}:${session.data.principal.kind}:${session.data.principal.tenantId ?? ''}`} section={section as OperationsSection} session={session.data} />;
  return <ErrorState title="Unknown system operations page" description={`No system operations screen is registered for “${section}”.`} />;
}

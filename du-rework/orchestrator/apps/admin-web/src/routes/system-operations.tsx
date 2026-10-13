import { useEffect, useMemo, useState } from 'react';
import { NavLink, useOutletContext, useParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';
import type { AppShellOutletContext } from '@/app-shell/app-shell';
import { IncidentsConsole } from '@/features/system-operations/incidents-console';
import { OperationsWorkspace, type OperationsSection } from '@/features/system-operations/operations-workspace';
import { SystemOperationsScreen } from '@/features/system-operations/system-operations-screen';
import { canReadIncidentLedger } from '@/features/system-operations/state';

const SYSTEM_OPERATIONS_PAGES = [
  ['Cockpit', 'cockpit', '/system-operations'],
  ['Services', 'services', '/system-operations/services'],
  ['Workers & Queues', 'workers-queues', '/system-operations/workers-queues'],
  ['Incidents', 'incidents', '/system-operations/incidents'],
  ['Deployments', 'deployments', '/system-operations/deployments'],
  ['Maintenance', 'maintenance', '/system-operations/maintenance'],
] as const;

/** Route entry for system projections and bounded, preview-first Compose operations. */
export function SystemOperationsRoute() {
  const { section } = useParams();
  const { session } = useOutletContext<AppShellOutletContext>();
  const activePage = section ?? 'cockpit';
  const pages = SYSTEM_OPERATIONS_PAGES.filter(([, key]) => key !== 'incidents' || canReadIncidentLedger(session));
  return <section className="flex min-w-0 flex-col gap-4">
    <nav aria-label="System operations pages" className="flex min-w-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2">
      {pages.map(([label, key, href]) => <NavLink key={key} to={href} end className={({ isActive }) => `shrink-0 rounded-md px-3 py-2 text-sm no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${isActive || activePage === key ? 'bg-[var(--cf-blue-light)] font-semibold text-[var(--cf-blue)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>{label}</NavLink>)}
    </nav>
    {section ? <SystemOperationsSection section={section} /> : <SystemOperationsScreen />}
  </section>;
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

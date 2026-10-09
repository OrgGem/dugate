import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { AppShellLayout, AppShellHeader, AppShellBrand, AppShellMain } from '@/components/ui/app-shell-primitives';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { GlobalErrorBoundary, ToastProvider } from '@/components/ui/toast';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';
import type { AdminHealthSnapshot } from '@/lib/api/client';
import { TenantProvider } from '@/lib/tenant-context';
import { GlobalTenantSelector } from '@/components/ui/global-tenant-selector';

const HEALTH_POLL_INTERVAL_MS = 30_000;
const HEALTH_STALE_AFTER_MS = 60_000;

const NAV = [
  { label: 'Workspace', items: [['Overview', '/overview'], ['Operations', '/operations'], ['Usage', '/usage']] },
  { label: 'Configuration', items: [['Businesses', '/businesses'], ['Profiles', '/profiles'], ['Connectors', '/connectors'], ['Workflows', '/workflows']] },
  { label: 'Administration', items: [['API keys', '/api-keys'], ['Security', '/security'], ['Secrets', '/secrets'], ['Identity', '/identity'], ['Settings', '/settings']] },
  { label: 'Resources', items: [['API Reference', '/api-docs'], ['Documentation', '/docs'], ['Bootstrap', '/']] },
] as const;

export function AppShell() {
  return (
    <GlobalErrorBoundary>
      <ToastProvider>
        <TenantProvider>
          <AppShellContent />
        </TenantProvider>
      </ToastProvider>
    </GlobalErrorBoundary>
  );
}

function AppShellContent() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [health, setHealth] = useState<AdminHealthSnapshot | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [profileOpen, setProfileOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void client.getSession().then((result) => {
      if (!active) return;
      setSession(result.ok ? result.data : null);
      setSessionFailed(!result.ok);
    });
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refreshHealth = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await client.getHealth();
        if (!active) return;
        if (result.ok) {
          setHealth(result.data);
          setHealthFailed(false);
        } else {
          setHealthFailed(true);
        }
      } catch {
        if (active) setHealthFailed(true);
      } finally {
        inFlight = false;
      }
    };
    void refreshHealth();
    const timer = window.setInterval(() => void refreshHealth(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client]);

  const sampledAtMs = health === null ? Number.NaN : Date.parse(health.sampledAt);
  const sampleAgeMs = Number.isFinite(sampledAtMs) ? Math.max(0, now.getTime() - sampledAtMs) : Number.NaN;
  const staleHealth = health !== null && (healthFailed || !Number.isFinite(sampleAgeMs) || sampleAgeMs > HEALTH_STALE_AFTER_MS);
  const overallHealth = health?.status ?? (healthFailed ? 'unavailable' : 'checking');

  return (
    <AppShellLayout>
      <a href="#admin-content" className="sr-only focus:not-sr-only focus:p-3">Skip to content</a>
      <AppShellHeader className="justify-between">
        <AppShellBrand title="Orchestrator Portal" />
        <time dateTime={now.toISOString()} className="text-xs text-[var(--text-muted)] tabular-nums">
          {now.toLocaleString()} <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        </time>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" disabled={session === null} onClick={() => setProfileOpen(true)}>
            {session?.displayName || (sessionFailed ? 'Session unavailable' : 'Loading account…')}
            {session !== null ? ' · Profile' : ''}
          </Button>
          <form method="post" action="/admin/logout">
            <Button variant="outline" size="sm" type="submit">Logout</Button>
          </form>
        </div>
      </AppShellHeader>
      <section aria-label="System health" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-2 text-xs text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text-main)]">System health: {overallHealth}</span>
        <span>Database: {health === null || health.db === null ? 'Unavailable' : health.db ? 'Healthy' : 'Unhealthy'}</span>
        <span>Redis: {health === null || health.redis === null ? 'Unavailable' : health.redis ? 'Healthy' : 'Unhealthy'}</span>
        <span>Queue integrity: {health?.queueIntegrity?.state ?? 'Unavailable'}</span>
        <span>Active leases: {health?.activeLeases === null || health === null ? 'Unavailable' : health.activeLeases.toLocaleString()}</span>
        <span>Outbox backlog: {health?.outboxBacklog === null || health === null ? 'Unavailable' : health.outboxBacklog.toLocaleString()}</span>
        <span>
          {Number.isFinite(sampleAgeMs)
            ? `Sampled ${Math.floor(sampleAgeMs / 1000)}s ago${staleHealth ? ' · stale' : ''}`
            : healthFailed ? 'Sample unavailable' : 'Waiting for first sample'}
        </span>
        <NavLink to="/overview" className="font-medium text-[var(--text-main)] underline underline-offset-2">Health details</NavLink>
      </section>
      <div className="flex flex-1 min-w-0 flex-col md:flex-row">
        <aside className="w-full shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] md:w-56 md:border-b-0 md:border-r">
          <div className="p-3 md:hidden">
            <Button variant="outline" className="w-full" aria-expanded={navOpen} aria-controls="admin-navigation" onClick={() => setNavOpen(!navOpen)}>
              {navOpen ? 'Close navigation' : 'Open navigation'}
            </Button>
          </div>
          <nav id="admin-navigation" aria-label="Orchestrator Portal Navigation" className={`${navOpen ? 'block' : 'hidden'} p-3 md:block md:sticky md:top-20 md:max-h-[calc(100dvh-5rem)] md:overflow-y-auto`}>
            <GlobalTenantSelector />
            {NAV.map((group) => (
              <div key={group.label} className="mb-4">
                <p className="px-3 pb-1 text-xs font-semibold text-[var(--text-sub)]">{group.label}</p>
                {group.items.map(([label, href]) => (
                  <NavLink key={href} to={href} end onClick={() => setNavOpen(false)} className={({ isActive }) =>
                    'block rounded-[var(--radius-sm)] px-3 py-2 text-sm no-underline ' + (isActive
                      ? 'bg-[var(--cf-blue-light)] font-semibold text-[var(--cf-blue)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]')
                  }>{label}</NavLink>
                ))}
              </div>
            ))}
            <a
              href="/admin/legacy"
              className="mt-3 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--cf-blue)] bg-[var(--cf-blue-light)] px-3 py-2 text-xs font-semibold text-[var(--cf-blue)] no-underline hover:opacity-80"
            >
              <span>Legacy Admin Shell</span>
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current" strokeWidth="1.5">
                <path d="M9.5 2.5h4v4M13.25 2.75 7 9M12 8.5v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </nav>
        </aside>
        <AppShellMain id="admin-content" tabIndex={-1} className="max-w-none md:px-8">
          <Outlet />
        </AppShellMain>
      </div>
      <Modal open={profileOpen} onOpenChange={setProfileOpen} title="My profile" description="Account information from your current session.">
        {session !== null ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>Name</dt><dd>{session.displayName}</dd>
            <dt>Role</dt><dd>{session.role}</dd>
            <dt>Scope</dt><dd>{session.scope?.kind === 'tenant' ? session.scope.tenantId : session.scope?.kind ?? 'Unscoped'}</dd>
          </dl>
        ) : null}
      </Modal>
    </AppShellLayout>
  );
}

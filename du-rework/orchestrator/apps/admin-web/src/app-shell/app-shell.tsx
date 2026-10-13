import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { AppShellLayout, AppShellHeader, AppShellBrand, AppShellMain } from '@/components/ui/app-shell-primitives';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { GlobalErrorBoundary, ToastProvider } from '@/components/ui/toast';
import { ADMIN_AUTH_EXPIRED_EVENT, createAdminApiClient, type AdminWebSession } from '@/lib/api';
import type { AdminHealthSnapshot } from '@/lib/api/client';
import { TenantProvider } from '@/lib/tenant-context';
import { GlobalTenantSelector } from '@/components/ui/global-tenant-selector';
import { ADMIN_AUTH_RESTORED_EVENT } from './session-events';

const HEALTH_POLL_INTERVAL_MS = 30_000;
const HEALTH_STALE_AFTER_MS = 60_000;

const NAV = [
  { label: 'Workspace', items: [['Overview', '/overview'], ['Trace', '/trace'], ['System operations', '/system-operations'], ['Usage', '/usage']] },
  { label: 'Configuration', items: [['Businesses', '/businesses'], ['Profiles', '/profiles'], ['Connectors', '/connectors'], ['Workflows', '/workflows']] },
  { label: 'Administration', items: [['Access & security', '/security'], ['Audit', '/audit'], ['Settings', '/settings']] },
  { label: 'Resources', items: [['API Reference', '/api-docs'], ['Bootstrap', '/']] },
] as const;

const ACCESS_SECURITY_ROUTES = [
  ['Security', '/security'],
  ['Identity', '/identity'],
  ['API Keys', '/api-keys'],
  ['Secrets', '/secrets'],
] as const;

const DOCUMENTATION_ROUTES = [
  ['API Reference', '/api-docs'],
  ['Documentation', '/docs'],
] as const;

export interface AppShellOutletContext {
  session: AdminWebSession | null;
}

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
  const location = useLocation();
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [sessionChecking, setSessionChecking] = useState(false);
  const [health, setHealth] = useState<AdminHealthSnapshot | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [profileOpen, setProfileOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const sessionRecoveryRef = useRef<HTMLButtonElement>(null);
  const sessionExpiredRef = useRef(false);
  const sessionCheckInFlightRef = useRef(false);
  const authExpiryGenerationRef = useRef(0);
  const canReadPlatformHealth = session?.role === 'admin'
    && session.principal.kind === 'platform'
    && session.scope?.kind === 'platform'
    && !sessionExpired;
  const inertRegionProps = sessionExpired ? { inert: '' } : {};

  const verifySession = useCallback(async () => {
    if (sessionCheckInFlightRef.current) return;
    sessionCheckInFlightRef.current = true;
    const expiryGeneration = authExpiryGenerationRef.current;
    setSessionChecking(true);
    try {
      const result = await client.getSession({ recoverAuth: true });
      if (!result.ok) {
        setSession(null);
        setSessionFailed(true);
        if (result.status === 409 && result.problem.code === 'SESSION_CHANGED') {
          setSessionChanged(true);
          setSessionExpired(true);
          return;
        }
        setSessionExpired(result.status === 401 || sessionExpiredRef.current);
        return;
      }
      if (authExpiryGenerationRef.current !== expiryGeneration) {
        setSession(null);
        setSessionFailed(true);
        setSessionExpired(true);
        return;
      }
      sessionExpiredRef.current = false;
      setSession(result.data);
      setSessionFailed(false);
      setSessionExpired(false);
      setSessionChanged(false);
      window.dispatchEvent(new Event(ADMIN_AUTH_RESTORED_EVENT));
    } catch {
      setSessionFailed(true);
    } finally {
      sessionCheckInFlightRef.current = false;
      setSessionChecking(false);
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const handleAuthExpired = () => {
      if (!active) return;
      authExpiryGenerationRef.current += 1;
      sessionExpiredRef.current = true;
      setSession(null);
      setSessionFailed(true);
      setSessionExpired(true);
      setSessionChanged(false);
      setHealth(null);
      setHealthFailed(true);
    };
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handleAuthExpired);
    void client.getSession().then((result) => {
      if (!active) return;
      const expired = result.status === 401 || sessionExpiredRef.current;
      sessionExpiredRef.current = expired;
      setSession(result.ok && !expired ? result.data : null);
      setSessionFailed(!result.ok);
      setSessionExpired(expired);
    });
    return () => {
      active = false;
      window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handleAuthExpired);
    };
  }, [client]);

  useEffect(() => {
    if (sessionExpired) sessionRecoveryRef.current?.focus();
  }, [sessionExpired]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!canReadPlatformHealth) {
      setHealth(null);
      setHealthFailed(false);
      return undefined;
    }
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
  }, [client, canReadPlatformHealth]);

  const sampledAtMs = health === null ? Number.NaN : Date.parse(health.sampledAt);
  const sampleAgeMs = Number.isFinite(sampledAtMs) ? Math.max(0, now.getTime() - sampledAtMs) : Number.NaN;
  const staleHealth = health !== null && (healthFailed || !Number.isFinite(sampleAgeMs) || sampleAgeMs > HEALTH_STALE_AFTER_MS);
  const overallHealth = staleHealth
    ? `stale · last reported ${health?.status ?? 'unknown'}`
    : health?.status ?? (healthFailed ? 'unavailable' : 'checking');
  const accessSecurityActive = ACCESS_SECURITY_ROUTES.some(([, href]) => location.pathname === href);
  const documentationActive = DOCUMENTATION_ROUTES.some(([, href]) => location.pathname === href);
  const contextRoutes = accessSecurityActive
    ? ACCESS_SECURITY_ROUTES.filter(([label]) => label !== 'API Keys' || (session?.role === 'admin' && session.principal.kind === 'platform'))
    : documentationActive
      ? DOCUMENTATION_ROUTES
      : null;

  function closeMobileNavigation(): void {
    setNavOpen(false);
    if (window.matchMedia('(max-width: 1023px)').matches) {
      window.requestAnimationFrame(() => navToggleRef.current?.focus());
    }
  }

  return (
    <AppShellLayout>
      <a href="#admin-content" className="sr-only focus:not-sr-only focus:p-3">Skip to content</a>
      <AppShellHeader className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <AppShellBrand title="Orchestrator Portal" className="shrink-0 lg:hidden" />
          <time dateTime={now.toISOString()} className="max-w-full break-words text-right text-xs text-[var(--text-muted)] tabular-nums sm:text-left">
            {now.toLocaleString()} <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          </time>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <Button variant="ghost" size="sm" className="min-w-0 flex-1 sm:flex-none" disabled={session === null} onClick={() => setProfileOpen(true)}>
            <span className="min-w-0 max-w-[calc(100vw-13rem)] truncate sm:max-w-[12rem]">{session?.displayName || (sessionExpired ? 'Session expired' : sessionFailed ? 'Session unavailable' : 'Loading account…')}</span>
            {session !== null ? <span className="shrink-0"> · Profile</span> : null}
          </Button>
          <form method="post" action="/admin/logout" className="shrink-0">
            <input type="hidden" name="csrf" value={session?.csrfToken ?? ''} />
            <Button variant="outline" size="sm" type="submit" disabled={session === null}>Logout</Button>
          </form>
        </div>
      </AppShellHeader>
      <section aria-label="Platform health" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-2 text-xs text-[var(--text-muted)]">
        {sessionExpired ? (
          <div role="alert" className="flex w-full flex-wrap items-center gap-2">
            {sessionChanged ? (
              <>
                <span className="font-semibold text-[var(--badge-warning-text)]">The signed-in role or tenant scope changed. Protected requests remain locked.</span>
                <span>Reload under the new scope to continue. Any unsaved request draft stays on this page until you choose reload.</span>
                <Button ref={sessionRecoveryRef} size="sm" variant="outline" onClick={() => window.location.reload()}>
                  Reload under new scope
                </Button>
              </>
            ) : (
              <>
                <span className="font-semibold text-[var(--badge-warning-text)]">Admin session expired. Protected reads and actions are paused.</span>
                <a href="/admin/login" target="_blank" rel="noreferrer" className="font-medium text-[var(--cf-blue)] underline underline-offset-2">Sign in in another tab</a>
                <Button ref={sessionRecoveryRef} size="sm" variant="outline" isLoading={sessionChecking} onClick={() => void verifySession()}>
                  Verify session
                </Button>
                <span>Keeping this page open preserves any non-secret request draft.</span>
              </>
            )}
          </div>
        ) : canReadPlatformHealth ? (
          <>
            <span className="font-semibold text-[var(--text-main)]">Platform health: {overallHealth}</span>
            <span>Database: {health === null || health.db === null ? 'Unknown' : staleHealth ? `Stale · last ${health.db ? 'healthy' : 'unhealthy'}` : health.db ? 'Healthy' : 'Unhealthy'}</span>
            <span>Redis: {health === null || health.redis === null ? 'Unknown' : staleHealth ? `Stale · last ${health.redis ? 'healthy' : 'unhealthy'}` : health.redis ? 'Healthy' : 'Unhealthy'}</span>
            <span>Queue integrity: {health === null || health.queueIntegrity === null ? 'Unknown' : staleHealth ? `Stale · last ${health.queueIntegrity.state}` : health.queueIntegrity.state}</span>
            <span>Active leases: {health?.activeLeases === null || health === null ? 'Unknown' : staleHealth ? `Stale · last ${health.activeLeases.toLocaleString()}` : health.activeLeases.toLocaleString()}</span>
            <span>Outbox backlog: {health?.outboxBacklog === null || health === null ? 'Unknown' : staleHealth ? `Stale · last ${health.outboxBacklog.toLocaleString()}` : health.outboxBacklog.toLocaleString()}</span>
            <span>
              {Number.isFinite(sampleAgeMs)
                ? `Sampled ${Math.floor(sampleAgeMs / 1000)}s ago${staleHealth ? ' · stale after refresh failure or age limit' : ''}`
                : healthFailed ? 'Sample unavailable' : 'Waiting for first sample'}
            </span>
            <NavLink to="/system-operations/services" className="font-medium text-[var(--text-main)] underline underline-offset-2">Health details</NavLink>
          </>
        ) : session === null ? (
          <span>{sessionFailed ? 'Admin session unavailable. Sign in to load protected system data.' : 'Resolving the Admin session before loading protected system data…'}</span>
        ) : (
          <span>Platform health details are restricted to platform administrators.</span>
        )}
      </section>
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <aside {...inertRegionProps} aria-hidden={sessionExpired || undefined} className="w-full shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] lg:sticky lg:top-0 lg:h-[100dvh] lg:w-60 lg:self-start lg:overflow-hidden lg:border-b-0 lg:border-r">
          <nav
            id="admin-navigation"
            aria-label="Orchestrator Portal Navigation"
            className="flex min-h-0 flex-col lg:h-full"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && navOpen) {
                closeMobileNavigation();
              }
            }}
          >
            <div className="hidden shrink-0 border-b border-[var(--border-subtle)] px-5 py-4 lg:block">
              <AppShellBrand title="Orchestrator Portal" />
            </div>
            <div className="shrink-0">
              <GlobalTenantSelector />
            </div>
            <div className="px-3 pb-3 lg:hidden">
              <Button ref={navToggleRef} variant="outline" className="w-full" aria-expanded={navOpen} aria-controls="admin-navigation-links" onClick={() => setNavOpen(!navOpen)}>
                {navOpen ? 'Close navigation' : 'Open navigation'}
              </Button>
            </div>
            <div
              id="admin-navigation-links"
              aria-label="Navigation links"
              tabIndex={0}
              className={`${navOpen ? 'block' : 'hidden'} min-w-0 p-3 lg:block lg:min-h-0 lg:flex-1 lg:overflow-y-auto`}
            >
              {NAV.map((group, index) => (
                <section key={group.label} aria-labelledby={`admin-navigation-group-${index}`} className="mb-5 last:mb-0">
                  <h2 id={`admin-navigation-group-${index}`} className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]">{group.label}</h2>
                  <ul className="ml-5 space-y-0.5 border-l-2 border-[var(--border-subtle)] pl-4">
                    {group.items.map(([label, href]) => (
                      <li key={href}>
                        <NavLink to={href} end={href !== '/system-operations'} onClick={closeMobileNavigation} className={({ isActive }) => {
                          const contextActive = href === '/security' && accessSecurityActive || href === '/api-docs' && documentationActive;
                          return 'ml-1 block rounded-[var(--radius-sm)] px-3 py-2 text-sm no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ' + (isActive || contextActive
                            ? 'bg-[var(--cf-blue-light)] font-semibold text-[var(--cf-blue)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]');
                        }}>{label}</NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </nav>
        </aside>
        <AppShellMain {...inertRegionProps} aria-hidden={sessionExpired || undefined} id="admin-content" tabIndex={-1} className="max-w-none px-4 py-4 sm:px-5 md:px-6 lg:px-8">
          {contextRoutes ? <nav aria-label={accessSecurityActive ? 'Access and security pages' : 'Resource pages'} className="mb-5 flex min-w-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2">
            {contextRoutes.map(([label, href]) => <NavLink key={href} to={href} end className={({ isActive }) => 'shrink-0 rounded-md px-3 py-2 text-sm no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ' + (isActive ? 'bg-[var(--cf-blue-light)] font-semibold text-[var(--cf-blue)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]')}>{label}</NavLink>)}
          </nav> : null}
          <Outlet context={{ session } satisfies AppShellOutletContext} />
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

import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { AppShellLayout, AppShellHeader, AppShellBrand, AppShellMain } from '@/components/ui/app-shell-primitives';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';

const NAV = [
  { label: 'Workspace', items: [['Overview', '/overview'], ['Operations', '/operations'], ['Usage', '/usage']] },
  { label: 'Configuration', items: [['Businesses', '/businesses'], ['Profiles', '/profiles'], ['Connectors', '/connectors'], ['Workflows', '/workflows']] },
  { label: 'Administration', items: [['API keys', '/api-keys'], ['Security', '/security'], ['Identity', '/identity'], ['Settings', '/settings']] },
  { label: 'Resources', items: [['API Reference', '/api-docs'], ['Documentation', '/docs'], ['Bootstrap', '/']] },
] as const;

export function AppShell() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
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
      <div className="flex flex-1 min-w-0 flex-col md:flex-row">
        <aside className="w-full shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] md:w-56 md:border-b-0 md:border-r">
          <div className="p-3 md:hidden">
            <Button variant="outline" className="w-full" aria-expanded={navOpen} aria-controls="admin-navigation" onClick={() => setNavOpen(!navOpen)}>
              {navOpen ? 'Close navigation' : 'Open navigation'}
            </Button>
          </div>
          <nav id="admin-navigation" aria-label="Orchestrator Portal Navigation" className={`${navOpen ? 'block' : 'hidden'} p-3 md:block md:sticky md:top-20 md:max-h-[calc(100dvh-5rem)] md:overflow-y-auto`}>
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
            <a href="/admin" className="block px-3 py-2 text-xs text-[var(--text-sub)]">Legacy shell</a>
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

import { useEffect, useState } from 'react';
import { Link, useLoaderData } from 'react-router';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';

interface BootstrapLoaderData {
  mountedAt: string;
  mode: string;
}

type SessionState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: AdminWebSession }
  | { kind: 'error'; problem: AdminApiProblem };

/**
 * Trial route for AWEB-01/AWEB-02 — reads the REAL session through the typed
 * BFF client (same-origin `/admin/api/session`, no-store). It proves the
 * session/CSRF bootstrap; business screens land in AWEB-03+ behind the same
 * client.
 */
export function BootstrapHome() {
  const data = useLoaderData() as BootstrapLoaderData;
  const [state, setState] = useState<SessionState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    const client = createAdminApiClient();
    void client.getSession().then((result) => {
      if (!active) return;
      setState(
        result.ok
          ? { kind: 'ready', session: result.data }
          : { kind: 'error', problem: result.problem },
      );
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="bootstrap-title">
      <h1 id="bootstrap-title" className="text-lg font-semibold">
        Orchestrator Portal bootstrap is running
      </h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        This route is served by the Orchestrator Backend behind the server-side
        per-route flag <code>DU_ADMIN_WEB</code> (default off). The legacy rendered
        shell at <code>/admin</code> is untouched and remains the default surface.
      </p>

      <p className="mt-3 max-w-prose text-sm">
        <Link className="text-action underline" to="/overview">
          Open the read-only Overview (session + audit via the BFF) →
        </Link>
      </p>

      <h2 className="mt-6 text-base font-semibold">Session (live from /admin/api/session)</h2>
      <div className="mt-2 max-w-prose rounded-sm border border-line bg-card p-3 text-sm" aria-live="polite">
        {state.kind === 'loading' ? <p className="text-ink-sub">Loading session…</p> : null}
        {state.kind === 'ready' ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-sub">Principal</dt>
            <dd>
              <code>{state.session.displayName}</code> ({state.session.principal.kind})
            </dd>
            <dt className="text-ink-sub">Role</dt>
            <dd>
              <code>{state.session.role}</code> · auth plane <code>{state.session.plane}</code>
            </dd>
            <dt className="text-ink-sub">Tenant scope</dt>
            <dd>
              {state.session.scope === null ? (
                <span>none (no admin principal)</span>
              ) : state.session.scope.kind === 'platform' ? (
                <span>platform (may narrow per request)</span>
              ) : (
                <code>{state.session.scope.tenantId}</code>
              )}
            </dd>
            <dt className="text-ink-sub">CSRF</dt>
            <dd>server-issued for this session (sent only on mutations)</dd>
          </dl>
        ) : null}
        {state.kind === 'error' ? (
          <div>
            <p className="text-danger">
              {state.problem.title ?? 'The admin API rejected the request.'} (HTTP {state.problem.status}
              {state.problem.code ? ` · ${state.problem.code}` : ''})
            </p>
            {state.problem.status === 401 ? (
              <p className="mt-2">
                <a className="text-action underline" href="/admin/login">
                  Sign in again
                </a>
              </p>
            ) : null}
            {state.problem.correlationId ? (
              <p className="mt-1 text-xs text-ink-sub">
                correlation <code>{state.problem.correlationId}</code>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <dl className="mt-4 grid max-w-prose grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-sub">Mounted at</dt>
        <dd>
          <code>{data.mountedAt}</code>
        </dd>
        <dt className="text-ink-sub">Build mode</dt>
        <dd>
          <code>{data.mode}</code>
        </dd>
      </dl>

      <h2 className="mt-8 text-base font-semibold">Coming next (tracked in the AWEB plan)</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
        <li>AWEB-03 — shared component primitives (Antigravity) + read-only Overview screen</li>
        <li>AWEB-04..07 — Profile, API keys/Connectors, Operations/Usage/Audit, Identity/Security/Settings</li>
      </ul>

      <p className="mt-6 rounded-sm border border-line bg-subtle px-3 py-2 text-xs text-ink-sub">
        Reads are tenant-fenced in the BFF: the tenant comes from the server-side session, never
        from the URL; mutations require the session CSRF token. Screens that lack a backend
        capability stay visibly unavailable until their slice lands.
      </p>
    </section>
  );
}

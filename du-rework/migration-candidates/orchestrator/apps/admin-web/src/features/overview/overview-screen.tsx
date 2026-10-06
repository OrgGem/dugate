import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DeniedState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AppShellStatusBadge } from '@/components/ui/app-shell-primitives';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';
import {
  paneStateFrom,
  parseAuditPage,
  severityVariant,
  type AuditListPage,
  type Loadable,
} from './state';

/**
 * Overview (read-only) — AWEB-03b.
 *
 * Real tenant data through the BFF: the session card reads
 * `/admin/api/session`, the audit ledger reads `/admin/api/audit` (tenant
 * fenced server-side). Usage/Operations have no backend yet, so they are
 * honestly marked `requires backend` instead of fabricated numbers.
 */
export function OverviewScreen() {
  const [session, setSession] = useState<Loadable<AdminWebSession>>({ kind: 'loading' });
  const [audit, setAudit] = useState<Loadable<AuditListPage>>({ kind: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    const client = createAdminApiClient();
    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      setSession({ kind: 'failed', problem: sessionResult.problem });
      setAudit({ kind: 'loading' });
      return;
    }
    setSession({ kind: 'ready', data: sessionResult.data });

    const auditResult = await client.listAudit({ limit: '25' });
    if (!auditResult.ok) {
      setAudit({ kind: 'failed', problem: auditResult.problem });
      return;
    }
    const page = parseAuditPage(auditResult.data);
    if (page === null) {
      setAudit({
        kind: 'failed',
        problem: {
          status: 502,
          code: 'UNREADABLE_RESPONSE',
          title: 'The admin API returned an unreadable audit page.',
        },
      });
      return;
    }
    setAudit({ kind: 'ready', data: page });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="overview-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="overview-title" className="text-lg font-semibold">
          Overview
        </h1>
        <Badge variant="neutral">read-only</Badge>
        <span className="text-xs text-[var(--text-sub)]">
          Tenant data served by the Orchestrator BFF; the tenant always comes from the server-side
          session.
        </span>
        <nav aria-label="Orchestrator Portal sections" className="ml-auto flex items-center gap-3 text-sm">
          <Link className="text-[var(--cf-blue)] underline" to="/operations">
            Operations
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/businesses">
            Businesses
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/usage">
            Usage
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/profiles">
            Profiles
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/api-keys">
            API keys
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/connectors">
            Connectors
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/security">
            Security
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/identity">
            Identity
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/settings">
            Settings
          </Link>
        </nav>
      </div>

      <SessionCard loadable={session} />

      <AuditCard loadable={audit} onRetry={() => void load()} />

      <div className="grid gap-4 sm:grid-cols-2 min-w-0">
        <UnavailableTile
          title="Usage rollup"
          description="Per-tenant usage aggregation is not exposed by the platform BFF yet. The tile will render real counts once the usage read endpoint lands."
        />
        <UnavailableTile
          title="Operations"
          description="The operations list/actions are not exposed through this read-only BFF slice yet; nothing is synthesised here."
        />
      </div>
    </section>
  );
}

function SessionCard({ loadable }: { loadable: Loadable<AdminWebSession> }) {
  const state = paneStateFrom(loadable);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Session</CardTitle>
        <CardDescription>Live from /admin/api/session (no-store).</CardDescription>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' ? (
          <LoadingState title="Loading session…" description="Resolving the server-side session." />
        ) : null}
        {state.kind === 'error' || state.kind === 'denied' ? (
          <ProblemPane problem={state.problem} />
        ) : null}
        {state.kind === 'ready' ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0">
            <dt className="text-[var(--text-sub)]">Principal</dt>
            <dd className="min-w-0 break-words">
              <code>{state.data.displayName}</code> ({state.data.principal.kind})
            </dd>
            <dt className="text-[var(--text-sub)]">Role</dt>
            <dd>
              <AppShellStatusBadge
                label={state.data.role}
                variant={
                  state.data.role === 'admin'
                    ? 'success'
                    : state.data.role === 'operator'
                      ? 'info'
                      : 'neutral'
                }
              />
              <span className="ml-2 text-[var(--text-sub)]">plane: {state.data.plane}</span>
            </dd>
            <dt className="text-[var(--text-sub)]">Tenant scope</dt>
            <dd className="min-w-0 break-words">
              {state.data.scope === null ? (
                <span className="text-[var(--text-sub)]">none — this session has no admin principal</span>
              ) : state.data.scope.kind === 'platform' ? (
                <span>platform (may narrow per request)</span>
              ) : (
                <code>{state.data.scope.tenantId}</code>
              )}
            </dd>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AuditCard({ loadable, onRetry }: { loadable: Loadable<AuditListPage>; onRetry: () => void }) {
  const state = paneStateFrom(loadable, (page) => page.items.length === 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit ledger</CardTitle>
        <CardDescription>
          Newest events for this session's tenant scope — GET /admin/api/audit (tenant fenced).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.kind === 'loading' ? (
          <LoadingState title="Loading audit events…" description="Reading the tenant-scoped ledger." />
        ) : null}
        {state.kind === 'denied' ? (
          <DeniedState
            title="Access denied"
            description={
              state.problem.title ?? 'This session is not authorized for the requested tenant scope.'
            }
          />
        ) : null}
        {state.kind === 'error' ? <ProblemPane problem={state.problem} onRetry={onRetry} /> : null}
        {state.kind === 'empty' ? (
          <EmptyState
            title="No audit events"
            description="No events match this session's tenant scope yet. New administrative activity will appear here."
            actionText="Refresh"
            onAction={onRetry}
          />
        ) : null}
        {state.kind === 'ready' ? (
          <>
            <TableContainer>
              <Table aria-label="Audit events">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">
                        {formatWhen(event.occurredAt)}
                      </TableCell>
                      <TableCell className="font-medium">{event.kind}</TableCell>
                      <TableCell>
                        <Badge variant={severityVariant(event.severity)} dot>
                          {event.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{event.actor || '—'}</TableCell>
                      <TableCell className="text-xs text-[var(--text-muted)]">{event.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <p className="text-xs text-[var(--text-sub)]">
              {state.data.total} event(s) in scope · page limit {state.data.limit}
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Error pane with the sign-in affordance rebound for a 401. */
function ProblemPane({ problem, onRetry }: { problem: AdminApiProblem; onRetry?: () => void }) {
  if (problem.status === 403) {
    return (
      <DeniedState
        title="Access denied"
        description={problem.title ?? 'This session is not authorized for the Overview read path.'}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ErrorState
        title={problem.title ?? 'The admin API rejected the request.'}
        statusCode={problem.status > 0 ? problem.status : undefined}
        error={problem.code ?? 'transport error'}
        onRetry={onRetry}
      />
      {problem.status === 401 ? <SignInLink /> : null}
    </div>
  );
}

function SignInLink() {
  return (
    <p className="text-sm">
      <a className="underline text-[var(--cf-blue)]" href="/admin/login">
        Sign in again
      </a>
    </p>
  );
}

function UnavailableTile({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge variant="warning" dot>
            requires backend
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-[var(--text-sub)]">
          Nothing is shown here until the backing read endpoint exists — no placeholder data.
        </p>
      </CardContent>
    </Card>
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

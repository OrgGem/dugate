import { useCallback, useEffect, useMemo, useState } from 'react';
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

/** F-7: the usage tile reads the same default window the Usage screen offers. */
const USAGE_WINDOW_MS = 24 * 3600 * 1000;

interface UsageRollupTotals {
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
}

interface UsageRollupRow {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  measurement: string;
}

interface UsageRollup {
  rows: UsageRollupRow[];
  totals: UsageRollupTotals;
}

/** The tile's state: `scope-required` is a platform/unscoped session, not a failure. */
type UsageTileState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: UsageRollup }
  | { kind: 'failed'; problem: AdminApiProblem }
  | { kind: 'scope-required' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-negative safe integer, or null — a count is never coerced from anything else. */
function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Runtime validation of the usage summary (unknown → typed or null). Strict on
 * purpose: one unreadable row or total makes the WHOLE payload unreadable, so
 * the tile shows an error pane instead of a partially fabricated rollup.
 */
export function parseUsageRollup(value: unknown): UsageRollup | null {
  if (!isRecord(value)) return null;
  const totalsRaw = value['totals'];
  if (!isRecord(totalsRaw)) return null;
  const operations = readCount(totalsRaw['operations']);
  const inputTokens = readCount(totalsRaw['inputTokens']);
  const outputTokens = readCount(totalsRaw['outputTokens']);
  const pages = readCount(totalsRaw['pages']);
  const costMicrousd = readCount(totalsRaw['costMicrousd']);
  if (
    operations === null ||
    inputTokens === null ||
    outputTokens === null ||
    pages === null ||
    costMicrousd === null
  ) {
    return null;
  }

  const rowsRaw = value['rows'];
  if (!Array.isArray(rowsRaw)) return null;
  const rows: UsageRollupRow[] = [];
  for (const raw of rowsRaw) {
    if (!isRecord(raw)) return null;
    const provider = readText(raw['provider']);
    const model = readText(raw['model']);
    const rowOperations = readCount(raw['operations']);
    const rowInput = readCount(raw['inputTokens']);
    const rowOutput = readCount(raw['outputTokens']);
    const rowCost = readCount(raw['costMicrousd']);
    if (
      provider === null ||
      model === null ||
      rowOperations === null ||
      rowInput === null ||
      rowOutput === null ||
      rowCost === null
    ) {
      return null;
    }
    rows.push({
      provider,
      model,
      operations: rowOperations,
      inputTokens: rowInput,
      outputTokens: rowOutput,
      costMicrousd: rowCost,
      measurement: readText(raw['measurement']) ?? 'unknown',
    });
  }

  return {
    rows,
    totals: { operations, inputTokens, outputTokens, pages, costMicrousd },
  };
}

/** Micro-USD integer → USD string; the integer is the source of truth, never a float sum. */
function formatMicroUsd(value: number): string {
  return `${(value / 1_000_000).toFixed(6)} USD`;
}

function formatWindow(window: { from: string; to: string }): string {
  return `${window.from} → ${window.to}`;
}

/**
 * Overview (read-only) — AWEB-03b.
 *
 * Real tenant data through the BFF: the session card reads
 * `/admin/api/session`, the audit ledger reads `/admin/api/audit` (tenant
 * fenced server-side), and the usage tile reads `/admin/api/usage` for the
 * session's tenant over the last 24h (F-7: the route has existed since the
 * BFF usage slice, so the tile renders real counts instead of claiming the
 * endpoint is missing). The Operations tile has no read route in this slice
 * and stays honestly marked `requires backend` — nothing is fabricated.
 */
export function OverviewScreen() {
  const [session, setSession] = useState<Loadable<AdminWebSession>>({ kind: 'loading' });
  const [audit, setAudit] = useState<Loadable<AuditListPage>>({ kind: 'loading' });
  const [usage, setUsage] = useState<UsageTileState>({ kind: 'loading' });
  const window = useMemo(() => {
    const now = Date.now();
    return { from: new Date(now - USAGE_WINDOW_MS).toISOString(), to: new Date(now).toISOString() };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const client = createAdminApiClient();
    setUsage({ kind: 'loading' });
    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      setSession({ kind: 'failed', problem: sessionResult.problem });
      setAudit({ kind: 'loading' });
      // No session → no tenant is knowable → the usage tile fails closed too.
      setUsage({ kind: 'failed', problem: sessionResult.problem });
      return;
    }
    setSession({ kind: 'ready', data: sessionResult.data });

    // The usage route is tenant scoped (BFF: 422 without a tenantId), so only a
    // tenant-scoped session can read it; a platform session picks one on /usage.
    const scope = sessionResult.data.scope;
    if (scope === null || scope.kind === 'platform') {
      setUsage({ kind: 'scope-required' });
    } else {
      const usageResult = await client.getUsage({
        tenantId: scope.tenantId,
        from: window.from,
        to: window.to,
      });
      if (!usageResult.ok) {
        setUsage({ kind: 'failed', problem: usageResult.problem });
      } else {
        const rollup = parseUsageRollup(usageResult.data);
        setUsage(
          rollup === null
            ? {
                kind: 'failed',
                problem: {
                  status: 502,
                  code: 'UNREADABLE_RESPONSE',
                  title: 'The admin API returned an unreadable usage summary.',
                },
              }
            : { kind: 'ready', data: rollup },
        );
      }
    }

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
  }, [window]);

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
        <UsageRollupTile state={usage} window={window} onRetry={() => void load()} />
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

/**
 * F-7: real per-tenant usage rollup from GET /admin/api/usage. Every number here
 * comes from the parsed payload; a failed or unreadable read renders a pane
 * instead of counts, and a platform/unscoped session is asked to pick a tenant
 * rather than being told the endpoint does not exist.
 */
function UsageRollupTile({
  state,
  window,
  onRetry,
}: {
  state: UsageTileState;
  window: { from: string; to: string };
  onRetry: () => void;
}) {
  const isEmpty =
    state.kind === 'ready' &&
    state.data.rows.length === 0 &&
    state.data.totals.operations === 0 &&
    state.data.totals.inputTokens === 0 &&
    state.data.totals.outputTokens === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Usage rollup</CardTitle>
          {state.kind === 'ready' ? (
            <Badge variant="success" dot>
              live
            </Badge>
          ) : state.kind === 'failed' ? (
            <Badge variant="warning" dot>
              unavailable
            </Badge>
          ) : (
            <Badge variant="neutral" dot>
              tenant scoped
            </Badge>
          )}
        </div>
        <CardDescription>
          Per-tenant usage read from GET /admin/api/usage — the platform projection, verbatim (no
          client-side aggregation).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.kind === 'loading' ? (
          <LoadingState title="Loading usage…" description="Reading the tenant-scoped usage summary." />
        ) : null}
        {state.kind === 'scope-required' ? (
          <p className="text-sm text-[var(--text-sub)]">
            Usage is tenant scoped. Select a tenant on the{' '}
            <Link className="text-[var(--cf-blue)] underline" to="/usage">
              Usage
            </Link>{' '}
            screen to read its counts.
          </p>
        ) : null}
        {state.kind === 'failed' ? <ProblemPane problem={state.problem} onRetry={onRetry} /> : null}
        {isEmpty ? (
          <EmptyState
            title="No usage in this window"
            description="No ledger events were recorded for this tenant in the last 24h."
            actionText="Refresh"
            onAction={onRetry}
          />
        ) : null}
        {state.kind === 'ready' && !isEmpty ? (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0">
              <dt className="text-[var(--text-sub)]">Operations</dt>
              <dd>{state.data.totals.operations}</dd>
              <dt className="text-[var(--text-sub)]">Input tokens</dt>
              <dd>{state.data.totals.inputTokens}</dd>
              <dt className="text-[var(--text-sub)]">Output tokens</dt>
              <dd>{state.data.totals.outputTokens}</dd>
              <dt className="text-[var(--text-sub)]">Cost</dt>
              <dd>{formatMicroUsd(state.data.totals.costMicrousd)}</dd>
            </dl>
            <TableContainer>
              <Table aria-label="Usage by provider and model">
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Ops</TableHead>
                    <TableHead>Tokens in/out</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.rows.map((row) => (
                    <TableRow key={`${row.provider}/${row.model}`}>
                      <TableCell className="font-medium">{row.provider}</TableCell>
                      <TableCell className="text-xs">{row.model}</TableCell>
                      <TableCell className="text-xs">{row.operations}</TableCell>
                      <TableCell className="text-xs">
                        {row.inputTokens} / {row.outputTokens}
                      </TableCell>
                      <TableCell className="text-xs">{formatMicroUsd(row.costMicrousd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <p className="text-xs text-[var(--text-sub)]">
              Window (UTC, half-open): {formatWindow(window)} · measurement per row comes from the
              platform projection.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
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

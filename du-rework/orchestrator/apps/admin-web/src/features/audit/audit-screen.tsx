import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createAdminApiClient, type AdminApiProblem } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import {
  buildAuditCsv,
  buildAuditQuery,
  localDateTimeToUtc,
  parseAuditPage,
  severityVariant,
  type AppliedAuditFilters,
  type AuditPage,
} from './state';

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: AuditPage }
  | { kind: 'failed'; problem: AdminApiProblem }
  | { kind: 'scope-mismatch'; message: string }
  | { kind: 'scope-required' };

interface DraftFilters {
  severity: AppliedAuditFilters['severity'];
  action: string;
  actor: string;
  resource: string;
  from: string;
  to: string;
  sort: AppliedAuditFilters['sort'];
  limit: string;
}

const DEFAULT_FILTERS: DraftFilters = {
  severity: 'ALL',
  action: '',
  actor: '',
  resource: '',
  from: '',
  to: '',
  sort: 'createdAt:desc',
  limit: '50',
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function cursorScopeKey(tenantId: string, filters: AppliedAuditFilters): string {
  return JSON.stringify([tenantId, filters]);
}

function dateWindowError(from: string, to: string, fromUtc: string | null, toUtc: string | null): string | null {
  if (from !== '' && fromUtc === null) return 'Enter a valid start time.';
  if (to !== '' && toUtc === null) return 'Enter a valid end time.';
  if (fromUtc !== null && toUtc !== null && fromUtc > toUtc) return 'Start time must be before or equal to end time.';
  return null;
}

function safeQueryValue(value: string | null, maxLength = 128): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function queryTimeToLocalInput(value: string | null): string {
  const normalized = safeQueryValue(value, 64);
  if (normalized === null) return '';
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * AWEB-AUDIT-RESOURCE-LINKS: the escape this screen was missing. A row used to
 * be read-only text, so an operator who spotted a suspicious event had nowhere
 * to go with it.
 *
 * Both targets are emitted only because they CONSUME the parameter today:
 * `/audit?resource=` is read by `auditFiltersFromQuery` below, and
 * `/trace?operationId=` is read by the Trace screen lookup. `/operations?id=`
 * is deliberately NOT emitted: Operations has no query reader yet, so that link
 * would open an unfiltered list and still look like it worked.
 */
function auditEventLinks(resourceId: string): { audit: string | null; trace: string | null } {
  const resource = safeQueryValue(resourceId);
  if (resource === null) return { audit: null, trace: null };
  const operation = /^operation:(.+)$/i.exec(resource);
  const operationId = operation === null ? null : safeQueryValue(operation[1] ?? null, 64);
  return {
    audit: `/audit?${new URLSearchParams({ resource }).toString()}`,
    trace: operationId === null
      ? null
      : `/trace?${new URLSearchParams({ operationId }).toString()}`,
  };
}

function auditFiltersFromQuery(searchParams: URLSearchParams): { draft: DraftFilters; filters: AppliedAuditFilters } {
  const severityValue = searchParams.get('severity')?.trim().toLowerCase() ?? '';
  const severity: DraftFilters['severity'] = ['info', 'success', 'warning', 'error'].includes(severityValue)
    ? severityValue as DraftFilters['severity']
    : 'ALL';
  const operationId = safeQueryValue(searchParams.get('operationId'));
  const resource = safeQueryValue(searchParams.get('resource'))
    ?? (operationId === null ? '' : `operation:${operationId}`);
  const from = queryTimeToLocalInput(searchParams.get('from'));
  const to = queryTimeToLocalInput(searchParams.get('to'));
  const sortValue = searchParams.get('sort');
  const sort: DraftFilters['sort'] = sortValue === 'createdAt:asc' ? 'createdAt:asc' : 'createdAt:desc';
  const limitValue = searchParams.get('limit');
  const limit = ['25', '50', '100', '200'].includes(limitValue ?? '') ? limitValue as string : '50';
  const draft: DraftFilters = {
    severity,
    action: safeQueryValue(searchParams.get('action')) ?? '',
    actor: safeQueryValue(searchParams.get('actor')) ?? '',
    resource,
    from,
    to,
    sort,
    limit,
  };
  return {
    draft,
    filters: {
      ...draft,
      from: localDateTimeToUtc(from) ?? '',
      to: localDateTimeToUtc(to) ?? '',
    },
  };
}

export function AuditScreen() {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.toString();
  const initialFilters = auditFiltersFromQuery(searchParams);
  const rawQueryTenantId = searchParams.get('tenantId');
  const requestedTenantId = safeQueryValue(rawQueryTenantId, 256);
  const correlationIdFromUrl = safeQueryValue(searchParams.get('correlationId'), 200);
  const { tenantId, tenants, loading: tenantsLoading, setTenantId } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [draft, setDraft] = useState<DraftFilters>(initialFilters.draft);
  const [filters, setFilters] = useState<AppliedAuditFilters>(initialFilters.filters);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [tenantQueryError, setTenantQueryError] = useState<string | null>(
    rawQueryTenantId !== null && requestedTenantId === null
      ? 'The tenant ID in this link is invalid. Select an available tenant from the left navigation.'
      : null,
  );
  const [cursorState, setCursorState] = useState<{ scope: string; cursor: string } | null>(null);
  const [page, setPage] = useState<PageState>({ kind: 'loading' });
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer' | null>(null);
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestSequence = useRef(0);
  const hydratedSearchQuery = useRef(searchQuery);
  const resolvedTenantQuery = useRef<string | null>(null);

  useEffect(() => {
    if (searchQuery === hydratedSearchQuery.current) return;
    hydratedSearchQuery.current = searchQuery;
    const nextFilters = auditFiltersFromQuery(new URLSearchParams(searchQuery));
    setDraft(nextFilters.draft);
    setFilters(nextFilters.filters);
    setFilterError(null);
    setCursorState(null);
  }, [searchQuery]);

  useEffect(() => {
    if (rawQueryTenantId === null) {
      resolvedTenantQuery.current = null;
      setTenantQueryError(null);
      return;
    }
    if (requestedTenantId === null) {
      resolvedTenantQuery.current = rawQueryTenantId;
      setTenantQueryError('The tenant ID in this link is invalid. Select an available tenant from the left navigation.');
      return;
    }
    if (tenantsLoading || resolvedTenantQuery.current === requestedTenantId) return;
    resolvedTenantQuery.current = requestedTenantId;
    if (!tenants.some((item) => item.id === requestedTenantId)) {
      setTenantQueryError('The tenant in this link is not available to this session. Select an available tenant from the left navigation.');
      return;
    }
    setTenantQueryError(null);
    if (tenantId !== requestedTenantId) setTenantId(requestedTenantId);
  }, [rawQueryTenantId, requestedTenantId, tenantId, tenants, tenantsLoading, setTenantId]);

  useEffect(() => {
    setCursorState(null);
  }, [tenantId]);

  useEffect(() => {
    let active = true;
    void client.getSession().then((result) => {
      if (!active) return;
      setRole(result.ok ? result.data.role : null);
      setRoleLoaded(true);
    }).catch(() => {
      if (active) setRoleLoaded(true);
    });
    return () => { active = false; };
  }, [client]);

  const scopeKey = useMemo(
    () => tenantId === null ? '' : cursorScopeKey(tenantId, filters),
    [tenantId, filters],
  );
  const tenantContextBlocked = tenantQueryError !== null
    || (rawQueryTenantId !== null && requestedTenantId !== tenantId);
  const cursor = cursorState?.scope === scopeKey ? cursorState.cursor : null;
  const query = useMemo(() => tenantId === null || tenantContextBlocked || searchQuery !== hydratedSearchQuery.current
    ? null
    : buildAuditQuery({ tenantId, cursor, filters }), [tenantId, cursor, filters, searchQuery, tenantContextBlocked]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (tenantId === null) {
      setPage({ kind: 'scope-required' });
      return;
    }
    if (tenantContextBlocked) {
      setPage({
        kind: 'scope-mismatch',
        message: tenantQueryError ?? 'Resolving the tenant in this link before loading audit events.',
      });
      return;
    }
    if (query === null) {
      setPage({ kind: 'loading' });
      return;
    }

    setPage({ kind: 'loading' });
    void client.listAudit(query).then((result) => {
      if (sequence !== requestSequence.current) return;
      if (!result.ok) {
        setPage({ kind: 'failed', problem: result.problem });
        return;
      }
      const parsed = parseAuditPage(result.data);
      setPage(parsed === null
        ? { kind: 'failed', problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Audit response could not be read.' } }
        : { kind: 'ready', data: parsed });
    }).catch(() => {
      if (sequence !== requestSequence.current) return;
      setPage({ kind: 'failed', problem: { status: 502, code: 'UPSTREAM_UNAVAILABLE', title: 'Audit service could not be reached.' } });
    });

    return () => { requestSequence.current += 1; };
  }, [client, query, tenantId, reloadVersion, tenantContextBlocked, tenantQueryError]);

  const applyFilters = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fromUtc = localDateTimeToUtc(draft.from);
    const toUtc = localDateTimeToUtc(draft.to);
    const windowError = dateWindowError(draft.from, draft.to, fromUtc, toUtc);
    if (windowError !== null) {
      setFilterError(windowError);
      return;
    }
    setFilterError(null);
    setCursorState(null);
    setFilters({
      ...draft,
      action: draft.action.trim(),
      actor: draft.actor.trim(),
      resource: draft.resource.trim(),
      from: fromUtc ?? '',
      to: toUtc ?? '',
    });
  }, [draft]);

  const clearFilters = useCallback(() => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setFilterError(null);
    setCursorState(null);
  }, []);

  const exportAllowed = role === 'admin' || role === 'operator';

  const exportCurrentPage = useCallback(() => {
    if (!exportAllowed || page.kind !== 'ready' || tenantId === null || page.data.items.length === 0) return;
    const csv = buildAuditCsv(page.data.items, tenantId);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeTenantId = tenantId.replace(/[^A-Za-z0-9-]/g, '_');
    link.download = `audit-${safeTenantId}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [exportAllowed, page, tenantId]);

  const applyCursor = (value: string | null) => {
    if (value === null || scopeKey === '') return;
    setCursorState({ scope: scopeKey, cursor: value });
  };

  return (
    <section aria-labelledby="audit-title" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="audit-title" className="text-lg font-semibold">Audit Console</h1>
        <Badge variant="info">tenant scoped</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Server-side filters</CardTitle>
          <CardDescription>Filters are sent to the audit API; time bounds are interpreted in your local time and sent as UTC.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={applyFilters} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <FormField id="audit-severity" label="Severity">
              <NativeSelect id="audit-severity" value={draft.severity} onChange={(event) => setDraft({ ...draft, severity: event.target.value as DraftFilters['severity'] })}>
                <option value="ALL">All severities</option>
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
              </NativeSelect>
            </FormField>
            <FormField id="audit-action" label="Action contains">
              <Input id="audit-action" value={draft.action} maxLength={128} onChange={(event) => setDraft({ ...draft, action: event.target.value })} placeholder="business.enable" />
            </FormField>
            <FormField id="audit-actor" label="Actor contains">
              <Input id="audit-actor" value={draft.actor} maxLength={128} onChange={(event) => setDraft({ ...draft, actor: event.target.value })} placeholder="admin" />
            </FormField>
            <FormField id="audit-resource" label="Resource contains">
              <Input id="audit-resource" value={draft.resource} maxLength={128} onChange={(event) => setDraft({ ...draft, resource: event.target.value })} placeholder="business:…" />
            </FormField>
            <FormField id="audit-from" label="From (local time)">
              <Input id="audit-from" type="datetime-local" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
            </FormField>
            <FormField id="audit-to" label="To (local time)">
              <Input id="audit-to" type="datetime-local" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
            </FormField>
            <FormField id="audit-sort" label="Order">
              <NativeSelect id="audit-sort" value={draft.sort} onChange={(event) => setDraft({ ...draft, sort: event.target.value as DraftFilters['sort'] })}>
                <option value="createdAt:desc">Newest first</option>
                <option value="createdAt:asc">Oldest first</option>
              </NativeSelect>
            </FormField>
            <FormField id="audit-limit" label="Rows per page">
              <NativeSelect id="audit-limit" value={draft.limit} onChange={(event) => setDraft({ ...draft, limit: event.target.value })}>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
              </NativeSelect>
            </FormField>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-4">
              <Button type="submit" disabled={tenantId === null}>Apply filters</Button>
              <Button type="button" variant="outline" onClick={clearFilters}>Clear filters</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={exportCurrentPage}
                disabled={!roleLoaded || !exportAllowed || page.kind !== 'ready' || page.data.items.length === 0}
                title="Exports only the visible page and allowlisted audit columns."
              >
                Export current page CSV
              </Button>
              {!roleLoaded ? <span className="text-xs text-[var(--text-sub)]">Checking export permission…</span> : null}
              {roleLoaded && !exportAllowed ? <span className="text-xs text-[var(--text-sub)]">CSV export requires an admin or operator session.</span> : null}
              {filterError ? <p role="alert" className="w-full text-sm text-[var(--badge-danger-text)]">{filterError}</p> : null}
            </div>
          </form>
          {tenantQueryError ? <p role="alert" className="mt-3 text-sm text-[var(--badge-warning-text)]">{tenantQueryError}</p> : null}
          {correlationIdFromUrl ? (
            <p role="status" className="mt-3 text-xs text-[var(--text-sub)]">
              Correlation ID {correlationIdFromUrl} was retained from this link. The Audit API does not expose a correlation-ID filter; use Trace for that lookup.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {page.kind === 'loading' ? <LoadingState title="Loading audit events…" description="The server is applying tenant scope, filters, and cursor pagination." /> : null}
      {page.kind === 'scope-required' ? <EmptyState title="Select a tenant" description="Choose a tenant in the left navigator. Audit events are always read within an explicit tenant scope." /> : null}
      {page.kind === 'scope-mismatch' ? <div role="alert" className="rounded border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)]/40 p-4 text-sm text-[var(--badge-warning-text)]">{page.message}</div> : null}
      {page.kind === 'failed' && page.problem.status === 403 ? (
        <DeniedState title="Audit access denied" description={page.problem.title ?? 'Your session cannot read audit events for this tenant.'} tenantId={tenantId ?? undefined} />
      ) : null}
      {page.kind === 'failed' && page.problem.status !== 403 ? (
        <ErrorState title={page.problem.title ?? 'Failed to load audit events.'} statusCode={page.problem.status} error={page.problem.code} onRetry={() => setReloadVersion((value) => value + 1)} />
      ) : null}
      {page.kind === 'ready' && page.data.items.length === 0 ? (
        <EmptyState title="No audit events" description="No events matched the selected tenant and server-side filters." actionText="Clear filters" onAction={clearFilters} />
      ) : null}
      {page.kind === 'ready' && page.data.items.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Audit events</CardTitle>
                <CardDescription>{page.data.total.toLocaleString()} matching events · {page.data.items.length} on this page</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Audit page controls">
                <Button variant="outline" size="sm" disabled={!page.data.prevCursor} onClick={() => applyCursor(page.data.prevCursor)}>Previous</Button>
                <Button variant="outline" size="sm" disabled={!page.data.nextCursor} onClick={() => applyCursor(page.data.nextCursor)}>Next</Button>
                <Button variant="ghost" size="sm" disabled={cursor === null} onClick={() => setCursorState(null)}>Newest</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <TableContainer maxHeight="65dvh" aria-label="Audit events table">
              <Table density="compact">
                <TableHeader sticky>
                  <TableRow>
                    <TableHead>Occurred at</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Tenant</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.data.items.length === 0 ? <TableEmpty colSpan={6} message="No audit events on this page." /> : page.data.items.map((event) => {
                    const links = auditEventLinks(event.resourceId);
                    return (
                      <TableRow key={event.id}>
                        <TableCell className="whitespace-nowrap">{formatTime(event.occurredAt)}</TableCell>
                        <TableCell><Badge variant={severityVariant(event.severity)}>{event.severity}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{event.kind}</TableCell>
                        <TableCell className="font-mono text-xs">{event.actor || '—'}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {links.audit === null ? (event.resourceId || '—') : (
                            <span className="flex flex-wrap items-center gap-2">
                              <Link to={links.audit} className="break-all underline">{event.resourceId}</Link>
                              {links.trace === null ? null : (
                                <Link to={links.trace} className="whitespace-nowrap text-[var(--cf-blue)]">Open incident</Link>
                              )}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{event.tenantId ?? tenantId}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

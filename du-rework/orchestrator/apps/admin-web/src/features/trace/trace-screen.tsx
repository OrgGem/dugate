import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { useTenant } from '@/lib/tenant-context';
import { createAdminApiClient, type OperationDetail } from '@/lib/api';
import { parseAuditPage, severityVariant } from '@/features/audit/state';
import { parseOperationDetail, parseOperationsPage, operationStateVariant } from '@/features/operations/state';
import {
  buildTraceLinks,
  buildTraceTimeline,
  findOperationByTaskId,
  getTracePayloadPreview,
  normalizeTraceLookup,
  type TraceLookupKind,
} from './state';

type ScreenState =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; detail: OperationDetail; auditValue: unknown; auditMessage: string | null; lookupMessage: string | null };

const LOOKUP_LABELS: Record<TraceLookupKind, string> = {
  operationId: 'Operation ID',
  correlationId: 'Correlation ID',
  taskId: 'Task ID',
};

function formatTime(value: string | null): string {
  if (value === null) return 'Time unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function failureMessage(status: number, code?: string): string {
  const safeCode = code && /^[A-Z0-9_]{1,80}$/.test(code) ? ` (${code})` : '';
  return status === 403 || status === 404
    ? `The record was not found in the selected tenant or access was denied${safeCode}.`
    : `Trace lookup failed${safeCode}. Try again or use another identifier.`;
}

function tenantMatches(detail: OperationDetail, tenantId: string): boolean {
  return detail.operation !== null && detail.operation.tenantId === tenantId;
}

interface TraceDeepLinkLookup {
  kind: TraceLookupKind;
  value: string;
  error: string | null;
}

function safeQueryValue(value: string | null, maxLength = 200): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function traceLookupFromQuery(searchParams: URLSearchParams): TraceDeepLinkLookup {
  const candidates: Array<[TraceLookupKind, string]> = [
    ['operationId', 'operationId'],
    ['correlationId', 'correlationId'],
    ['taskId', 'taskId'],
  ];
  for (const [kind, key] of candidates) {
    const rawValue = searchParams.get(key);
    if (rawValue === null || rawValue.trim() === '') continue;
    const value = normalizeTraceLookup(rawValue);
    return value === null
      ? { kind, value: '', error: 'The identifier in this link is invalid. Enter a value of 1 to 200 characters.' }
      : { kind, value, error: null };
  }
  return { kind: 'operationId', value: '', error: null };
}

export function TraceScreen() {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.toString();
  const initialLookup = traceLookupFromQuery(searchParams);
  const rawQueryTenantId = searchParams.get('tenantId');
  const requestedTenantId = safeQueryValue(rawQueryTenantId);
  const { tenantId, tenant, tenants, loading: tenantsLoading, setTenantId } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [lookupKind, setLookupKind] = useState<TraceLookupKind>(initialLookup.kind);
  const [lookupValue, setLookupValue] = useState(initialLookup.value);
  const [inputError, setInputError] = useState<string | null>(initialLookup.error);
  const [tenantQueryError, setTenantQueryError] = useState<string | null>(
    rawQueryTenantId !== null && requestedTenantId === null
      ? 'The tenant ID in this link is invalid. Select an available tenant from the left navigation.'
      : null,
  );
  const [screen, setScreen] = useState<ScreenState>({ kind: 'idle' });
  const requestSequence = useRef(0);
  const hydratedSearchQuery = useRef(searchQuery);
  const resolvedTenantQuery = useRef<string | null>(null);

  useEffect(() => {
    if (searchQuery === hydratedSearchQuery.current) return;
    hydratedSearchQuery.current = searchQuery;
    const lookup = traceLookupFromQuery(new URLSearchParams(searchQuery));
    requestSequence.current += 1;
    setLookupKind(lookup.kind);
    setLookupValue(lookup.value);
    setInputError(lookup.error);
    setScreen({ kind: 'idle' });
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
    requestSequence.current += 1;
    setScreen({ kind: 'idle' });
  }, [tenantId]);

  async function lookup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = normalizeTraceLookup(lookupValue);
    if (value === null) {
      setInputError('Enter an identifier between 1 and 200 characters.');
      return;
    }
    setInputError(null);
    if (tenantId === null) {
      setScreen({ kind: 'failed', message: 'Select a tenant before searching. Trace never searches across all tenants.' });
      return;
    }

    const sequence = ++requestSequence.current;
    const scanMessage = lookupKind === 'taskId'
      ? 'Searching task snapshots in up to 500 recent operations for this tenant…'
      : 'Loading tenant-scoped trace…';
    setScreen({ kind: 'loading', message: scanMessage });

    try {
      let detail: OperationDetail | null = null;
      let lookupMessage: string | null = null;
      if (lookupKind === 'operationId') {
        const scopedResult = await client.listOperations({
          tenant: tenantId,
          id: value,
          limit: '100',
          sort: 'created_at:desc',
        });
        if (!scopedResult.ok) {
          if (sequence === requestSequence.current) setScreen({ kind: 'failed', message: failureMessage(scopedResult.status, scopedResult.problem.code) });
          return;
        }
        const scopedPage = parseOperationsPage(scopedResult.data);
        if (scopedPage === null) {
          if (sequence === requestSequence.current) setScreen({ kind: 'failed', message: 'The tenant-scoped operations response could not be read.' });
          return;
        }
        if (!scopedPage.items.some((item) => item.id === value)) {
          if (sequence === requestSequence.current) setScreen({ kind: 'failed', message: 'The record was not found in the selected tenant or access was denied.' });
          return;
        }
        const result = await client.getOperation(value);
        if (!result.ok) {
          if (sequence === requestSequence.current) setScreen({ kind: 'failed', message: failureMessage(result.status, result.problem.code) });
          return;
        }
        detail = parseOperationDetail(result.data);
        if (detail === null) {
          if (sequence === requestSequence.current) setScreen({ kind: 'failed', message: 'The operation detail response could not be read.' });
          return;
        }
      } else if (lookupKind === 'taskId') {
        const result = await findOperationByTaskId(value, tenantId, client);
        if (result.kind === 'failed') {
          if (sequence === requestSequence.current) setScreen({ kind: 'failed', message: failureMessage(result.problem.status, result.problem.code) });
          return;
        }
        if (result.kind === 'not-found') {
          const partial = result.capped ? ' The scan limit was reached.' : '';
          const failures = result.detailFailures > 0 ? ` ${result.detailFailures} operation detail${result.detailFailures === 1 ? '' : 's'} could not be read.` : '';
          if (sequence === requestSequence.current) {
            setScreen({ kind: 'failed', message: `Task was not found in ${result.scanned} recent operations for this tenant.${partial}${failures}` });
          }
          return;
        }
        detail = result.detail;
        lookupMessage = `Task match found after checking ${result.scanned} operation${result.scanned === 1 ? '' : 's'}.`;
      } else {
        if (sequence === requestSequence.current) {
          setScreen({
            kind: 'failed',
            message: 'Correlation ID lookup is not exposed by the current tenant-scoped Admin API. Use an operation or task ID until the server adds this read filter.',
          });
        }
        return;
      }

      if (sequence !== requestSequence.current) return;
      if (detail === null || !tenantMatches(detail, tenantId)) {
        setScreen({ kind: 'failed', message: 'The record was not found in the selected tenant or access was denied.' });
        return;
      }

      const operationId = detail.operation?.id;
      if (!operationId) {
        setScreen({ kind: 'failed', message: 'The operation detail did not contain an operation ID.' });
        return;
      }

      const auditResult = await client.listAudit({
        tenantId,
        resource: `operation:${operationId}`,
        limit: '100',
        sort: 'createdAt:desc',
      });
      if (sequence !== requestSequence.current) return;
      let auditValue: unknown = null;
      let auditMessage: string | null = null;
      if (!auditResult.ok) {
        auditMessage = `Related audit events could not be loaded${auditResult.problem.code ? ` (${auditResult.problem.code})` : ''}.`;
      } else {
        const parsedAudit = parseAuditPage(auditResult.data);
        if (parsedAudit === null) auditMessage = 'The related audit response could not be read.';
        else {
          auditValue = {
            ...parsedAudit,
            items: parsedAudit.items.filter((item) => item.resourceId === `operation:${operationId}` || item.resourceId === operationId),
          };
          if (parsedAudit.nextCursor !== null) auditMessage = 'Showing the newest 100 related audit events.';
        }
      }
      setScreen({ kind: 'ready', detail, auditValue, auditMessage, lookupMessage });
    } catch {
      if (sequence === requestSequence.current) {
        setScreen({ kind: 'failed', message: 'Trace lookup could not reach the Admin API. Try again.' });
      }
    }
  }

  const detail = screen.kind === 'ready' ? screen.detail : null;
  const operation = detail?.operation ?? null;
  const timeline = screen.kind === 'ready' ? buildTraceTimeline(screen.detail, screen.auditValue) : [];
  const links = operation === null || tenantId === null ? null : buildTraceLinks(operation.id, tenantId);
  const payloadPreview = detail === null ? null : getTracePayloadPreview(detail);
  const tenantContextBlocked = tenantQueryError !== null
    || (rawQueryTenantId !== null && requestedTenantId !== tenantId);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--cf-blue)]">Support workspace</p>
          <h1 className="text-xl font-semibold">Trace Lookup</h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--text-muted)]">
            Follow an operation and its task snapshots alongside related audit and usage records. All lookup reads stay inside the selected tenant.
          </p>
        </div>
        <Badge variant={tenantId ? 'info' : 'warning'}>
          Tenant scope: {tenant?.name ?? tenantId ?? 'Select a tenant'}
        </Badge>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Find a support incident</CardTitle>
          <CardDescription>
            Operation IDs load directly. Task IDs search up to 500 recent operations in this tenant. Correlation ID lookup needs a server-side read filter that the current Admin API does not expose.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tenantQueryError ? <p role="alert" className="mb-3 text-sm text-[var(--badge-warning-text)]">{tenantQueryError}</p> : null}
          <form onSubmit={(event) => void lookup(event)} className="grid gap-3 md:grid-cols-[minmax(10rem,0.7fr)_minmax(16rem,2fr)_auto] md:items-end">
            <FormField id="trace-lookup-kind" label="Identifier type">
              <NativeSelect value={lookupKind} onChange={(event) => setLookupKind(event.currentTarget.value as TraceLookupKind)}>
                <option value="operationId">Operation ID</option>
                <option value="correlationId">Correlation ID</option>
                <option value="taskId">Task ID</option>
              </NativeSelect>
            </FormField>
            <FormField id="trace-lookup-value" label={LOOKUP_LABELS[lookupKind]} error={inputError}>
              <Input
                value={lookupValue}
                onChange={(event) => setLookupValue(event.currentTarget.value)}
                placeholder={`Enter ${LOOKUP_LABELS[lookupKind].toLowerCase()}`}
                autoComplete="off"
                maxLength={200}
                isError={inputError !== null}
              />
            </FormField>
            <Button type="submit" disabled={screen.kind === 'loading' || tenantId === null || tenantsLoading || tenantContextBlocked} isLoading={screen.kind === 'loading'}>
              Trace request
            </Button>
          </form>
          {tenantId === null ? <p className="mt-3 text-xs text-[var(--badge-warning-text)]">Choose a tenant in the left navigation before searching.</p> : null}
        </CardContent>
      </Card>

      {screen.kind === 'loading' ? (
        <div role="status" aria-live="polite" className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 text-sm text-[var(--text-muted)]">
          {screen.message}
        </div>
      ) : null}
      {screen.kind === 'failed' ? (
        <div role="alert" className="rounded-[var(--radius-md)] border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)]/40 p-4 text-sm text-[var(--badge-warning-text)]">
          {screen.message}
        </div>
      ) : null}

      {screen.kind === 'ready' && operation !== null && links !== null ? (
        <>
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>Operation {operation.id}</CardTitle>
                <CardDescription>{operation.action ?? 'Action unavailable'} · Tenant {operation.tenantId}</CardDescription>
              </div>
              <Badge variant={operationStateVariant(operation.state)}>{operation.state}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Link className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-[var(--border-dark)] px-3 text-sm font-medium text-[var(--cf-blue)] no-underline hover:bg-[var(--bg-hover)]" to={links.operations}>
                  Open Operations
                </Link>
                <Link className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-[var(--border-dark)] px-3 text-sm font-medium text-[var(--cf-blue)] no-underline hover:bg-[var(--bg-hover)]" to={links.audit}>
                  Open Audit
                </Link>
              </div>
              {screen.lookupMessage ? <p className="text-xs text-[var(--text-muted)]">{screen.lookupMessage}</p> : null}
              {screen.auditMessage ? <p role="status" className="text-xs text-[var(--text-muted)]">{screen.auditMessage}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Unified timeline</CardTitle>
              <CardDescription>Operation timestamps and current task snapshots are marked as snapshots. The current client does not expose full transition history or webhook delivery rows.</CardDescription>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">No timeline events are available for this operation.</p>
              ) : (
                <ol aria-label="Trace timeline" className="space-y-0">
                  {timeline.map((item) => (
                    <li key={item.id} className="grid gap-2 border-l-2 border-[var(--border-subtle)] py-3 pl-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
                      <time dateTime={item.occurredAt ?? undefined} className="text-xs tabular-nums text-[var(--text-muted)]">{formatTime(item.occurredAt)}</time>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={item.source === 'audit' ? severityVariant(item.severity ?? 'info') : item.source === 'task' ? 'warning' : 'info'}>{item.source}</Badge>
                          <span className="text-sm font-semibold">{item.title}</span>
                        </div>
                        <p className="mt-1 break-words text-xs text-[var(--text-muted)]">{item.summary}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payload visibility</CardTitle>
              <CardDescription>Trace never renders raw request or result payload values. The preview below preserves only field shape; every scalar value is masked.</CardDescription>
            </CardHeader>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm font-medium">Show masked payload preview</summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">{JSON.stringify(payloadPreview, null, 2)}</pre>
              </details>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

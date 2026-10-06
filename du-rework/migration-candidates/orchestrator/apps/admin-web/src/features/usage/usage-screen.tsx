import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type UsageSummary } from '@/lib/api';
import type { Loadable, PaneState } from '@/features/overview/state';

/**
 * Usage (AWEB-06) — reads the real tenant-scoped summary through the BFF.
 * The route requires from/to; the UI defaults to the last 24h.
 */
export function UsageScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const now = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 16));
  const [to, setTo] = useState(now.toISOString().slice(0, 16));
  const validWindow = from.length > 0 && to.length > 0 && Number.isFinite(Date.parse(from + 'Z')) && Number.isFinite(Date.parse(to + 'Z')) && Date.parse(from + 'Z') < Date.parse(to + 'Z');
  const [summary, setSummary] = useState<Loadable<UsageSummary> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!validWindow) return;
    setSummary({ kind: 'loading' });
    const result = await client.getUsage({ from: new Date(from + 'Z').toISOString(), to: new Date(to + 'Z').toISOString() });
    if (!result.ok) {
      setSummary({ kind: 'failed', problem: result.problem });
      return;
    }
    setSummary({ kind: 'ready', data: result.data });
  }, [client, from, to, validWindow]);

  useEffect(() => {
    void load();
  }, [load]);

  const pane: PaneState<UsageSummary> | null =
    summary === null
      ? null
      : summary.kind === 'loading'
        ? { kind: 'loading' }
        : summary.kind === 'failed'
          ? summary.problem.status === 403
            ? { kind: 'denied', problem: summary.problem }
            : { kind: 'error', problem: summary.problem }
          : Object.keys(summary.data).length === 0
            ? { kind: 'empty' }
            : { kind: 'ready', data: summary.data };

  return (
    <section aria-labelledby="usage-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="usage-title" className="text-lg font-semibold">
          Usage
        </h1>
        <Badge variant="neutral">tenant scoped</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Window</CardTitle>
          <CardDescription>GET /admin/api/usage?from&to — the tenant comes from the session scope.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-sm">
            <FormField id="usage-from" label="From (UTC)">
              <Input id="usage-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </FormField>
          </div>
          <div className="w-full max-w-sm">
            <FormField id="usage-to" label="To (UTC)">
              <Input id="usage-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </FormField>
          </div>
          <Button onClick={() => void load()} disabled={!validWindow}>Load usage</Button>
          {!validWindow ? <p role="alert" className="w-full text-sm text-[var(--badge-danger-text)]">Choose a start time before the end time.</p> : null}
        </CardContent>
      </Card>

      {pane?.kind === 'loading' ? <LoadingState title="Loading usage…" /> : null}
      {pane?.kind === 'denied' ? (
        <DeniedState title="Access denied" description={pane.problem.title ?? 'Not authorized for this tenant scope.'} />
      ) : null}
      {pane?.kind === 'error' ? (
        <ErrorState
          title={pane.problem.title ?? 'Failed to load usage.'}
          statusCode={pane.problem.status}
          error={pane.problem.code}
          onRetry={() => void load()}
        />
      ) : null}
      {pane?.kind === 'empty' ? <EmptyState title="No usage rows" description="The window returned no usage data." /> : null}
      {pane?.kind === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
            <CardDescription>Platform projection, verbatim — no client-side aggregation.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">
              {JSON.stringify(pane.data, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

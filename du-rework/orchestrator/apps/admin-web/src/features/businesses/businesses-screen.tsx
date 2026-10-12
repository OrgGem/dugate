import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner, DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenant } from '@/lib/tenant-context';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type AdminWebSession,
  type BusinessPage,
  type BusinessVersions,
} from '@/lib/api';
import type { Loadable, PaneState } from '@/features/overview/state';
import { parseBusinessPage, parseBusinessVersions } from './state';
import { BusinessDetailCockpit } from './business-detail-cockpit';

/**
 * Business registry — business intake enablement is lifecycle-CAS controlled;
 * the version action only changes the default pointer for new submissions.
 */
export function BusinessesScreen() {
  const { tenantId, tenant } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [page, setPage] = useState<Loadable<BusinessPage>>({ kind: 'loading' });
  const [versions, setVersions] = useState<Loadable<BusinessVersions> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<AdminWebSession | null>(null);

  const canManageBusiness = session?.role === 'admin' && !session.localUser && session.principal.kind === 'platform';

  const load = useCallback(async (): Promise<void> => {
    setPage({ kind: 'loading' });
    // Bootstrap the CSRF proof on this client first — the version actions ride it.
    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      setSession(null);
      setPage({ kind: 'failed', problem: sessionResult.problem });
      return;
    }
    setSession(sessionResult.data);
    const result = await client.listBusinesses({ limit: '50' });
    if (!result.ok) {
      setPage({ kind: 'failed', problem: result.problem });
      return;
    }
    const parsed = parseBusinessPage(result.data);
    setPage(
      parsed === null
        ? { kind: 'failed', problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable business page.' } }
        : { kind: 'ready', data: parsed },
    );
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openVersions(businessId: string): Promise<void> {
    setNotice(null);
    setProblem(null);
    setVersions({ kind: 'loading' });
    const result = await client.getBusinessVersions(businessId);
    if (!result.ok) {
      setVersions({ kind: 'failed', problem: result.problem });
      return;
    }
    const parsed = parseBusinessVersions(result.data);
    setVersions(
      parsed === null
        ? { kind: 'failed', problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable versions payload.' } }
        : { kind: 'ready', data: parsed },
    );
  }

  async function setDefaultVersion(businessId: string, version: string, makeDefault: boolean): Promise<void> {
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      if (makeDefault) {
        // A version must be enabled before it can become the default pointer.
        const row = versions?.kind === 'ready' ? versions.data.rows.find((r) => r.version === version) : null;
        if (row && row.status !== 'ENABLED') {
          const enableResult = await client.businessVersionAction(businessId, version, 'enable');
          if (!enableResult.ok) {
            setProblem(enableResult.problem);
            return;
          }
        }
        const result = await client.businessVersionAction(businessId, version, 'activate');
        if (!result.ok) {
          setProblem(result.problem);
          return;
        }
        setNotice(`Version ${version} is now the default for new submissions.`);
      } else {
        const result = await client.businessVersionAction(businessId, version, 'deactivate');
        if (!result.ok) {
          setProblem(result.problem);
          return;
        }
        setNotice(`Version ${version} is no longer the default.`);
      }
      await openVersions(businessId);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setBusinessEnabled(businessId: string, enabled: boolean, lifecycleRevision: number | null): Promise<void> {
    if (!canManageBusiness || lifecycleRevision === null) return;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const result = await client.setBusinessEnabled(businessId, { enabled, expectedLifecycleRevision: lifecycleRevision });
      if (!result.ok) {
        if (result.status === 409) {
          setProblem({ ...result.problem, title: 'Business lifecycle changed while this page was open. The registry has been reloaded.' });
          await load();
          if (versions?.kind === 'ready' && versions.data.businessId === businessId) await openVersions(businessId);
          return;
        }
        setProblem(result.problem);
        return;
      }
      setNotice(`Business intake ${result.data.enabled ? 'enabled' : 'disabled'} (lifecycle revision ${result.data.lifecycleRevision}).`);
      await load();
      if (versions?.kind === 'ready' && versions.data.businessId === businessId) await openVersions(businessId);
    } finally {
      setBusy(false);
    }
  }

  const pane: PaneState<BusinessPage> | null =
    page.kind === 'loading'
      ? { kind: 'loading' }
      : page.kind === 'failed'
        ? page.problem.status === 403
          ? { kind: 'denied', problem: page.problem }
          : { kind: 'error', problem: page.problem }
        : page.data.items.length === 0
          ? { kind: 'empty' }
          : { kind: 'ready', data: page.data };

  return (
    <section aria-labelledby="businesses-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="businesses-title" className="text-lg font-semibold">
          Businesses
        </h1>
        <Badge variant="neutral">registry</Badge>
        <div className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-xs">
          <span className="text-[var(--text-sub)]">Global Tenant:</span>
          <span className="font-semibold text-[var(--text-main)]">
            {tenant?.name || (tenantId ? `Tenant (${tenantId.slice(0, 8)}...)` : 'Platform')}
          </span>
          {tenant && (
            <Badge variant={tenant.state === 'ACTIVE' ? 'success' : 'neutral'} className="text-[10px] py-0 px-1.5 ml-1">
              {tenant.state}
            </Badge>
          )}
        </div>
      </div>

      {problem !== null ? (
        <AlertBanner variant="error" title={problem.title ?? 'The registry rejected the request.'}>
          {problem.status} · {problem.code ?? 'ERROR'}
        </AlertBanner>
      ) : null}
      {notice !== null ? (
        <AlertBanner variant="success" title="Registry">
          {notice}
        </AlertBanner>
      ) : null}

      {pane?.kind === 'loading' ? <LoadingState title="Loading businesses…" /> : null}
      {pane?.kind === 'denied' ? (
        <DeniedState
          title="Access denied"
          description={pane.problem.title ?? 'The business registry is platform-scoped (admin session required).'}
        />
      ) : null}
      {pane?.kind === 'error' ? (
        <ErrorState
          title={pane.problem.title ?? 'Failed to load the registry.'}
          statusCode={pane.problem.status}
          error={pane.problem.code}
          onRetry={() => void load()}
        />
      ) : null}
      {pane?.kind === 'empty' ? (
        <EmptyState title="No businesses" description="The registry has no rows yet." actionText="Refresh" onAction={() => void load()} />
      ) : null}
      {pane?.kind === 'ready' ? (
        <TableContainer>
          <Table aria-label="Businesses">
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Default version for new submissions</TableHead>
                <TableHead>Business intake</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pane.data.items.map((row) => {
                return (
                  <TableRow key={row.businessId}>
                    <TableCell className="font-mono text-xs font-medium">{row.businessId}</TableCell>
                    <TableCell className="text-xs">
                      {row.activeVersion !== null ? (
                        <span className="font-mono text-xs font-semibold">{row.activeVersion}</span>
                      ) : (
                        <span className="text-[var(--text-sub)]">None</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.enabled === true ? 'success' : row.enabled === false ? 'neutral' : 'warning'} dot>
                        {row.enabled === true ? 'Enabled' : row.enabled === false ? 'Disabled' : 'Unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">{row.updatedAt ?? '—'}</TableCell>
                    <TableCell className="flex flex-wrap gap-2">
                      {canManageBusiness ? (
                        <Button size="sm" variant={row.enabled === true ? 'outline' : 'primary'} disabled={busy || row.enabled === null || row.lifecycleRevision === null} onClick={() => void setBusinessEnabled(row.businessId, row.enabled !== true, row.lifecycleRevision)}>
                          {row.enabled === true ? 'Disable business' : 'Enable business'}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => void openVersions(row.businessId)}>
                        Versions
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}

      {versions?.kind === 'loading' ? <LoadingState title="Loading versions…" /> : null}
      {versions?.kind === 'failed' ? (
        <ErrorState
          title={versions.problem.title ?? 'Failed to load versions.'}
          statusCode={versions.problem.status}
          error={versions.problem.code}
        />
      ) : null}
      {versions?.kind === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>Versions — {versions.data.businessId}</CardTitle>
            <CardDescription>
              Business intake: <strong>{versions.data.enabled === true ? 'Enabled' : versions.data.enabled === false ? 'Disabled' : 'Unknown'}</strong> · default version for new submissions: <span className="font-mono font-medium">{versions.data.activeVersion ?? 'None'}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {versions.data.rows.length === 0 ? (
              <p className="text-sm text-[var(--text-sub)]">No versions registered.</p>
            ) : (
              <TableContainer>
                <Table aria-label="Business versions">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Version state</TableHead>
                      <TableHead>Default pointer</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.data.rows.map((row) => (
                      <TableRow key={row.version}>
                        <TableCell className="font-mono text-xs font-medium">{row.version}</TableCell>
                        <TableCell>
                          <Badge variant={row.status === 'ENABLED' ? 'success' : row.status === 'DRAINING' ? 'warning' : 'neutral'} dot>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{row.isActive ? 'Default' : 'Not default'}</TableCell>
                        <TableCell>
                          {row.isActive ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void setDefaultVersion(versions.data.businessId, row.version, false)}
                            >
                              Clear default
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy}
                              onClick={() => void setDefaultVersion(versions.data.businessId, row.version, true)}
                            >
                              Set as default
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* BIZ-09: the detail cockpit. Mounted only once a business was opened,
          because every card is a real read keyed on that businessId. */}
      {versions?.kind === 'ready' && versions.data.businessId.length > 0 ? (
        <BusinessDetailCockpit businessId={versions.data.businessId} />
      ) : null}
    </section>
  );
}

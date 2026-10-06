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
import {
  createAdminApiClient,
  type AdminApiProblem,
  type BusinessPage,
  type BusinessVersions,
} from '@/lib/api';
import type { Loadable, PaneState } from '@/features/overview/state';
import { businessStatusVariant, parseBusinessPage, parseBusinessVersions } from './state';

/**
 * Business registry (AWEB-06) — platform-scoped reads + real version actions.
 * enable/activate/deactivate ride the platform admin PUT routes (T-API path
 * already shipped); everything else stays read-only.
 */
export function BusinessesScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [page, setPage] = useState<Loadable<BusinessPage>>({ kind: 'loading' });
  const [versions, setVersions] = useState<Loadable<BusinessVersions> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setPage({ kind: 'loading' });
    // Bootstrap the CSRF proof on this client first — the version actions ride it.
    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      setPage({ kind: 'failed', problem: sessionResult.problem });
      return;
    }
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

  async function runAction(businessId: string, version: string, action: 'enable' | 'activate' | 'deactivate'): Promise<void> {
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const result = await client.businessVersionAction(businessId, version, action);
      if (!result.ok) {
        setProblem(result.problem);
        return;
      }
      // Reload first (openVersions resets the notice), then report the action.
      await openVersions(businessId);
      await load();
      setNotice(`Version ${version} ${action}d.`);
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
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pane.data.items.map((row) => (
                <TableRow key={row.businessId}>
                  <TableCell className="font-mono text-xs">{row.businessId}</TableCell>
                  <TableCell className="text-xs">
                    {row.activeVersion ?? row.version ?? '—'}
                    {row.activeVersion === null ? <span className="ml-1 text-[var(--text-sub)]">(none active)</span> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={businessStatusVariant(row.status)} dot>
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">{row.updatedAt ?? '—'}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => void openVersions(row.businessId)}>
                      Versions
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
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
            <CardDescription>Active version: {versions.data.activeVersion ?? 'none'}</CardDescription>
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
                      <TableHead>Status</TableHead>
                      <TableHead>Active</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.data.rows.map((row) => (
                      <TableRow key={row.version}>
                        <TableCell className="text-xs">{row.version}</TableCell>
                        <TableCell>
                          <Badge variant={businessStatusVariant(row.status)} dot>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{row.isActive ? 'yes' : 'no'}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction(versions.data.businessId, row.version, 'enable')}
                            >
                              Enable
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || row.isActive}
                              onClick={() => void runAction(versions.data.businessId, row.version, 'activate')}
                            >
                              Activate
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || !row.isActive}
                              onClick={() => void runAction(versions.data.businessId, row.version, 'deactivate')}
                            >
                              Deactivate
                            </Button>
                          </div>
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
    </section>
  );
}

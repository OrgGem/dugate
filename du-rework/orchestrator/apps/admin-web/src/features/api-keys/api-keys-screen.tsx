import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
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
  type ApiKeyPage,
  type ApiKeyRow,
} from '@/lib/api';
import { type Loadable, paneStateFrom } from '@/features/overview/state';
import { apiKeyStatusVariant, parseApiKeyPage } from './state';

/**
 * API keys (AWEB-05) — list + issue (copy-once) + revoke, read through the BFF.
 * Rotate/disable stay visibly `requires backend` (F7): no fake buttons.
 */
export function ApiKeysScreen() {
  const { tenantId, tenant } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<Loadable<AdminWebSession>>({ kind: 'loading' });
  const [keys, setKeys] = useState<Loadable<ApiKeyPage>>({ kind: 'loading' });
  const [issuing, setIssuing] = useState(false);
  const [actionProblem, setActionProblem] = useState<AdminApiProblem | null>(null);
  const [copyOnce, setCopyOnce] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      setSession({ kind: 'failed', problem: sessionResult.problem });
      return;
    }
    setSession({ kind: 'ready', data: sessionResult.data });

    const keysResult = await client.listApiKeys({
      limit: '50',
      ...(tenantId ? { tenantId } : {}),
    });
    if (!keysResult.ok) {
      setKeys({ kind: 'failed', problem: keysResult.problem });
      return;
    }
    const page = parseApiKeyPage(keysResult.data);
    setKeys(
      page === null
        ? {
            kind: 'failed',
            problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable API-key page.' },
          }
        : { kind: 'ready', data: page },
    );
  }, [client, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = session.kind === 'ready' && session.data.role === 'admin';

  async function refreshKeys(): Promise<void> {
    const result = await client.listApiKeys({ limit: '50', ...(tenantId ? { tenantId } : {}) });
    const page = result.ok ? parseApiKeyPage(result.data) : null;
    if (page !== null) setKeys({ kind: 'ready', data: page });
  }

  async function issueKey(): Promise<void> {
    if (!tenantId) return;
    setActionProblem(null);
    setIssuing(true);
    try {
      const result = await client.postAction(
        'apikey.issue',
        { tenantId: tenantId.trim() },
        { idempotencyKey: crypto.randomUUID() },
      );
      if (!result.ok) {
        setActionProblem(result.problem);
        return;
      }
      const rawKey = result.data.rawKey;
      if (typeof rawKey !== 'string' || rawKey.length === 0) {
        setActionProblem({ status: 502, code: 'COPY_ONCE_MISSING', title: 'The issued key was not returned.' });
        return;
      }
      setCopyOnce(rawKey);
      await refreshKeys();
    } finally {
      setIssuing(false);
    }
  }

  async function revokeKey(): Promise<void> {
    const target = revokeTarget;
    if (target === null) return;
    setActionProblem(null);
    setRevoking(true);
    try {
      const result = await client.postAction(
        'apikey.revoke',
        { apiKeyId: target.id },
        { idempotencyKey: crypto.randomUUID() },
      );
      if (!result.ok) {
        setActionProblem(result.problem);
        return;
      }
      setRevokeTarget(null);
      await refreshKeys();
    } finally {
      setRevoking(false);
    }
  }

  const listState = paneStateFrom(keys, (page) => page.items.length === 0);

  return (
    <section aria-labelledby="api-keys-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="api-keys-title" className="text-lg font-semibold">
          API keys
        </h1>
        <Badge variant="neutral">read + issue/revoke</Badge>
        {session.kind === 'ready' && !isAdmin ? (
          <Badge variant="warning" dot>
            admin role required for mutations
          </Badge>
        ) : null}
      </div>

      {copyOnce !== null ? (
        <AlertBanner variant="warning" title="Copy this key now — it will not be shown again">
          <div className="flex flex-col gap-2">
            <output>
              <code className="break-all">{copyOnce}</code>
            </output>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(copyOnce).catch(() => undefined);
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCopyOnce(null)}>
                Dismiss
              </Button>
            </div>
            <span className="text-[var(--text-sub)]">
              The value lives in this page's memory only (never stored, never re-fetched); a reload hides it.
            </span>
          </div>
        </AlertBanner>
      ) : null}

      {actionProblem !== null ? (
        <AlertBanner variant="error" title={actionProblem.title ?? 'The action failed.'}>
          {actionProblem.status} · {actionProblem.code ?? 'ERROR'}
          {actionProblem.status === 401 ? (
            <>
              {' '}
              <a className="underline" href="/admin/login">
                Sign in again
              </a>
            </>
          ) : null}
        </AlertBanner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Issue a key</CardTitle>
          <CardDescription>
            POST /admin/api/actions (apikey.issue). The raw key is returned once, from the issue
            response only; reads never project it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--text-sub)]">Target Tenant (active)</span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{tenant?.name ?? 'No tenant selected'}</span>
              {tenant ? (
                <Badge variant={tenant.state === 'ACTIVE' ? 'success' : 'neutral'} dot>
                  {tenant.state}
                </Badge>
              ) : null}
            </div>
            {tenantId ? (
              <span className="font-mono text-xs text-[var(--text-sub)]">{tenantId}</span>
            ) : null}
          </div>
          <Button
            onClick={() => void issueKey()}
            isLoading={issuing}
            disabled={!isAdmin || !tenantId}
          >
            Issue key
          </Button>
          <p className="text-xs text-[var(--text-sub)] basis-full">
            The API key will be issued directly for the active tenant selected in the left navigation.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keys</CardTitle>
          <CardDescription>GET /admin/api/api-keys (tenant scoped by the server-side session).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {listState.kind === 'loading' ? <LoadingState title="Loading keys…" /> : null}
          {listState.kind === 'denied' ? (
            <DeniedState title="Access denied" description={listState.problem.title ?? 'Not authorized.'} />
          ) : null}
          {listState.kind === 'error' ? (
            <ErrorState
              title={listState.problem.title ?? 'Failed to load keys.'}
              statusCode={listState.problem.status}
              error={listState.problem.code}
              onRetry={() => void load()}
            />
          ) : null}
          {listState.kind === 'empty' ? (
            <EmptyState
              title="No API keys"
              description="No keys exist in this scope yet. Issue one above."
              actionText="Refresh"
              onAction={() => void refreshKeys()}
            />
          ) : null}
          {listState.kind === 'ready' ? (
            <TableContainer>
              <Table aria-label="API keys">
                <TableHeader>
                  <TableRow>
                    <TableHead>Prefix</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listState.data.items.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.maskedHint}</TableCell>
                      <TableCell>
                        <Badge variant={apiKeyStatusVariant(row.status)} dot>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        <code>{row.tenantId}</code>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">
                        {row.createdAt}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={!isAdmin || row.status.toUpperCase() !== 'ACTIVE'}
                            onClick={() => setRevokeTarget(row)}
                          >
                            Revoke
                          </Button>
                          <Button size="sm" variant="outline" disabled title="No rotate backend action yet (F7)">
                            Rotate
                          </Button>
                          <Button size="sm" variant="outline" disabled title="No disable backend action yet (F7)">
                            Disable
                          </Button>
                          <Badge variant="warning" dot>
                            rotate/disable: requires backend
                          </Badge>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </CardContent>
      </Card>

      {listState.kind === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>Profile bindings (read-only)</CardTitle>
            <CardDescription>
              Display-only projection from the platform; the server remains the authorization
              authority. Bindings are created outside this screen.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {listState.data.grants.length === 0 ? (
              <p className="text-sm text-[var(--text-sub)]">No bindings in this scope.</p>
            ) : (
              <TableContainer>
                <Table aria-label="Profile bindings">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Business</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Granted</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {listState.data.grants.map((grant, index) => (
                      <TableRow key={`${grant.businessId}:${grant.action}:${index}`}>
                        <TableCell className="text-xs">
                          <code>{grant.businessId}</code>
                        </TableCell>
                        <TableCell className="text-xs">{grant.businessVersion}</TableCell>
                        <TableCell className="text-xs">{grant.action}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">
                          {grant.grantedAt}
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

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke API key"
        description={`Revoke ${revokeTarget?.maskedHint ?? 'this key'}? Requests using it will fail immediately. This cannot be undone.`}
        confirmText="Revoke"
        variant="destructive"
        isLoading={revoking}
        onConfirm={() => void revokeKey()}
      />
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { AlertBanner, DeniedState, EmptyState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession, type ApiKeyLifecycleRow } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';

type PageState = { kind: 'loading' } | { kind: 'ready'; items: ApiKeyLifecycleRow[]; nextCursor: string | null; prevCursor: string | null; total: number } | { kind: 'failed'; problem: AdminApiProblem };
type OneTimeSecret = { value: string; keyId: string; expiresAt: number } | null;

function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `api-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Platform-admin key lifecycle surface. Secrets exist only in the mutation response and this short-lived view. */
export function ApiKeysScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const { tenantId, tenant, loading: tenantLoading, tenantLoadError } = useTenant();
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [page, setPage] = useState<PageState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'ACTIVE' | 'REVOKED'>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secretOnce, setSecretOnce] = useState<OneTimeSecret>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ kind: 'rotate' | 'revoke'; key: ApiKeyLifecycleRow } | null>(null);

  const canAdminister = session?.role === 'admin' && session.principal.kind === 'platform';

  const loadPage = useCallback(async (next: string | null = null) => {
    if (!tenantId) { setPage({ kind: 'failed', problem: { status: 400, code: 'TENANT_REQUIRED', title: 'Choose a tenant to manage API keys.' } }); return; }
    setPage({ kind: 'loading' });
    const result = await client.listApiKeyLifecycle({ tenantId, limit: '100', ...(query.trim() ? { query: query.trim() } : {}), ...(status !== 'all' ? { status } : {}), ...(next ? { cursor: next } : {}) });
    if (!result.ok) { setPage({ kind: 'failed', problem: result.problem }); return; }
    setPage({ kind: 'ready', items: result.data.items, nextCursor: result.data.nextCursor, prevCursor: result.data.prevCursor, total: result.data.total });
    setCursor(next);
    setNoteDrafts(Object.fromEntries(result.data.items.map((item) => [item.id, item.note ?? ''])));
  }, [client, tenantId, query, status]);

  useEffect(() => {
    let live = true;
    void client.getSession().then((result) => {
      if (!live) return;
      setSessionLoading(false);
      setSession(result.ok ? result.data : null);
    });
    return () => { live = false; };
  }, [client]);

  useEffect(() => { void loadPage(null); }, [loadPage]);
  useEffect(() => {
    if (!secretOnce) return;
    const timer = window.setTimeout(() => setSecretOnce(null), Math.max(0, secretOnce.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [secretOnce]);

  async function applyMutation(result: Awaited<ReturnType<typeof client.issueApiKey>>, success: string): Promise<void> {
    setSaving(false);
    if (!result.ok) { setError(result.problem.title ?? `Request failed (${result.status}).`); return; }
    setError(null);
    setNotice(success);
    setSecretOnce(result.data.secret ? { value: result.data.secret, keyId: result.data.key.id, expiresAt: Date.now() + 90_000 } : null);
    await loadPage(cursor);
  }

  async function issue(): Promise<void> {
    if (!canAdminister || !tenantId) return;
    setSaving(true); setError(null); setNotice(null); setSecretOnce(null);
    const result = await client.issueApiKey({ note: note.trim() || null, profileIds: [] }, tenantId, newIdempotencyKey());
    await applyMutation(result, 'API key issued. Copy the secret now; it cannot be fetched again.');
    setNote('');
  }

  async function saveNote(key: ApiKeyLifecycleRow): Promise<void> {
    if (!canAdminister || !tenantId) return;
    setSaving(true); setError(null); setNotice(null);
    const result = await client.updateApiKeyNote(key.id, { note: noteDrafts[key.id]?.trim() || null, expectedVersion: key.version }, tenantId, newIdempotencyKey());
    await applyMutation(result, 'API key note saved and refreshed.');
  }

  async function performConfirmed(): Promise<void> {
    if (!confirm || !tenantId || !canAdminister) return;
    const target = confirm; setConfirm(null); setSaving(true); setError(null); setNotice(null);
    const result = target.kind === 'rotate'
      ? await client.rotateApiKey(target.key.id, { expectedVersion: target.key.version }, tenantId, newIdempotencyKey())
      : await client.revokeApiKey(target.key.id, target.key.version, tenantId, newIdempotencyKey());
    await applyMutation(result, target.kind === 'rotate' ? 'API key rotated. The previous key is revoked; copy the replacement now.' : 'API key revoked and refreshed.');
  }

  async function copyAndDrop(): Promise<void> {
    if (!secretOnce) return;
    try {
      await navigator.clipboard.writeText(secretOnce.value);
      setSecretOnce(null);
      setNotice('Secret copied to the clipboard and removed from this screen.');
    } catch {
      setError('Clipboard access is unavailable. Select and copy the visible secret, then dismiss it; this view clears automatically shortly.');
    }
  }

  if (sessionLoading || tenantLoading) return <LoadingState title="Loading API key access…" />;
  if (!canAdminister) return <DeniedState title="Platform Admin access required" description="API key issue, rotation, note changes, and revocation require a platform Admin session." />;

  return (
    <section aria-labelledby="api-keys-title" className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 id="api-keys-title" className="text-lg font-semibold">API Keys</h1><p className="text-sm text-[var(--text-sub)]">Issue and manage tenant-scoped keys. Secret material is shown only in the successful issue or rotation response.</p></div>
        <Badge variant="success">platform Admin</Badge>
      </header>
      {tenantLoadError ? <AlertBanner variant="error" title="Tenant roster unavailable">{tenantLoadError}</AlertBanner> : null}
      {!tenantId ? <AlertBanner variant="warning" title="Choose a tenant">Select a tenant in the app header before managing its keys.</AlertBanner> : null}
      {tenant ? <p className="text-sm">Managing <strong>{tenant.name}</strong> · <code>{tenant.id}</code></p> : null}
      {error ? <AlertBanner variant="error" title="API key change failed">{error}</AlertBanner> : null}
      {notice ? <AlertBanner variant="success" title="API key status">{notice}</AlertBanner> : null}
      {secretOnce ? (
        <Card className="border-[var(--badge-warning-border)]">
          <CardHeader><CardTitle>Copy the new key now</CardTitle><CardDescription>This response is the only time the secret is available. It disappears after 90 seconds or when you copy it.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <code className="select-all break-all rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3" aria-label="One-time API key secret">{secretOnce.value}</code>
            <div className="flex flex-wrap gap-2"><Button onClick={() => void copyAndDrop()}>Copy and dismiss</Button><Button variant="outline" onClick={() => setSecretOnce(null)}>Dismiss</Button></div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Issue an API key</CardTitle><CardDescription>Assignments are validated and committed by the server. The note is metadata only.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">Note <Input maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="For example: support automation" disabled={!tenantId || saving} /></label>
          <p className="text-xs text-[var(--text-sub)]">Profile memberships are managed from Identity so the server can commit the user and key assignment set together.</p>
          <Button disabled={!tenantId || saving} isLoading={saving} onClick={() => void issue()}>Issue key</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>Tenant keys</CardTitle><Badge variant="neutral">{page.kind === 'ready' ? `${page.total} total` : 'server search'}</Badge></div><CardDescription>Search and cursor pagination are evaluated by the server, so large key inventories are not truncated to the first thousand rows.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_auto]" onSubmit={(event) => { event.preventDefault(); void loadPage(null); }}>
            <label className="flex flex-col gap-1 text-sm">Search <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Note, prefix, or key ID" /></label>
            <label className="flex flex-col gap-1 text-sm">Status <select className="h-9 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setCursor(null); }}><option value="all">All</option><option value="ACTIVE">Active</option><option value="REVOKED">Revoked</option></select></label>
            <div className="flex items-end"><Button type="submit" variant="outline" disabled={!tenantId || saving}>Search</Button></div>
          </form>
          {page.kind === 'loading' ? <LoadingState title="Loading API keys…" /> : null}
          {page.kind === 'failed' ? <AlertBanner variant="error" title={page.problem.title ?? 'API key inventory unavailable'}>{page.problem.status} · {page.problem.code ?? 'ERROR'}</AlertBanner> : null}
          {page.kind === 'ready' && page.items.length === 0 ? <EmptyState title="No API keys found" description="Try another search or issue a key for this tenant." /> : null}
          {page.kind === 'ready' && page.items.length > 0 ? <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded border border-[var(--border-subtle)]">
            {page.items.map((key) => <article key={key.id} className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{key.note || 'Untitled key'}</strong><Badge variant={key.status === 'ACTIVE' ? 'success' : 'neutral'}>{key.status}</Badge>{key.protected ? <Badge variant="warning">protected</Badge> : null}</div><p className="mt-1 text-xs text-[var(--text-sub)]">Prefix <code>{key.prefix}</code> · ID <code>{key.id}</code> · version {key.version} · updated {key.updatedAt}</p><p className="mt-1 text-xs text-[var(--text-sub)]">Profiles: {key.profileIds.length ? key.profileIds.join(', ') : 'none'}</p></div>
                <div className="flex flex-wrap gap-2">{key.status === 'ACTIVE' ? <><Button size="sm" variant="outline" disabled={saving || key.protected} onClick={() => setConfirm({ kind: 'rotate', key })}>Rotate</Button><Button size="sm" variant="destructive" disabled={saving || key.protected} onClick={() => setConfirm({ kind: 'revoke', key })}>Revoke</Button></> : null}</div>
              </div>
              {key.status === 'ACTIVE' ? <div className="flex flex-wrap items-end gap-2"><label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">Note<Input value={noteDrafts[key.id] ?? ''} maxLength={200} onChange={(event) => setNoteDrafts((current) => ({ ...current, [key.id]: event.target.value }))} disabled={saving || key.protected} /></label><Button size="sm" variant="outline" disabled={saving || key.protected || (noteDrafts[key.id] ?? '') === (key.note ?? '')} onClick={() => void saveNote(key)}>Save note</Button></div> : null}
            </article>)}
          </div> : null}
          {page.kind === 'ready' ? <div className="flex items-center justify-between"><Button variant="outline" size="sm" disabled={!page.prevCursor || saving} onClick={() => page.prevCursor && void loadPage(page.prevCursor)}>Previous page</Button><Button variant="outline" size="sm" disabled={!page.nextCursor || saving} onClick={() => page.nextCursor && void loadPage(page.nextCursor)}>Next page</Button></div> : null}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }} title={confirm?.kind === 'rotate' ? 'Rotate API key?' : 'Revoke API key?'} description={confirm?.kind === 'rotate' ? 'The current key will stop working. A replacement secret is shown once.' : 'The key will stop working immediately. This cannot be undone.'} confirmText={confirm?.kind === 'rotate' ? 'Rotate key' : 'Revoke key'} variant="destructive" onConfirm={() => void performConfirmed()} />
    </section>
  );
}

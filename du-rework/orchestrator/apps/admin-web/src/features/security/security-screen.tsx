import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AlertBanner, DeniedState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { useTenant } from '@/lib/tenant-context';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';

type CryptoLoadable =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; body: Record<string, unknown> }
  | { kind: 'failed'; problem: AdminApiProblem };

/**
 * Security (AWEB-07) — crypto-config read + write through the BFF.
 * The view carries key refs/previews only (never secret material); a
 * 503 from the platform means "crypto configuration is not enabled on this
 * deployment" and is shown as the honest unavailable state.
 */
export function SecurityScreen() {
  const { tenantId: globalTenantId, tenant } = useTenant();
  const tenantId = globalTenantId ?? '';
  const client = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [state, setState] = useState<CryptoLoadable>({ kind: 'idle' });
  const [storageKeyRef, setStorageKeyRef] = useState('');
  const [deliveryEncryption, setDeliveryEncryption] = useState(false);
  const [recipientKeyVersion, setRecipientKeyVersion] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [saveProblem, setSaveProblem] = useState<AdminApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setNotice(null);
    setSaveProblem(null);
    setState({ kind: 'loading' });
    const sessionResult = await client.getSession();
    if (sessionResult.ok) {
      setSession(sessionResult.data);
    }
    const result = await client.getCryptoConfig(tenantId.trim());
    if (!result.ok) {
      setState({ kind: 'failed', problem: result.problem });
      return;
    }
    setState({ kind: 'ready', body: result.data });
  }, [client, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setBusy(true);
    setNotice(null);
    setSaveProblem(null);
    try {
      const mutation: Record<string, unknown> = {};
      if (storageKeyRef.trim().length > 0) mutation.storageKeyRef = storageKeyRef.trim();
      mutation.deliveryEncryption = deliveryEncryption;
      if (recipientKeyVersion.trim().length > 0) mutation.recipientKeyVersion = Number(recipientKeyVersion);
      const result = await client.updateCryptoConfig(mutation, crypto.randomUUID());
      if (!result.ok) {
        setSaveProblem(result.problem);
        return;
      }
      const changed = Array.isArray(result.data['changedFields'])
        ? (result.data['changedFields'] as unknown[]).join(', ')
        : '—';
      setStorageKeyRef('');
      setRecipientKeyVersion('');
      // Reload first (it resets the notice), then report the applied change.
      await load();
      setNotice(`Applied. Changed fields: ${changed}`);
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = session?.role === 'admin';

  return (
    <section aria-labelledby="security-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="security-title" className="text-lg font-semibold">
          Security
        </h1>
        <Badge variant="neutral">crypto configuration</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tenant scope</CardTitle>
          <CardDescription>GET /admin/api/crypto-config?tenantId — the view projects key refs/previews only.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-sm">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-[var(--text-sub)]">Active Tenant</span>
              <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-sm">
                <span className="font-medium text-[var(--text-main)] truncate">
                  {tenant?.name || (tenantId ? `Tenant (${tenantId.slice(0, 8)}...)` : 'No Tenant Selected')}
                </span>
                {tenant && (
                  <Badge variant={tenant.state === 'ACTIVE' ? 'success' : 'neutral'} className="text-[10px] py-0 px-1.5 ml-auto">
                    {tenant.state}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-[var(--text-sub)]">Configured via Global Tenant in Left Navigator.</p>
            </div>
          </div>
          <Button onClick={() => void load()}>Reload configuration</Button>
        </CardContent>
      </Card>

      {notice !== null ? (
        <AlertBanner variant="success" title="Crypto configuration">
          {notice}
        </AlertBanner>
      ) : null}
      {saveProblem !== null ? (
        <AlertBanner variant="error" title={saveProblem.title ?? 'The change was rejected.'}>
          {saveProblem.status} · {saveProblem.code ?? 'ERROR'}
        </AlertBanner>
      ) : null}

      {state.kind === 'loading' ? <LoadingState title="Loading crypto configuration…" /> : null}
      {state.kind === 'idle' ? <LoadingState title="Preparing…" /> : null}
      {state.kind === 'failed' ? (
        state.problem.status === 403 ? (
          <DeniedState
            title="Access denied"
            description={state.problem.title ?? 'This session is not authorized for crypto configuration.'}
          />
        ) : state.problem.status === 503 ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Crypto configuration unavailable</CardTitle>
                <Badge variant="warning" dot>
                  requires deployment action
                </Badge>
              </div>
              <CardDescription>
                The platform answered 503: crypto configuration is not enabled on this deployment
                (no <code>cryptoConfig</code> block composed). Enable it via deployment env, then
                reload — nothing is faked here.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ErrorState
            title={state.problem.title ?? 'Failed to load crypto configuration.'}
            statusCode={state.problem.status}
            error={state.problem.code}
            onRetry={() => void load()}
          />
        )
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Effective view</CardTitle>
              <CardDescription>Configuration is shown for the selected tenant scope; secrets never ride this wire.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-72 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">
                {JSON.stringify(state.body['crypto'] ?? state.body, null, 2)}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Apply a change</CardTitle>
              <CardDescription>
                POST /admin/api/crypto-config (platform admin + session CSRF). Secret material is never
                accepted or displayed here — only key REFS and version numbers.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="w-full max-w-sm">
                <FormField id="crypto-keyref" label="Storage key ref (write-only)">
                  <Input id="crypto-keyref" value={storageKeyRef} onChange={(e) => setStorageKeyRef(e.target.value)} disabled={!isAdmin} placeholder="ref name (never a secret)" />
                </FormField>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={deliveryEncryption} disabled={!isAdmin} onChange={(e) => setDeliveryEncryption(e.target.checked)} />
                delivery encryption
              </label>
              <div className="w-full max-w-[10rem]">
                <FormField id="crypto-version" label="Recipient key version">
                  <Input id="crypto-version" value={recipientKeyVersion} onChange={(e) => setRecipientKeyVersion(e.target.value)} disabled={!isAdmin} placeholder="1" />
                </FormField>
              </div>
              <Button onClick={() => void save()} isLoading={busy} disabled={!isAdmin}>
                Apply change
              </Button>
              {!isAdmin ? (
                <Badge variant="warning" dot>
                  platform admin required
                </Badge>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}

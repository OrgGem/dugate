import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { AlertBanner, DeniedState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { useTenant } from '@/lib/tenant-context';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';
import { cryptoFingerprintPreview, parseCryptoConfigPresentationView } from './security-presentation';

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
  const { tenantId: globalTenantId } = useTenant();
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
  const loadGeneration = useRef(0);
  const tenantScopeRef = useRef(tenantId.trim());
  const tenantScopeGeneration = useRef(0);
  if (tenantScopeRef.current !== tenantId.trim()) {
    tenantScopeRef.current = tenantId.trim();
    tenantScopeGeneration.current += 1;
  }

  const load = useCallback(async (): Promise<void> => {
    const requestedTenant = tenantId.trim();
    if (requestedTenant !== tenantScopeRef.current) return;
    const requestedScopeGeneration = tenantScopeGeneration.current;
    const generation = ++loadGeneration.current;
    const isCurrent = (): boolean => generation === loadGeneration.current
      && tenantScopeGeneration.current === requestedScopeGeneration
      && tenantScopeRef.current === requestedTenant;
    setNotice(null);
    setSaveProblem(null);
    setSession(null);
    if (!requestedTenant) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'loading' });
    const sessionResult = await client.getSession();
    if (!isCurrent()) return;
    if (sessionResult.ok) {
      setSession(sessionResult.data);
    }
    const result = await client.getCryptoConfig(requestedTenant);
    if (!isCurrent()) return;
    if (!result.ok) {
      setState({ kind: 'failed', problem: result.problem });
      return;
    }
    const view = parseCryptoConfigPresentationView(result.data);
    if (view) {
      setStorageKeyRef(view.state.storageKeyRef ?? '');
      setDeliveryEncryption(view.state.deliveryEncryption);
      setRecipientKeyVersion(view.state.pinnedRecipientKeyVersion === null ? '' : String(view.state.pinnedRecipientKeyVersion));
    }
    setState({ kind: 'ready', body: result.data });
  }, [client, tenantId]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
      tenantScopeGeneration.current += 1;
    };
  }, [load]);

  async function save(): Promise<void> {
    const view = state.kind === 'ready' ? parseCryptoConfigPresentationView(state.body) : null;
    const requestedTenant = tenantId.trim();
    const requestedScopeGeneration = tenantScopeGeneration.current;
    const requestedLoadGeneration = loadGeneration.current;
    const isCurrentSaveScope = (): boolean => tenantScopeRef.current === requestedTenant
      && tenantScopeGeneration.current === requestedScopeGeneration
      && loadGeneration.current === requestedLoadGeneration;
    if (!view || view.tenantId !== requestedTenant || !requestedTenant || session?.role !== 'admin' || session.principal.kind !== 'platform' || busy) return;
    setBusy(true);
    setNotice(null);
    setSaveProblem(null);
    try {
      const mutation: Record<string, unknown> = { tenantId: tenantId.trim() };
      const storedStorageKeyRef = view.state.storageKeyRef ?? '';
      if (storageKeyRef !== storedStorageKeyRef) mutation.storageKeyRef = storageKeyRef || null;
      if (deliveryEncryption !== view.state.deliveryEncryption) mutation.deliveryEncryption = deliveryEncryption;
      const storedRecipientVersion = view.state.pinnedRecipientKeyVersion === null ? '' : String(view.state.pinnedRecipientKeyVersion);
      if (recipientKeyVersion !== storedRecipientVersion) {
        mutation.recipientKeyVersion = recipientKeyVersion === '' ? null : Number(recipientKeyVersion);
      }
      if (Object.keys(mutation).length === 1) {
        setNotice('No configuration changes to apply.');
        return;
      }
      const result = await client.updateCryptoConfig(mutation, crypto.randomUUID());
      if (!isCurrentSaveScope()) return;
      if (!result.ok) {
        setSaveProblem(result.problem);
        return;
      }
      const changed = Array.isArray(result.data['changedFields'])
        ? (result.data['changedFields'] as unknown[]).join(', ')
        : '—';
      // Reload first (it resets the notice), then report the applied change.
      const refresh = load();
      const refreshGeneration = loadGeneration.current;
      await refresh;
      if (
        tenantScopeRef.current !== requestedTenant
        || tenantScopeGeneration.current !== requestedScopeGeneration
        || loadGeneration.current !== refreshGeneration
      ) return;
      setNotice(`Applied. Changed fields: ${changed}`);
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = session?.role === 'admin' && session.principal.kind === 'platform';
  const presentationView = state.kind === 'ready' ? parseCryptoConfigPresentationView(state.body) : null;
  const viewMatchesTenant = presentationView !== null && presentationView.tenantId === tenantId.trim();
  const storageKeyRefChanged = viewMatchesTenant && storageKeyRef !== (presentationView.state.storageKeyRef ?? '');
  const deliveryEncryptionChanged = viewMatchesTenant && deliveryEncryption !== presentationView.state.deliveryEncryption;
  const currentPinnedVersion = presentationView?.state.pinnedRecipientKeyVersion === null || !presentationView
    ? ''
    : String(presentationView.state.pinnedRecipientKeyVersion);
  const recipientKeyVersionChanged = viewMatchesTenant && recipientKeyVersion !== currentPinnedVersion;
  const hasPendingChanges = storageKeyRefChanged || deliveryEncryptionChanged || recipientKeyVersionChanged;

  return (
    <section aria-labelledby="security-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="security-title" className="text-lg font-semibold">
          Security
        </h1>
        <Badge variant="neutral">crypto configuration</Badge>
      </div>

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

      <Card className="min-w-0">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Apply a change</CardTitle>
              <CardDescription>
                Changes apply to the tenant selected in the left navigation. The server still enforces platform-admin access, CSRF, the storage-ref allowlist, and recipient-key validity.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" onClick={() => void load()} disabled={!tenantId.trim() || state.kind === 'loading' || busy}>
              {state.kind === 'loading' ? 'Reloading…' : 'Reload configuration'}
            </Button>
          </div>
        </CardHeader>
          <CardContent>
            {viewMatchesTenant ? (
              <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(13rem,1fr)_minmax(13rem,1fr)]">
                <FormField id="crypto-keyref" label="Vault storage key ref" description="Allowlisted reference only; no key material is displayed.">
                  <select
                    id="crypto-keyref"
                    aria-label="Vault storage key ref"
                    className="h-9 w-full min-w-0 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                    value={storageKeyRef}
                    onChange={(event) => setStorageKeyRef(event.target.value)}
                    disabled={!isAdmin || busy}
                  >
                    <option value="">No app-managed storage key</option>
                    {presentationView.allowedKeyRefs.map((keyRef) => <option key={keyRef} value={keyRef}>{keyRef}</option>)}
                    {presentationView.state.storageKeyRef && !presentationView.allowedKeyRefs.includes(presentationView.state.storageKeyRef) ? (
                      <option value={presentationView.state.storageKeyRef}>Stored ref · not currently allowlisted</option>
                    ) : null}
                  </select>
                </FormField>
                <FormField id="crypto-version" label="Recipient key selection" description="Choose a registered version or follow the current active key.">
                  <select
                    id="crypto-version"
                    aria-label="Recipient key selection"
                    className="h-9 w-full min-w-0 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                    value={recipientKeyVersion}
                    onChange={(event) => setRecipientKeyVersion(event.target.value)}
                    disabled={!isAdmin || busy}
                  >
                    <option value="">Follow current active key</option>
                    {presentationView.recipientKeys.map((key) => (
                      <option key={key.version} value={String(key.version)} disabled={key.revokedAt !== null}>
                        v{key.version} · {cryptoFingerprintPreview(key.fingerprint)} · {key.revokedAt === null ? 'not revoked' : 'revoked'}
                      </option>
                    ))}
                    {presentationView.state.pinnedRecipientKeyVersion !== null
                      && !presentationView.recipientKeys.some((key) => key.version === presentationView.state.pinnedRecipientKeyVersion) ? (
                      <option value={String(presentationView.state.pinnedRecipientKeyVersion)}>
                        v{presentationView.state.pinnedRecipientKeyVersion} · missing from registry
                      </option>
                    ) : null}
                  </select>
                </FormField>
                <label className="flex min-h-9 items-center gap-2 text-sm lg:col-span-2">
                  <input type="checkbox" checked={deliveryEncryption} disabled={!isAdmin || busy} onChange={(event) => setDeliveryEncryption(event.target.checked)} />
                  Enable recipient-encrypted delivery
                </label>
                <div className="flex min-w-0 flex-wrap items-center gap-3 lg:col-span-2">
                  <Button type="button" onClick={() => void save()} isLoading={busy} disabled={!isAdmin || busy || !hasPendingChanges}>
                    Apply change
                  </Button>
                  {!isAdmin ? <Badge variant="warning" dot>platform admin required</Badge> : null}
                  {isAdmin && !hasPendingChanges ? <span className="text-xs text-[var(--text-sub)]">No unapplied changes.</span> : null}
                </div>
              </div>
            ) : (
              <div className="flex min-h-24 flex-wrap items-center gap-2 text-sm text-[var(--text-sub)]">
                <span>Load the selected tenant’s configuration before applying changes.</span>
                {!isAdmin ? <Badge variant="warning" dot>platform admin required</Badge> : null}
              </div>
            )}
          </CardContent>
      </Card>

      {state.kind === 'loading' ? <LoadingState title="Loading crypto configuration…" /> : null}
      {state.kind === 'idle' && !tenantId.trim() ? <AlertBanner variant="warning" title="Choose a tenant">Select a tenant in the left navigator to load its crypto configuration.</AlertBanner> : null}
      {state.kind === 'idle' && tenantId.trim() ? <LoadingState title="Preparing…" /> : null}
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
              <CardTitle>Crypto policy and projected delivery readiness</CardTitle>
              <CardDescription>
                Saved configuration and registered recipient keys for this tenant. Effective key and readiness are calculated by the API; this view is not an observation of an individual delivery.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {viewMatchesTenant ? (
                <>
                  <dl className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3">
                      <dt className="text-xs text-[var(--text-sub)]">Tenant</dt>
                      <dd className="mt-1 break-all font-mono text-sm">{presentationView.tenantId}</dd>
                    </div>
                    <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3">
                      <dt className="text-xs text-[var(--text-sub)]">Storage key ref</dt>
                      <dd className="mt-1 break-all font-mono text-sm">{presentationView.state.storageKeyRef ?? 'None configured'}</dd>
                      <p className="mt-1 text-xs text-[var(--text-sub)]">Configured ref for app-managed artifact storage encryption.</p>
                    </div>
                    <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3">
                      <dt className="text-xs text-[var(--text-sub)]">Recipient-encrypted delivery</dt>
                      <dd className="mt-1 text-sm font-medium">{presentationView.state.deliveryEncryption ? 'Enabled in saved configuration' : 'Disabled in saved configuration'}</dd>
                    </div>
                    <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3">
                      <dt className="text-xs text-[var(--text-sub)]">Recipient key pin</dt>
                      <dd className="mt-1 text-sm font-medium">{presentationView.state.pinnedRecipientKeyVersion === null ? 'Follow current active key' : `Pinned to v${presentationView.state.pinnedRecipientKeyVersion}`}</dd>
                      {presentationView.pinInvalid ? <p role="status" className="mt-1 text-xs text-[var(--badge-warning-text)]">Pinned v{presentationView.pinInvalid.version}: {presentationView.pinInvalid.reason === 'version_revoked' ? 'revoked' : 'not registered'}.</p> : null}
                    </div>
                    <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3">
                      <dt className="text-xs text-[var(--text-sub)]">Effective recipient key (calculated)</dt>
                      <dd className="mt-1 text-sm font-medium">{presentationView.effectiveRecipientKeyVersion === null ? 'No usable version' : `v${presentationView.effectiveRecipientKeyVersion}`}</dd>
                      <p className="mt-1 text-xs text-[var(--text-sub)]">Derived from the configured pin and current non-revoked key registry.</p>
                    </div>
                    <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3">
                      <dt className="text-xs text-[var(--text-sub)]">Delivery readiness (calculated)</dt>
                      <dd className="mt-1 text-sm font-medium">{!presentationView.state.deliveryEncryption ? 'Encryption is disabled' : presentationView.deliveryReady ? 'Ready according to the current registry' : 'Blocked'}</dd>
                      {presentationView.state.deliveryEncryption && !presentationView.deliveryReady ? <p role="status" className="mt-1 text-xs text-[var(--badge-warning-text)]">{presentationView.deliveryBlockedReason === 'no_recipient_key' ? 'No recipient public key is registered.' : 'The pinned recipient key cannot be used.'}</p> : null}
                    </div>
                  </dl>

                  <section aria-labelledby="crypto-allowed-refs-title" className="space-y-2">
                    <h3 id="crypto-allowed-refs-title" className="text-sm font-semibold">Allowed storage key refs</h3>
                    {presentationView.allowedKeyRefs.length > 0 ? (
                      <ul className="flex flex-wrap gap-2">{presentationView.allowedKeyRefs.map((keyRef) => <li key={keyRef} className="max-w-full"><code className="block max-w-full break-all rounded border border-[var(--border-subtle)] px-2 py-1 text-xs">{keyRef}</code></li>)}</ul>
                    ) : <p className="text-sm text-[var(--text-sub)]">No storage key refs are currently allowlisted.</p>}
                  </section>

                  <section aria-labelledby="crypto-recipient-keys-title" className="space-y-2">
                    <h3 id="crypto-recipient-keys-title" className="text-sm font-semibold">Registered recipient keys</h3>
                    {presentationView.recipientKeys.length > 0 ? (
                      <div className="max-w-full overflow-x-auto rounded border border-[var(--border-subtle)]">
                        <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
                          <caption className="sr-only">Recipient key versions registered for the selected tenant</caption>
                          <thead className="bg-[var(--bg-subtle)] text-[var(--text-sub)]"><tr><th scope="col" className="px-3 py-2 font-medium">Version</th><th scope="col" className="px-3 py-2 font-medium">Fingerprint preview</th><th scope="col" className="px-3 py-2 font-medium">Revocation</th><th scope="col" className="px-3 py-2 font-medium">Effective at</th></tr></thead>
                          <tbody className="divide-y divide-[var(--border-subtle)]">{presentationView.recipientKeys.map((key) => <tr key={key.version}><th scope="row" className="px-3 py-2 font-medium">v{key.version}</th><td className="px-3 py-2 font-mono">{cryptoFingerprintPreview(key.fingerprint)}</td><td className="px-3 py-2">{key.revokedAt === null ? 'Not revoked' : `Revoked · ${key.revokedAt}`}</td><td className="px-3 py-2">{key.effectiveAt}</td></tr>)}</tbody>
                        </table>
                      </div>
                    ) : <p className="text-sm text-[var(--text-sub)]">No recipient public keys are registered for this tenant.</p>}
                  </section>
                </>
              ) : (
                <AlertBanner variant="warning" title="Crypto response could not be interpreted">The API response did not match the crypto-config view fields. Inspect the raw JSON before making changes.</AlertBanner>
              )}

              <details className="rounded border border-[var(--border-subtle)] p-3">
                <summary className="cursor-pointer text-sm font-medium">Raw API JSON</summary>
                <pre className="mt-3 max-h-80 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">{JSON.stringify(state.body, null, 2)}</pre>
              </details>
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { AlertBanner, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession, type ApiKeyRow, type ProfileApiKeyPage, type ProfileApiKeyRow } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { keyStatusVariant, membershipVariant, parseProfileApiKeyPage } from './profile-keys';

interface Props {
  businessId: string;
  businessVersion: string;
  profileName: string;
  /** 0 = the blank editor for a profile that is not stored yet. */
  revision: number;
}

/**
 * 0039 - the API keys a profile OWNS, and the whole key lifecycle now that the
 * standalone tab is gone.
 *
 * Issue runs issue-THEN-attach: a freshly issued key belongs to no profile
 * until it is attached, and the copy-once value is shown BEFORE the attach
 * half - if that half fails the key still exists, and an operator who never
 * saw the raw value owns nothing.
 */
export function ProfileApiKeysPanel({ businessId, businessVersion, profileName, revision }: Props) {
  const { tenantId } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  // Reads its OWN session instead of taking one from the screen: key mutation
  // is admin-only, and this is the only thing that decides whether the write
  // controls exist at all.
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const canMutate = session !== null && session.role === 'admin';
  const [keys, setKeys] = useState<ProfileApiKeyPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [listProblem, setListProblem] = useState<AdminApiProblem | null>(null);
  const [actionProblem, setActionProblem] = useState<AdminApiProblem | null>(null);
  const [copyOnce, setCopyOnce] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<ProfileApiKeyRow | null>(null);
  const [tenantKeys, setTenantKeys] = useState<ApiKeyRow[]>([]);
  const [attachId, setAttachId] = useState('');
  const stored = revision > 0 && profileName.length > 0;

  const load = useCallback(async (): Promise<void> => {
    if (!stored) { setKeys(null); return; }
    setLoading(true);
    setListProblem(null);
    const result = await client.listProfileApiKeys(businessId, businessVersion, profileName);
    if (!result.ok) {
      setListProblem(result.problem);
      setKeys(null);
      setLoading(false);
      return;
    }
    const page = parseProfileApiKeyPage(result.data);
    setKeys(page === null ? { items: [], nextCursor: null, prevCursor: null, total: 0, limit: 0, profileId: '' } : page);
    setLoading(false);
  }, [businessId, businessVersion, client, profileName, stored]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    void client.getSession().then((result) => {
      if (active && result.ok) setSession(result.data);
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    let active = true;
    if (!canMutate || !stored || !tenantId) return () => { active = false; };
    void client.listApiKeys({ tenantId }).then((result) => {
      if (!active || !result.ok) return;
      const items = Array.isArray(result.data.items) ? result.data.items : [];
      setTenantKeys(items.filter((k) => k.status.toUpperCase() === 'ACTIVE'));
    });
    return () => { active = false; };
  }, [canMutate, client, stored, tenantId]);

  const attachedIds = useMemo(() => new Set((keys?.items ?? []).map((k) => k.id)), [keys]);
  const attachable = useMemo(() => tenantKeys.filter((k) => !attachedIds.has(k.id)), [attachedIds, tenantKeys]);

  async function issueAndAttach(): Promise<void> {
    if (!tenantId) return;
    setActionProblem(null);
    setBusy(true);
    try {
      const issued = await client.postAction('apikey.issue', { tenantId }, { idempotencyKey: crypto.randomUUID() });
      if (!issued.ok) { setActionProblem(issued.problem); return; }
      const rawKey = issued.data.rawKey;
      const apiKeyId = issued.data.id;
      if (typeof rawKey !== 'string' || rawKey.length === 0 || typeof apiKeyId !== 'string') {
        setActionProblem({ status: 502, code: 'COPY_ONCE_MISSING', title: 'The issued key was not returned.' });
        return;
      }
      setCopyOnce(rawKey);
      const attachedResult = await client.profileKeyAction(
        businessId, businessVersion, profileName, 'attach', { apiKeyId }, crypto.randomUUID());
      if (!attachedResult.ok) setActionProblem(attachedResult.problem);
      await load();
    } finally { setBusy(false); }
  }

  async function attachExisting(): Promise<void> {
    if (attachId.length === 0) return;
    setActionProblem(null);
    setBusy(true);
    try {
      const result = await client.profileKeyAction(
        businessId, businessVersion, profileName, 'attach', { apiKeyId: attachId }, crypto.randomUUID());
      if (!result.ok) { setActionProblem(result.problem); return; }
      setAttachId('');
      await load();
    } finally { setBusy(false); }
  }

  async function rotate(): Promise<void> {
    const target = rotateTarget;
    if (target === null) return;
    setActionProblem(null);
    setBusy(true);
    try {
      const result = await client.profileKeyAction(
        businessId, businessVersion, profileName, 'rotate', { apiKeyId: target.id }, crypto.randomUUID());
      if (!result.ok) { setActionProblem(result.problem); return; }
      setRotateTarget(null);
      if (typeof result.data.rawKey === 'string' && result.data.rawKey.length > 0) setCopyOnce(result.data.rawKey);
      await load();
    } finally { setBusy(false); }
  }

  if (!stored) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>Save this profile once - a profile that is not stored owns no keys.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <section aria-labelledby="profile-keys-title" className="flex flex-col gap-4 min-w-0">
      <Card>
        <CardHeader>
          <CardTitle id="profile-keys-title">API keys</CardTitle>
          <CardDescription>
            Keys this profile owns. Rotate mints a replacement and revokes the old key immediately, so
            clients still using it start failing on their next request.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {copyOnce !== null ? (
            <AlertBanner variant="warning" title="Copy this key now - it will not be shown again">
              <div className="flex flex-col gap-2">
                <output><code className="break-all">{copyOnce}</code></output>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(copyOnce).catch(() => undefined); }}>
                    Copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCopyOnce(null)}>Dismiss</Button>
                </div>
              </div>
            </AlertBanner>
          ) : null}
          {actionProblem !== null ? (
            <AlertBanner variant="error" title={actionProblem.title ?? 'The action failed.'}>
              {actionProblem.status} - {actionProblem.code ?? 'ERROR'}
            </AlertBanner>
          ) : null}
          {canMutate ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void issueAndAttach()} isLoading={busy} disabled={!tenantId}>
                Issue key for this profile
              </Button>
              {attachable.length > 0 ? (
                <>
                  <select
                    aria-label="Key to attach"
                    className="h-9 rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-xs"
                    value={attachId}
                    onChange={(e) => setAttachId(e.target.value)}
                  >
                    <option value="">Attach an existing key</option>
                    {attachable.map((k) => (
                      <option key={k.id} value={k.id}>{k.name ?? k.maskedHint}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" disabled={attachId.length === 0 || busy} onClick={() => void attachExisting()}>
                    Attach
                  </Button>
                </>
              ) : null}
            </div>
          ) : (
            <Badge variant="warning" dot>admin role required to change this profile keys</Badge>
          )}
          {loading ? <LoadingState title="Loading keys" /> : null}
          {!loading && listProblem !== null ? (
            <ErrorState title={listProblem.title ?? 'Failed to load keys.'} statusCode={listProblem.status} error={listProblem.code} onRetry={() => void load()} />
          ) : null}
          {!loading && listProblem === null && (keys?.items.length ?? 0) === 0 ? (
            <EmptyState title="No keys" description="This profile owns no key yet - issue one, or attach an existing key." actionText="Refresh" onAction={() => void load()} />
          ) : null}
          {!loading && listProblem === null && (keys?.items.length ?? 0) > 0 ? (
            <TableContainer>
              <Table aria-label="Profile API keys">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead><TableHead>Prefix</TableHead><TableHead>Membership</TableHead><TableHead>Key</TableHead><TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys!.items.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className="font-mono">{row.prefix}</TableCell>
                      <TableCell><Badge variant={membershipVariant(row.membershipState)} dot>{row.membershipState}</Badge></TableCell>
                      <TableCell><Badge variant={keyStatusVariant(row.status)} dot>{row.status}</Badge></TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline"
                          disabled={!canMutate || busy || row.membershipState !== 'ACTIVE' || row.status !== 'ACTIVE'}
                          onClick={() => setRotateTarget(row)}>
                          Rotate
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => { if (!open) setRotateTarget(null); }}
        title="Rotate API key"
        description={rotateTarget === null ? '' : 'A replacement for ' + (rotateTarget.name ?? rotateTarget.prefix) + ' is issued and this key is revoked immediately.'}
        confirmText="Rotate"
        isLoading={busy}
        onConfirm={() => void rotate()}
      />
    </section>
  );
}

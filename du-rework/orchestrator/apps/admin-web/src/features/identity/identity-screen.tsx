import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShellStatusBadge } from '@/components/ui/app-shell-primitives';
import { AlertBanner, DeniedState, EmptyState, LoadingState } from '@/components/ui/state-panel';
import { Input } from '@/components/ui/input';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession, type ApiKeyLifecycleRow, type IdentitySnapshot, type IdentityUser, type IdentityUserPage } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';

type SessionState = { kind: 'loading' } | { kind: 'ready'; session: AdminWebSession } | { kind: 'failed'; problem: AdminApiProblem };
type SnapshotState = { kind: 'loading' } | { kind: 'ready'; snapshot: IdentitySnapshot } | { kind: 'failed'; problem: AdminApiProblem };
type UserPageState = { kind: 'loading' } | { kind: 'ready'; page: IdentityUserPage } | { kind: 'failed'; problem: AdminApiProblem };
type AssignmentState = { userId: string; version: number; profileIds: string[]; apiKeyIds: string[] } | null;

const ROLE_OPTIONS = ['ADMIN', 'USER', 'VIEWER'] as const;
const keyFor = () => globalThis.crypto?.randomUUID?.() ?? `identity-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Identity management uses the shared Admin API client for epoch, 401 and CSRF behavior. */
export function IdentityScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const { tenantId, tenant, loading: tenantLoading, tenantLoadError } = useTenant();
  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'loading' });
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ kind: 'loading' });
  const [userPage, setUserPage] = useState<UserPageState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]>('VIEWER');
  const [enabled, setEnabled] = useState(true);
  const [assignments, setAssignments] = useState<AssignmentState>(null);
  const [assignmentProfiles, setAssignmentProfiles] = useState<string[]>([]);
  const [assignmentKeys, setAssignmentKeys] = useState<string[]>([]);
  const [keyOptions, setKeyOptions] = useState<ApiKeyLifecycleRow[]>([]);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const snapshot = snapshotState.kind === 'ready' ? snapshotState.snapshot : null;
  const users = userPage.kind === 'ready' ? userPage.page.items : [];
  const editingUser = users.find((user) => user.id === editingUserId) ?? null;
  const session = sessionState.kind === 'ready' ? sessionState.session : null;
  const localMode = snapshot?.auth.mode === 'local' || snapshot?.auth.mode === 'both';
  const canWriteUsers = session?.role === 'admin' && session.principal.kind === 'platform' && snapshot?.capabilities.userWriter === true && localMode === true && tenantId !== null;

  const loadSnapshot = useCallback(async () => {
    if (!tenantId) { setSnapshotState({ kind: 'failed', problem: { status: 422, code: 'TENANT_REQUIRED', title: 'Select a tenant to load Identity.' } }); return; }
    setSnapshotState({ kind: 'loading' });
    const result = await client.getIdentitySnapshot(tenantId);
    setSnapshotState(result.ok ? { kind: 'ready', snapshot: result.data } : { kind: 'failed', problem: result.problem });
  }, [client, tenantId]);

  const loadUsers = useCallback(async (nextCursor: string | null = null, nextQuery = '') => {
    if (!tenantId) { setUserPage({ kind: 'failed', problem: { status: 422, code: 'TENANT_REQUIRED', title: 'Select a tenant to list users.' } }); return null; }
    setUserPage({ kind: 'loading' });
    const result = await client.listIdentityUsers({ tenantId, limit: '100', ...(nextQuery.trim() ? { query: nextQuery.trim() } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
    if (!result.ok) { setUserPage({ kind: 'failed', problem: result.problem }); return null; }
    setUserPage({ kind: 'ready', page: result.data });
    setCursor(nextCursor);
    return result.data;
  }, [client, tenantId]);

  const refresh = useCallback(async () => {
    await Promise.all([loadSnapshot(), loadUsers(null, query)]);
  }, [loadSnapshot, loadUsers, query]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await client.getSession();
      if (!live) return;
      setSessionState(result.ok ? { kind: 'ready', session: result.data } : { kind: 'failed', problem: result.problem });
    })();
    return () => { live = false; };
  }, [client]);

  useEffect(() => {
    if (sessionState.kind === 'ready' && !tenantLoading) {
      void loadSnapshot();
      void loadUsers(null, '');
    }
  }, [sessionState.kind, tenantLoading, tenantId, loadSnapshot, loadUsers]);

  async function loadAssignmentOptions(): Promise<void> {
    if (!tenantId) { setKeyOptions([]); return; }
    const all: ApiKeyLifecycleRow[] = [];
    let pageCursor: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const result = await client.listApiKeyLifecycle({ tenantId, status: 'ACTIVE', limit: '250', ...(pageCursor ? { cursor: pageCursor } : {}) });
      if (!result.ok) throw new Error(result.problem.title ?? 'API key assignment choices could not be loaded.');
      all.push(...result.data.items.filter((item) => !item.protected));
      const next = result.data.nextCursor;
      if (!next) break;
      if (seen.has(next) || next === pageCursor) throw new Error('API key pagination returned a repeated cursor.');
      seen.add(next); pageCursor = next;
    }
    setKeyOptions(all);
  }

  async function beginEdit(user: IdentityUser): Promise<void> {
    setEditingUserId(user.id); setUsername(user.username); setPassword(''); setResetPassword(''); setRole(user.role); setEnabled(user.enabled);
    setFormError(null); setNotice(null); setAssignments(null); setAssignmentBusy(true);
    try {
      const [read, _options] = await Promise.all([client.getIdentityAssignments(user.id, tenantId!), loadAssignmentOptions()]);
      if (!read.ok) throw new Error(read.problem.title ?? 'Identity assignments could not be loaded.');
      setAssignments(read.data); setAssignmentProfiles(read.data.profileIds); setAssignmentKeys(read.data.apiKeyIds);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Identity assignments could not be loaded.');
    } finally { setAssignmentBusy(false); }
  }

  function beginCreate(): void {
    setEditingUserId(null); setUsername(''); setPassword(''); setResetPassword(''); setRole('VIEWER'); setEnabled(true);
    setAssignments(null); setAssignmentProfiles([]); setAssignmentKeys([]); setFormError(null); setNotice(null);
  }

  async function submitUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canWriteUsers || !tenantId || userPage.kind !== 'ready') { setFormError('The server has not enabled the identity writer. No change was sent.'); return; }
    const current = editingUserId === null ? null : users.find((user) => user.id === editingUserId) ?? null;
    if (editingUserId !== null && !current) { setFormError('This user moved off the current result page. Search for the user again before editing.'); return; }
    setSaving(true); setFormError(null); setNotice(null);
    const result = current === null
      ? await client.createIdentityUser({ username: username.trim(), password, role }, tenantId, keyFor())
      : await client.updateIdentityUser(current.id, { role, enabled, expectedVersion: current.version }, tenantId, keyFor());
    setSaving(false);
    if (!result.ok) { setFormError(problemText(result.problem)); return; }
    const saved = result.data.user;
    if (current === null) setPassword('');
    const refreshed = await loadUsers(null, current === null ? saved.username : query);
    await loadSnapshot();
    if (!refreshed?.items.some((user) => user.id === saved.id)) { setFormError('The server accepted the request but fresh search could not confirm the saved user. Refresh before retrying.'); return; }
    setNotice(current === null ? `User ${saved.username} created and read back.` : `User ${saved.username} updated and read back.`);
    setEditingUserId(saved.id); setUsername(saved.username); setRole(saved.role); setEnabled(saved.enabled); setPassword('');
  }

  async function submitPasswordReset(): Promise<void> {
    if (!canWriteUsers || !tenantId || !editingUser || resetPassword.length < 12) return;
    setSaving(true); setFormError(null); setNotice(null);
    const result = await client.resetIdentityPassword(editingUser.id, { password: resetPassword, expectedVersion: editingUser.version }, tenantId, keyFor());
    setSaving(false); setResetPassword('');
    if (!result.ok) { setFormError(problemText(result.problem)); return; }
    await loadSnapshot();
    const refreshed = await loadUsers(cursor, query);
    const updated = refreshed?.items.find((user) => user.id === editingUser.id);
    if (!updated || updated.version <= editingUser.version) { setFormError('Password reset was accepted, but the new user version could not be confirmed.'); return; }
    setNotice(updated.legacyPasswordResetRequired
      ? `Password reset was accepted for ${updated.username}, but the account remains pending. Unlock it before setting its activation password.`
      : editingUser.legacyPasswordResetRequired
        ? `Imported account ${updated.username} is active with the new password; existing sessions were revoked.`
        : `Password reset for ${updated.username}; existing sessions were revoked.`);
  }

  async function saveAssignments(): Promise<void> {
    if (!canWriteUsers || !tenantId || !editingUser || !assignments) return;
    setSaving(true); setFormError(null); setNotice(null);
    const result = await client.replaceIdentityAssignments(editingUser.id, { expectedVersion: assignments.version, profileIds: [...new Set(assignmentProfiles)].sort(), apiKeyIds: [...new Set(assignmentKeys)].sort() }, tenantId, keyFor());
    setSaving(false);
    if (!result.ok) { setFormError(problemText(result.problem)); return; }
    setAssignments(result.data); setAssignmentProfiles(result.data.profileIds); setAssignmentKeys(result.data.apiKeyIds);
    setNotice('The complete Profile and API-key assignment set was replaced and read back.');
  }

  if (sessionState.kind === 'loading' || tenantLoading) return <LoadingState title="Loading Identity…" />;
  if (sessionState.kind === 'failed') return <DeniedState title={sessionState.problem.status === 401 ? 'Session expired' : 'Identity access unavailable'} description={problemText(sessionState.problem)} />;

  return (
    <section aria-labelledby="identity-title" className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 id="identity-title" className="text-lg font-semibold">Identity</h1><p className="text-sm text-[var(--text-sub)]">Manage local users, revoke sessions through versioned changes, and replace explicit Profile and API-key assignments.</p></div><Badge variant="neutral">session</Badge></header>
      {tenantLoadError ? <AlertBanner variant="error" title="Tenant roster unavailable">{tenantLoadError}</AlertBanner> : null}
      {!tenantId ? <AlertBanner variant="warning" title="Choose a tenant">Select a tenant in the app header before managing Identity.</AlertBanner> : tenant ? <p className="text-sm">Tenant: <strong>{tenant.name}</strong> · <code>{tenant.id}</code></p> : null}

      <Card>
        <CardHeader><CardTitle>Current session</CardTitle><CardDescription>Trusted session and authentication metadata come from the Admin BFF.</CardDescription></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-[var(--text-sub)]">Principal</dt><dd><code>{sessionState.session.displayName}</code> ({sessionState.session.principal.kind})</dd>
            <dt className="text-[var(--text-sub)]">Role</dt><dd><AppShellStatusBadge label={sessionState.session.role} variant={sessionState.session.role === 'admin' ? 'success' : sessionState.session.role === 'operator' ? 'info' : 'neutral'} /><span className="ml-2 text-[var(--text-sub)]">plane: {sessionState.session.plane}</span></dd>
            <dt className="text-[var(--text-sub)]">Tenant scope</dt><dd>{sessionState.session.scope?.kind === 'tenant' ? <code>{sessionState.session.scope.tenantId}</code> : sessionState.session.scope?.kind ?? 'none'}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div className="flex items-center justify-between gap-2"><CardTitle>Authentication mode</CardTitle><Badge variant={snapshot?.auth.mode === 'unmanaged' || !snapshot ? 'warning' : 'info'} dot>{snapshot?.auth.mode ?? 'loading'}</Badge></div><CardDescription>Read-only server metadata. Credentials and tokens are never displayed.</CardDescription></CardHeader>
        <CardContent>
          {snapshotState.kind === 'loading' ? <LoadingState title="Loading authentication metadata…" /> : null}
          {snapshotState.kind === 'failed' ? <AlertBanner variant="error" title={snapshotState.problem.title ?? 'Identity metadata unavailable'}>{problemText(snapshotState.problem)}</AlertBanner> : null}
          {snapshot ? <div className="flex flex-col gap-2 text-sm"><p>Local sign-in: {snapshot.auth.localEnabled ? 'enabled' : 'disabled'}</p>{snapshot.auth.oidc ? <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]"><dt>Issuer</dt><dd className="break-all">{snapshot.auth.oidc.issuer}</dd><dt>Client ID</dt><dd className="break-all">{snapshot.auth.oidc.clientId}</dd><dt>Callback URL</dt><dd className="break-all">{snapshot.auth.oidc.callbackUrl}</dd><dt>Scopes</dt><dd>{snapshot.auth.oidc.scopes.join(', ')}</dd></dl> : <p className="text-[var(--text-sub)]">No OIDC metadata is configured.</p>}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>Users and sessions</CardTitle><Badge variant={canWriteUsers ? 'success' : 'warning'} dot>{canWriteUsers ? 'writer enabled' : 'read only'}</Badge></div><CardDescription>Server search and cursor pagination cover the full tenant directory. Role, enabled status, password reset and assignment mutations use versioned writes.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!canWriteUsers ? <AlertBanner variant="warning" title="User writer unavailable">An enabled local Identity writer and platform Admin session are required for changes.</AlertBanner> : null}
          {formError ? <AlertBanner variant="error" title="Change not confirmed">{formError}</AlertBanner> : null}
          {notice ? <AlertBanner variant="success" title="Identity status">{notice}</AlertBanner> : null}
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]" onSubmit={(event) => { event.preventDefault(); void loadUsers(null, query); }}><label className="flex flex-col gap-1 text-sm">Search users<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Username" /></label><div className="flex items-end gap-2"><Button type="submit" variant="outline" disabled={saving}>Search</Button><Button type="button" variant="outline" disabled={saving} onClick={() => void refresh()}>Refresh</Button></div></form>
          {userPage.kind === 'loading' ? <LoadingState title="Loading users…" /> : null}
          {userPage.kind === 'failed' ? <AlertBanner variant="error" title={userPage.problem.title ?? 'User directory unavailable'}>{problemText(userPage.problem)}</AlertBanner> : null}
          {userPage.kind === 'ready' && users.length === 0 ? <EmptyState title="No users found" description="Try another search or add the first local user." /> : null}
          {users.length > 0 ? <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded border border-[var(--border-subtle)]">{users.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 p-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{user.username}</strong><Badge variant={user.role === 'ADMIN' ? 'info' : 'neutral'}>{user.role}</Badge><Badge variant={user.enabled && !user.locked ? 'success' : 'warning'}>{user.locked ? 'locked' : user.enabled ? 'enabled' : 'disabled'}</Badge>{user.legacyPasswordResetRequired ? <Badge variant="warning">password reset required</Badge> : null}</div><p className="mt-1 text-xs text-[var(--text-sub)]">Version {user.version} · updated {user.updatedAt} · <code>{user.id}</code></p></div><Button size="sm" variant="outline" disabled={!canWriteUsers || saving} onClick={() => void beginEdit(user)}>{editingUserId === user.id ? 'Editing' : 'Edit'}</Button></li>)}</ul> : null}
          {userPage.kind === 'ready' ? <div className="flex items-center justify-between text-sm"><span>{userPage.page.total} users</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!userPage.page.prevCursor || saving} onClick={() => userPage.page.prevCursor && void loadUsers(userPage.page.prevCursor, query)}>Previous</Button><Button size="sm" variant="outline" disabled={!userPage.page.nextCursor || saving} onClick={() => userPage.page.nextCursor && void loadUsers(userPage.page.nextCursor, query)}>Next</Button></div></div> : null}

          <form className="flex flex-col gap-4 rounded border border-[var(--border-subtle)] p-4" onSubmit={(event) => void submitUser(event)}>
            <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{editingUser ? `Edit ${editingUser.username}` : 'Add local user'}</h3><Button type="button" variant="outline" size="sm" onClick={beginCreate}>New user</Button></div>
            <label className="flex flex-col gap-1.5 text-sm">Username<Input autoComplete="username" required disabled={!canWriteUsers || saving || editingUser !== null} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            {!editingUser ? <label className="flex flex-col gap-1.5 text-sm">Initial password<Input type="password" autoComplete="new-password" minLength={12} required disabled={!canWriteUsers || saving} value={password} onChange={(event) => setPassword(event.target.value)} /><span className="text-xs text-[var(--text-sub)]">Write-only; at least 12 characters. Existing sessions are unaffected until a later credential change.</span></label> : null}
            <label className="flex flex-col gap-1.5 text-sm">Role<select className="h-9 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-3" disabled={!canWriteUsers || saving} value={role} onChange={(event) => setRole(event.target.value as (typeof ROLE_OPTIONS)[number])}>{ROLE_OPTIONS.map((item) => <option key={item}>{item}</option>)}</select></label>
            {editingUser ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={!canWriteUsers || saving || editingUser.locked || (editingUser.legacyPasswordResetRequired && !editingUser.enabled)} onChange={(event) => setEnabled(event.target.checked)} />Account enabled</label> : null}
            <Button type="submit" disabled={!canWriteUsers || saving} isLoading={saving}>{editingUser ? 'Save user' : 'Create user'}</Button>
          </form>

          {editingUser ? <>
            <section className="flex flex-col gap-3 rounded border border-[var(--border-subtle)] p-4"><div><h3 className="font-semibold">{editingUser.legacyPasswordResetRequired ? 'Activate imported account' : 'Reset password'}</h3><p className="text-xs text-[var(--text-sub)]">{editingUser.legacyPasswordResetRequired ? 'This imported local account has no usable local password. An administrator-set password activates it only while it is unlocked; the write is versioned and revokes stale sessions on every replica.' : 'The password is write-only; the server increments the live session version so existing local sessions stop working on every replica.'}</p></div><label className="flex flex-col gap-1.5 text-sm">New password<Input type="password" autoComplete="new-password" minLength={12} value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} disabled={!canWriteUsers || saving || editingUser.locked} /></label><Button variant="outline" disabled={!canWriteUsers || saving || resetPassword.length < 12 || editingUser.locked} onClick={() => void submitPasswordReset()}>{editingUser.legacyPasswordResetRequired ? 'Set password, activate, revoke sessions' : 'Reset password and revoke sessions'}</Button></section>
            <section className="flex flex-col gap-3 rounded border border-[var(--border-subtle)] p-4"><div><h3 className="font-semibold">Replace assignments</h3><p className="text-xs text-[var(--text-sub)]">The submitted lists replace the complete set. Local USER operation access requires an assigned active non-Global API key and, for profile-bound operations, that exact Profile too.</p></div>
              {assignmentBusy ? <LoadingState title="Loading assignment set…" /> : assignments ? <>
                <fieldset disabled={!canWriteUsers || saving} className="flex flex-col gap-2"><legend className="text-sm font-medium">Active API keys</legend>{keyOptions.length ? <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded border border-[var(--border-subtle)] p-3 sm:grid-cols-2">{keyOptions.map((key) => <label key={key.id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={assignmentKeys.includes(key.id)} onChange={(event) => setAssignmentKeys((current) => event.target.checked ? [...current, key.id] : current.filter((id) => id !== key.id))} /><span>{key.note || key.prefix} · <code>{key.id}</code></span></label>)}</div> : <p className="text-xs text-[var(--text-sub)]">No eligible active keys were found.</p>}</fieldset>
                <fieldset disabled={!canWriteUsers || saving} className="flex flex-col gap-2"><legend className="text-sm font-medium">Profiles available through active keys</legend>{(() => { const ids = [...new Set([...keyOptions.flatMap((key) => key.profileIds), ...assignments.profileIds])].sort(); return ids.length ? <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded border border-[var(--border-subtle)] p-3 sm:grid-cols-2">{ids.map((id) => <label key={id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={assignmentProfiles.includes(id)} onChange={(event) => setAssignmentProfiles((current) => event.target.checked ? [...current, id] : current.filter((value) => value !== id))} /><span><code>{id}</code></span></label>)}</div> : <p className="text-xs text-[var(--text-sub)]">No eligible Profiles are attached to active API keys.</p>; })()}</fieldset>
                <Button variant="outline" disabled={!canWriteUsers || saving || userPage.kind !== 'ready'} isLoading={saving} onClick={() => void saveAssignments()}>Replace full assignment set</Button>
              </> : <p className="text-sm text-[var(--badge-danger-text)]">Assignment set could not be loaded.</p>}
            </section>
          </> : null}
        </CardContent>
      </Card>
    </section>
  );
}

function problemText(problem: AdminApiProblem): string {
  return `${problem.title ?? 'The server did not confirm the request.'} (${problem.status} · ${problem.code ?? 'ERROR'})`;
}

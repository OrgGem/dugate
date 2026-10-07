import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShellStatusBadge } from '@/components/ui/app-shell-primitives';
import { AlertBanner, DeniedState, EmptyState, LoadingState } from '@/components/ui/state-panel';
import { Input } from '@/components/ui/input';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';
import {
  createIdentityUser,
  readIdentitySnapshot,
  updateIdentityUser,
  type IdentityApiFailure,
  type IdentityRole,
  type IdentitySnapshot,
  type IdentityUser,
} from './identity-api';

type SessionState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: AdminWebSession }
  | { kind: 'failed'; problem: AdminApiProblem };

type IdentityState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: IdentitySnapshot }
  | { kind: 'failed'; error: IdentityApiFailure };

const ROLE_OPTIONS: IdentityRole[] = ['ADMIN', 'USER', 'VIEWER'];

/** Identity surface with server-gated local-user management and safe OIDC metadata. */
export function IdentityScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'loading' });
  const [identityState, setIdentityState] = useState<IdentityState>({ kind: 'loading' });
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<IdentityRole>('VIEWER');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const session = await client.getSession();
      if (!active) return;
      if (!session.ok) {
        setSessionState({ kind: 'failed', problem: session.problem });
        setIdentityState({ kind: 'failed', error: { status: session.status, code: session.problem.code ?? 'SESSION_ERROR' } });
        return;
      }
      setSessionState({ kind: 'ready', session: session.data });
      const identity = await readIdentitySnapshot();
      if (!active) return;
      setIdentityState(identity.ok ? { kind: 'ready', snapshot: identity.data } : { kind: 'failed', error: identity.error });
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const refreshIdentity = useCallback(async () => {
    setIdentityState({ kind: 'loading' });
    const result = await readIdentitySnapshot();
    setIdentityState(result.ok ? { kind: 'ready', snapshot: result.data } : { kind: 'failed', error: result.error });
    return result;
  }, []);

  const snapshot = identityState.kind === 'ready' ? identityState.snapshot : null;
  const editingUser = snapshot?.users.find((user) => user.id === editingUserId) ?? null;
  const localMode = snapshot?.auth.mode === 'local' || snapshot?.auth.mode === 'both';
  const canWriteUsers =
    sessionState.kind === 'ready' &&
    sessionState.session.role === 'admin' &&
    snapshot?.capabilities.userWriter === true &&
    localMode === true;

  function beginCreate(): void {
    setEditingUserId(null);
    setUsername('');
    setPassword('');
    setRole('VIEWER');
    setEnabled(true);
    setFormError(null);
    setNotice(null);
  }

  function beginEdit(user: IdentityUser): void {
    setEditingUserId(user.id);
    setUsername(user.username);
    setPassword('');
    setRole(user.role);
    setEnabled(user.enabled);
    setFormError(null);
    setNotice(null);
  }

  async function submitUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canWriteUsers || sessionState.kind !== 'ready' || snapshot === null) {
      setFormError('The server has not enabled the identity writer. No change was sent.');
      return;
    }
    const currentUser = editingUserId === null ? null : snapshot.users.find((user) => user.id === editingUserId) ?? null;
    if (editingUserId !== null && currentUser === null) {
      setFormError('This user is no longer in the latest server snapshot. Reload before editing.');
      return;
    }

    setSaving(true);
    setFormError(null);
    setNotice(null);
    const result =
      currentUser === null
        ? await createIdentityUser({ username: username.trim(), password, role }, sessionState.session.csrfToken)
        : await updateIdentityUser(
            currentUser,
            { role, enabled, expectedVersion: currentUser.version },
            sessionState.session.csrfToken,
          );
    if (!result.ok) {
      setSaving(false);
      setFormError(identityMutationMessage(result.error));
      return;
    }

    if (currentUser === null) setPassword('');
    const readback = await readIdentitySnapshot();
    setSaving(false);
    if (!readback.ok) {
      setIdentityState({ kind: 'failed', error: readback.error });
      setFormError('The server accepted the request, but a fresh read could not confirm the saved user. Reload before retrying.');
      return;
    }
    setIdentityState({ kind: 'ready', snapshot: readback.data });
    const saved = readback.data.users.find((user) => user.id === result.data.id);
    const matches =
      saved !== undefined &&
      saved.role === role &&
      (currentUser === null || (saved.enabled === enabled && saved.version > currentUser.version));
    if (!matches) {
      setFormError('The latest server read does not match the requested change. No success was reported.');
      return;
    }

    const savedUsername = saved.username;
    setNotice(currentUser === null ? `User ${savedUsername} was created and read back.` : `User ${savedUsername} was updated and read back.`);
    setEditingUserId(null);
    setUsername('');
    setPassword('');
    setRole('VIEWER');
    setEnabled(true);
  }

  return (
    <section aria-labelledby="identity-title" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="identity-title" className="text-lg font-semibold">
          Identity
        </h1>
        <Badge variant="neutral">session</Badge>
      </div>

      {sessionState.kind === 'loading' ? <LoadingState title="Loading session…" /> : null}
      {sessionState.kind === 'failed' ? (
        sessionState.problem.status === 403 ? (
          <DeniedState title="Access denied" description={sessionState.problem.title ?? 'Not authorized.'} />
        ) : (
          <AlertBanner variant="error" title={sessionState.problem.title ?? 'Failed to load the session.'}>
            {sessionState.problem.status} · {sessionState.problem.code ?? 'ERROR'}
            {sessionState.problem.status === 401 ? (
              <>
                {' '}
                <a className="underline" href="/admin/login">
                  Sign in again
                </a>
              </>
            ) : null}
          </AlertBanner>
        )
      ) : null}

      {sessionState.kind === 'ready' ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Current session</CardTitle>
              <CardDescription>Live from /admin/api/session (no-store).</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
                <dt className="text-[var(--text-sub)]">Principal</dt>
                <dd className="min-w-0 break-words">
                  <code>{sessionState.session.displayName}</code> ({sessionState.session.principal.kind})
                </dd>
                <dt className="text-[var(--text-sub)]">Role</dt>
                <dd>
                  <AppShellStatusBadge
                    label={sessionState.session.role}
                    variant={sessionState.session.role === 'admin' ? 'success' : sessionState.session.role === 'operator' ? 'info' : 'neutral'}
                  />
                  <span className="ml-2 text-[var(--text-sub)]">plane: {sessionState.session.plane}</span>
                </dd>
                <dt className="text-[var(--text-sub)]">Tenant scope</dt>
                <dd className="min-w-0 break-words">
                  {sessionState.session.scope === null ? (
                    <span className="text-[var(--text-sub)]">none — this session has no admin principal</span>
                  ) : sessionState.session.scope.kind === 'platform' ? (
                    <span>platform</span>
                  ) : (
                    <code>{sessionState.session.scope.tenantId}</code>
                  )}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Auth mode</CardTitle>
                <Badge variant={snapshot?.auth.mode === 'unmanaged' || snapshot === null ? 'warning' : 'info'} dot>
                  {snapshot?.auth.mode === 'unmanaged' || snapshot === null ? 'chưa managed' : snapshot.auth.mode}
                </Badge>
              </div>
              <CardDescription>
                <code>DU_ADMIN_AUTH_MODE</code> is server-owned. This screen displays only metadata returned by the
                identity API and does not infer or enable an authentication mode.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {snapshot === null || snapshot.auth.mode === 'unmanaged' ? (
                <p className="text-xs text-[var(--text-sub)]">
                  Evidence: no managed auth-mode metadata is available from the identity API on this deployment.
                </p>
              ) : (
                <p className="text-xs text-[var(--text-sub)]">
                  Local sign-in: {snapshot.auth.localEnabled ? 'enabled' : 'disabled'}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>OIDC metadata</CardTitle>
              <CardDescription>Read-only configuration metadata; credentials and tokens are never displayed.</CardDescription>
            </CardHeader>
            <CardContent>
              {identityState.kind === 'loading' ? (
                <LoadingState title="Loading identity metadata…" />
              ) : identityState.kind === 'failed' ? (
                <p className="text-sm text-[var(--text-sub)]">OIDC metadata is unavailable until the identity API is connected.</p>
              ) : identityState.snapshot.auth.oidc === null ? (
                <p className="text-sm text-[var(--text-sub)]">No OIDC metadata is configured or available.</p>
              ) : (
                <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                  <dt className="text-[var(--text-sub)]">Issuer</dt>
                  <dd className="min-w-0 break-all"><code>{identityState.snapshot.auth.oidc.issuer}</code></dd>
                  <dt className="text-[var(--text-sub)]">Client ID</dt>
                  <dd className="min-w-0 break-all"><code>{identityState.snapshot.auth.oidc.clientId}</code></dd>
                  <dt className="text-[var(--text-sub)]">Callback URL</dt>
                  <dd className="min-w-0 break-all"><code>{identityState.snapshot.auth.oidc.callbackUrl}</code></dd>
                  <dt className="text-[var(--text-sub)]">Scopes</dt>
                  <dd className="min-w-0 break-words">{identityState.snapshot.auth.oidc.scopes.join(', ') || 'none'}</dd>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Users &amp; sessions</CardTitle>
                <Badge variant={canWriteUsers ? 'success' : 'warning'} dot>
                  {canWriteUsers ? 'writer enabled' : 'read only'}
                </Badge>
              </div>
              <CardDescription>
                User records are loaded from the identity API. The owner LOCAL/OIDC must enforce role, scope, CSRF,
                audit, and session-revocation policy on every request.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              {identityState.kind === 'loading' ? <LoadingState title="Loading users…" /> : null}
              {identityState.kind === 'failed' ? (
                <AlertBanner variant="error" title={identityFailureTitle(identityState.error)}>
                  {identityState.error.status} · {identityState.error.code}. User management is unavailable and writes are disabled.
                  {identityState.error.status === 401 ? (
                    <>
                      {' '}
                      <a className="underline" href="/admin/login">Sign in again</a>
                    </>
                  ) : null}
                </AlertBanner>
              ) : null}
              {identityState.kind === 'ready' ? (
                <>
                  {!canWriteUsers ? (
                    <AlertBanner variant="warning" title="User writer unavailable">
                      The server has not advertised an enabled local-user writer for this session. All create and update controls stay disabled.
                    </AlertBanner>
                  ) : null}
                  {identityState.snapshot.users.length === 0 ? (
                    <EmptyState title="No users" description="No local users are present in the current server snapshot." />
                  ) : (
                    <ul className="flex min-w-0 flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)]">
                      {identityState.snapshot.users.map((user) => (
                        <li key={user.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="break-all font-medium">{user.username}</span>
                              <Badge variant={user.role === 'ADMIN' ? 'info' : 'neutral'}>{user.role}</Badge>
                              <Badge variant={user.enabled && !user.locked ? 'success' : 'warning'}>
                                {user.locked ? 'locked' : user.enabled ? 'enabled' : 'disabled'}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-[var(--text-sub)]">Updated {user.updatedAt}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canWriteUsers || user.locked}
                            onClick={() => beginEdit(user)}
                            aria-label={`Edit ${user.username}`}
                          >
                            Edit
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {notice ? <AlertBanner variant="success" title="Saved and verified">{notice}</AlertBanner> : null}

                  <form className="flex min-w-0 flex-col gap-4 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-4" onSubmit={(event) => void submitUser(event)}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold">{editingUser === null ? 'Add local user' : `Update ${editingUser.username}`}</h3>
                      {editingUserId !== null ? (
                        <Button type="button" variant="ghost" size="sm" onClick={beginCreate}>Cancel edit</Button>
                      ) : null}
                    </div>
                    <label className="flex min-w-0 flex-col gap-1.5 text-sm" htmlFor="identity-username">
                      Username
                      <Input
                        id="identity-username"
                        name="identity-username"
                        autoComplete="username"
                        required
                        disabled={!canWriteUsers || saving || editingUser !== null}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                      />
                    </label>
                    {editingUser === null ? (
                      <label className="flex min-w-0 flex-col gap-1.5 text-sm" htmlFor="identity-password">
                        Initial password
                        <Input
                          id="identity-password"
                          name="identity-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          disabled={!canWriteUsers || saving}
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                        <span className="text-xs text-[var(--text-sub)]">Write-only. This value is sent to the server and is never returned or displayed.</span>
                      </label>
                    ) : null}
                    <label className="flex min-w-0 flex-col gap-1.5 text-sm" htmlFor="identity-role">
                      Role
                      <select
                        id="identity-role"
                        name="identity-role"
                        className="h-9 w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!canWriteUsers || saving}
                        value={role}
                        onChange={(event) => setRole(event.target.value as IdentityRole)}
                      >
                        {ROLE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </label>
                    {editingUser !== null ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="identity-enabled"
                          checked={enabled}
                          disabled={!canWriteUsers || saving || editingUser.locked}
                          onChange={(event) => setEnabled(event.target.checked)}
                        />
                        Account enabled
                      </label>
                    ) : null}
                    {formError ? <AlertBanner variant="error" title="User change not confirmed">{formError}</AlertBanner> : null}
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={!canWriteUsers} isLoading={saving}>
                        {editingUser === null ? 'Create user' : 'Save user'}
                      </Button>
                      <Button type="button" variant="outline" disabled={identityState.kind !== 'ready' || saving} onClick={() => void refreshIdentity()}>
                        Refresh users
                      </Button>
                    </div>
                  </form>
                </>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}

function identityFailureTitle(error: IdentityApiFailure): string {
  if (error.status === 401) return 'Session expired';
  if (error.status === 403) return 'Access denied';
  if (error.status === 404 || error.status === 501 || error.status === 503) return 'Identity management API unavailable';
  if (error.status === 0) return 'Identity management API could not be reached';
  return 'Failed to load identity data';
}

function identityMutationMessage(error: IdentityApiFailure): string {
  if (error.status === 401) return 'Your session expired. Sign in again before making a change.';
  if (error.status === 403) return 'The server denied this identity change.';
  if (error.status === 409) return 'This user changed on the server. Refresh the list and review the latest role and status.';
  if (error.status === 422) return 'The server rejected one or more user fields. Review the form and try again.';
  if (error.status === 0) return 'The server could not be reached. The change was not confirmed.';
  return 'The server did not confirm this identity change.';
}

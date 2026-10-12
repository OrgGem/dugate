import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CostAlertInboxPage,
  type CostAlertList,
  type CostAlertKind,
} from '@du/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/select';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';

type PageState<T> =
  | { kind: 'loading' }
  | { kind: 'failed'; problem: AdminApiProblem }
  | { kind: 'ready'; data: T };

const ALERT_KINDS: Array<{ value: CostAlertKind | ''; label: string }> = [
  { value: '', label: 'All alert types' },
  { value: 'threshold', label: 'Warning threshold' },
  { value: 'limit', label: 'Budget limit' },
  { value: 'trust_gap', label: 'Trust gap' },
];

function formatTime(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function trustReason(code: string | null): string {
  switch (code) {
    case 'BOUND_UNSUPPORTED': return 'The provider request has no supported upper-bound proof.';
    case 'PRICE_UNAVAILABLE': return 'A published price was unavailable for the selected provider and model.';
    case 'USAGE_BASIS_UNBOUNDED': return 'Earlier usage contains an unbounded or legacy cost record.';
    case 'RESERVATION_BASIS_UNBOUNDED': return 'An unresolved reservation has no trusted upper bound.';
    default: return 'Usage is best effort; no hard-cap availability is claimed.';
  }
}

function AlertFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-[var(--text-sub)]">{label}</dt><dd className="mt-0.5 break-all text-xs font-medium">{value}</dd></div>;
}

export function CostAlertsPanel({ tenantId, budgetId, session }: { tenantId: string; budgetId?: string; session: AdminWebSession }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [kind, setKind] = useState<CostAlertKind | ''>('');
  const [alertsPage, setAlertsPage] = useState(0);
  const [alertCursors, setAlertCursors] = useState<Array<string | undefined>>([undefined]);
  const [alerts, setAlerts] = useState<PageState<CostAlertList>>({ kind: 'loading' });
  const [inbox, setInbox] = useState<PageState<CostAlertInboxPage> | null>(null);
  const [inboxUnreadOnly, setInboxUnreadOnly] = useState(true);
  const [inboxPage, setInboxPage] = useState(0);
  const [inboxCursors, setInboxCursors] = useState<Array<string | undefined>>([undefined]);
  const [busyAlertId, setBusyAlertId] = useState<string | null>(null);
  const [recipientSetup, setRecipientSetup] = useState<'idle' | 'pending' | 'ready' | 'failed'>('idle');
  const [refresh, setRefresh] = useState(0);
  const canRegisterOidcInbox = session.plane === 'oidc' && session.role === 'admin' && session.principal.kind === 'platform';

  useEffect(() => {
    setAlertCursors([undefined]);
    setAlertsPage(0);
    setInboxCursors([undefined]);
    setInboxPage(0);
  }, [tenantId, budgetId]);

  useEffect(() => {
    let active = true;
    const cursor = alertCursors[alertsPage];
    setAlerts({ kind: 'loading' });
    void client.listCostAlerts({
      tenantId,
      limit: 25,
      ...(cursor ? { cursor } : {}),
      ...(budgetId ? { budgetId } : {}),
      ...(kind ? { kind } : {}),
    }).then((result) => {
      if (!active) return;
      if (!result.ok) setAlerts({ kind: 'failed', problem: result.problem });
      else setAlerts({ kind: 'ready', data: result.data });
    }).catch(() => {
      if (active) setAlerts({ kind: 'failed', problem: { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Alert history could not be reached.' } });
    });
    return () => { active = false; };
  }, [client, tenantId, budgetId, kind, alertCursors, alertsPage, refresh]);

  useEffect(() => {
    let active = true;
    const cursor = inboxCursors[inboxPage];
    setInbox({ kind: 'loading' });
    void client.listCostAlertInbox({ tenantId, limit: 25, unreadOnly: inboxUnreadOnly, ...(cursor ? { cursor } : {}) }).then((result) => {
      if (!active) return;
      if (!result.ok) setInbox({ kind: 'failed', problem: result.problem });
      else setInbox({ kind: 'ready', data: result.data });
    }).catch(() => {
      if (active) setInbox({ kind: 'failed', problem: { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Owner inbox could not be reached.' } });
    });
    return () => { active = false; };
  }, [client, tenantId, inboxUnreadOnly, inboxCursors, inboxPage, refresh]);

  const refreshNow = useCallback(() => setRefresh((value) => value + 1), []);
  const changeKind = (value: string) => {
    setKind(value as CostAlertKind | '');
    setAlertCursors([undefined]);
    setAlertsPage(0);
  };
  const changeInboxFilter = (value: string) => {
    setInboxUnreadOnly(value === 'unread');
    setInboxCursors([undefined]);
    setInboxPage(0);
  };

  const markRead = async (alertId: string) => {
    setBusyAlertId(alertId);
    try {
      const result = await client.markCostAlertInboxRead(alertId, tenantId);
      if (!result.ok) {
        setInbox({ kind: 'failed', problem: result.problem });
        return;
      }
      refreshNow();
    } catch {
      setInbox({ kind: 'failed', problem: { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'The owner inbox receipt could not be saved.' } });
    } finally {
      setBusyAlertId(null);
    }
  };

  const registerOwnInbox = async () => {
    setRecipientSetup('pending');
    try {
      const result = await client.ensureCostAlertSelfRecipient();
      if (!result.ok) {
        setRecipientSetup('failed');
        return;
      }
      setRecipientSetup('ready');
      refreshNow();
    } catch {
      setRecipientSetup('failed');
    }
  };

  const nextAlerts = () => {
    if (alerts.kind !== 'ready' || !alerts.data.nextCursor) return;
    const next = alerts.data.nextCursor;
    setAlertCursors((current) => [...current.slice(0, alertsPage + 1), next]);
    setAlertsPage((page) => page + 1);
  };
  const previousAlerts = () => setAlertsPage((page) => Math.max(0, page - 1));
  const nextInbox = () => {
    if (inbox?.kind !== 'ready' || !inbox.data.nextCursor) return;
    const next = inbox.data.nextCursor;
    setInboxCursors((current) => [...current.slice(0, inboxPage + 1), next]);
    setInboxPage((page) => page + 1);
  };
  const previousInbox = () => setInboxPage((page) => Math.max(0, page - 1));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Cost alerts</CardTitle>
              <CardDescription>Persisted threshold, limit, and trust-gap events from reservation preflight and final usage settlement.</CardDescription>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={refreshNow}>Refresh alerts</Button>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(12rem,18rem)_1fr]">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold">
              Alert type
              <NativeSelect aria-label="Filter alerts by type" value={kind} onChange={(event) => changeKind(event.target.value)}>
                {ALERT_KINDS.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}
              </NativeSelect>
            </label>
            <p className="self-end text-xs text-[var(--text-sub)]">Alert history is tenant scoped and cursor bounded. Owner and channel references stay frozen to the exact budget and binding revisions.</p>
          </div>
          {alerts.kind === 'loading' ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading alert history…</p> : null}
          {alerts.kind === 'failed' ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{alerts.problem.status === 403 ? 'Alert history is not available to this Admin session.' : alerts.problem.title ?? 'Alert history failed to load.'}</p> : null}
          {alerts.kind === 'ready' && alerts.data.items.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No alert events match this tenant and filter.</p> : null}
          {alerts.kind === 'ready' && alerts.data.items.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-3">
              {alerts.data.items.map((alert) => (
                <article key={alert.alertId} className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sub)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant={alert.kind === 'trust_gap' ? 'warning' : alert.kind === 'limit' ? 'danger' : 'info'}>{alert.kind.replace('_', ' ')}</Badge>
                      <span className="break-all text-xs font-medium">Budget {alert.budgetId.slice(0, 8)}… · revision {alert.budgetRevision}</span>
                    </div>
                    <time className="text-xs text-[var(--text-sub)]" dateTime={alert.createdAt}>{formatTime(alert.createdAt)}</time>
                  </div>
                  <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <AlertFact label="Source" value={`${alert.source} · ${alert.evaluation.action}`} />
                    <AlertFact label="Usage" value={`${alert.evaluation.usagePercent}% · ${alert.evaluation.limitExceeded ? 'limit exceeded' : alert.evaluation.warnThresholdExceeded ? 'warning threshold reached' : 'below threshold'}`} />
                    <AlertFact label="Remaining basis" value={`${alert.evaluation.remainingTokens.toLocaleString()} tokens · ${alert.evaluation.remainingCostMicrousd.toLocaleString()} micro-USD`} />
                    <AlertFact label="Trust" value={alert.trust.confidence === 'upper-bound' ? 'Verified upper bound' : 'Best effort'} />
                    <AlertFact label="Reservation group" value={alert.reservationGroupId} />
                    <AlertFact label="Operation / attempt" value={`${alert.operationId} · ${alert.attempt}`} />
                    <AlertFact label="Task / invocation" value={`${alert.taskId} · ${alert.invocationId}`} />
                    <AlertFact label="Settled usage event" value={alert.usageEventId ?? 'Preflight only; usage has not settled'} />
                    <AlertFact label="Owner snapshot" value={alert.owner ? `${alert.owner.displayName} · binding ${alert.bindingRevision ?? 'unknown'}` : 'No owner was configured at enqueue time'} />
                    <AlertFact label="Delivery" value={alert.deliveries.map((delivery) => `${delivery.channelName} r${delivery.channelRevision}: ${delivery.state.toLowerCase()} (${delivery.attempts}/${delivery.maxAttempts})`).join(' · ') || 'Unrouted; no delivery was queued'} />
                  </dl>
                  {alert.trust.reasonCode ? <p className="mt-3 text-xs text-[var(--badge-warning-text)]">{trustReason(alert.trust.reasonCode)}</p> : null}
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer font-medium">Delivery attempts and source</summary>
                    <div className="mt-2 grid gap-2 text-[var(--text-sub)] sm:grid-cols-2">
                      <p className="break-all">Source event: {alert.sourceEventKey}</p>
                      <p className="break-all">Window: {formatTime(alert.windowStart)} – {formatTime(alert.windowEnd)}</p>
                      {alert.deliveries.flatMap((delivery) => delivery.history.map((attempt) => (
                        <p key={`${delivery.channelId}-${attempt.attempt}`}>
                          {delivery.channelName} attempt {attempt.attempt}: {attempt.state.toLowerCase()}
                          {attempt.errorCode ? ` · ${attempt.errorCode}` : ''}
                          {attempt.finishedAt ? ` · ${formatTime(attempt.finishedAt)}` : ' · in progress'}
                        </p>
                      )))}
                    </div>
                  </details>
                </article>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
                <span className="text-xs text-[var(--text-sub)]">Page {alertsPage + 1} · up to {alerts.data.limit} events</span>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={previousAlerts} disabled={alertsPage === 0}>Previous</Button>
                  <Button type="button" size="sm" variant="outline" onClick={nextAlerts} disabled={!alerts.data.hasMore}>Next</Button>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Owner notification inbox</CardTitle>
              <CardDescription>Durable in-app alerts delivered to the bound local or external OIDC tenant Admin owner. Only that current identity can read or acknowledge its inbox.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canRegisterOidcInbox && recipientSetup !== 'ready' ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void registerOwnInbox()} disabled={recipientSetup === 'pending'}>
                  {recipientSetup === 'pending' ? 'Registering…' : 'Register this Admin for inbox'}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={refreshNow}>Refresh inbox</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {canRegisterOidcInbox && recipientSetup === 'idle' ? <p className="text-xs text-[var(--text-sub)]">Register this signed-in platform Admin once to receive owner-scoped budget notifications. This links only the in-app alert inbox; it does not change your ordinary Admin access.</p> : null}
          {recipientSetup === 'ready' ? <p role="status" className="text-xs text-[var(--badge-success-text)]">This Admin is registered for the owner inbox. Refreshing notifications…</p> : null}
          {recipientSetup === 'failed' ? <p role="alert" className="text-xs text-[var(--badge-danger-text)]">This Admin could not be registered for the owner inbox. Check the current platform Admin session and try again.</p> : null}
          <label className="flex max-w-xs flex-col gap-1.5 text-xs font-semibold">
            Show notifications
            <NativeSelect aria-label="Filter owner inbox" value={inboxUnreadOnly ? 'unread' : 'all'} onChange={(event) => changeInboxFilter(event.target.value)}>
              <option value="unread">Unread only</option>
              <option value="all">All notifications</option>
            </NativeSelect>
          </label>
          {inbox?.kind === 'loading' ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading owner inbox…</p> : null}
          {inbox?.kind === 'failed' ? <p role="status" className="text-sm text-[var(--text-sub)]">{inbox.problem.status === 403 ? 'Sign in as the current local tenant Admin or registered external OIDC Admin assigned as the budget owner to view this inbox.' : inbox.problem.title ?? 'Owner inbox failed to load.'}</p> : null}
          {inbox?.kind === 'ready' && inbox.data.items.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No notifications in this inbox page.</p> : null}
          {inbox?.kind === 'ready' && inbox.data.items.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              {inbox.data.items.map((item) => (
                <article key={`${item.alertId}-${item.deliveredAt}`} className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={item.kind === 'trust_gap' ? 'warning' : item.kind === 'limit' ? 'danger' : 'info'}>{item.kind.replace('_', ' ')}</Badge>
                      <span className="text-sm font-medium">{item.evaluation.action} · budget {item.budgetId.slice(0, 8)}… r{item.budgetRevision}</span>
                      {item.readAt ? <Badge variant="neutral">read</Badge> : <Badge variant="success">new</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-sub)]">Delivered {formatTime(item.deliveredAt)} · {item.evaluation.usagePercent}% used · {item.trust.confidence === 'upper-bound' ? 'upper bound verified' : trustReason(item.trust.reasonCode)}</p>
                    {item.trust.reasonCode ? <p className="mt-1 text-xs text-[var(--badge-warning-text)]">{trustReason(item.trust.reasonCode)}</p> : null}
                  </div>
                  {!item.readAt ? <Button type="button" size="sm" variant="outline" onClick={() => void markRead(item.alertId)} disabled={busyAlertId === item.alertId}>{busyAlertId === item.alertId ? 'Saving…' : 'Mark as read'}</Button> : null}
                </article>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
                <span className="text-xs text-[var(--text-sub)]">Page {inboxPage + 1} · up to {inbox.data.limit} notifications</span>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={previousInbox} disabled={inboxPage === 0}>Previous</Button>
                  <Button type="button" size="sm" variant="outline" onClick={nextInbox} disabled={!inbox.data.hasMore}>Next</Button>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

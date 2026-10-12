import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import type { AdminApiClient } from '@/lib/api/client';

type Delivery = {
  deliveryId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  canRetry: boolean;
  disabledReason: string | null;
};

export function CallbackDeliveries({ client, operationId, canManage }: { client: AdminApiClient; operationId: string; canManage: boolean }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyDeliveryId, setBusyDeliveryId] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<Delivery | null>(null);
  const fence = useRef(0);
  const retryInFlight = useRef(false);
  const actionKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const request = ++fence.current;
    setLoading(true);
    setItems(null);
    setLoadProblem(null);
    try {
      const result = await client.getOperationDeliveries(operationId);
      if (request !== fence.current) return;
      if (result.ok) {
        setItems(result.data.items);
      } else {
        setLoadProblem(result.problem.title ?? 'Callback delivery status is unavailable.');
      }
    } catch {
      if (request === fence.current) setLoadProblem('Callback delivery status is unavailable. Check the connection and retry.');
    } finally {
      if (request === fence.current) setLoading(false);
    }
  }, [client, operationId]);

  useEffect(() => {
    void load();
    return () => { fence.current++; };
  }, [load]);

  const retry = async (delivery: Delivery) => {
    if (retryInFlight.current || busyDeliveryId !== null || !canManage || !delivery.canRetry) return;
    retryInFlight.current = true;
    const request = ++fence.current;
    const scope = `${delivery.deliveryId}:${delivery.attempts}`;
    const idempotencyKey = actionKeys.current.get(scope) ?? crypto.randomUUID();
    actionKeys.current.set(scope, idempotencyKey);
    setBusyDeliveryId(delivery.deliveryId);
    setLoadProblem(null);
    setActionProblem(null);
    setNotice(null);
    let refreshAfterAction = false;
    try {
      const result = await client.postAction('operations.callback.retry', {
        operationId,
        deliveryId: delivery.deliveryId,
        expectedAttempts: delivery.attempts,
      }, { idempotencyKey });
      if (request !== fence.current) return;
      if (result.ok) {
        actionKeys.current.delete(scope);
        setPendingRetry(null);
        setNotice('One retry attempt was queued for the same delivery ID. Refresh to see its outcome.');
      } else {
        setActionProblem(`${result.problem.title ?? 'Callback retry failed.'} Refresh the delivery before trying again.`);
      }
      refreshAfterAction = true;
    } catch {
      if (request === fence.current) setActionProblem('Callback retry outcome is unknown. Refresh before trying again; the recipient may have received it.');
    } finally {
      retryInFlight.current = false;
      if (request === fence.current) setBusyDeliveryId(null);
    }
    if (refreshAfterAction && request === fence.current) await load();
  };

  return <section className="space-y-3 rounded-lg border p-4" aria-label="Callback deliveries">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Callback deliveries</h3>
      <Button size="sm" variant="outline" disabled={loading || busyDeliveryId !== null} onClick={() => void load()}>Refresh callbacks</Button>
    </div>
    <p className="text-sm">Callbacks reuse the original delivery ID and payload. A lost response can mean the recipient already processed it; check the failure before retrying.</p>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {actionProblem && <p role="alert" className="text-sm">{actionProblem}</p>}
    {loadProblem && <div role="alert" className="space-y-2 text-sm"><p>{loadProblem}</p><Button size="sm" variant="outline" disabled={loading || busyDeliveryId !== null} onClick={() => void load()}>Retry loading callbacks</Button></div>}
    {loading ? <p role="status">Loading callback status…</p> : null}
    {!loading && !loadProblem && items?.length === 0 ? <p>No callback deliveries recorded.</p> : null}
    {!loading && !loadProblem && items?.map(item => <div key={item.deliveryId} className="space-y-2 border-t pt-3 text-sm">
      <p className="break-all font-mono">{item.deliveryId}</p>
      <p>{item.status} · {item.attempts} / {item.maxAttempts} attempts</p>
      {item.lastError && <p>Failure: {item.lastError}</p>}
      {item.status === 'PENDING' && item.nextAttemptAt && <p>Next attempt: {new Date(item.nextAttemptAt).toLocaleString()}</p>}
      {item.disabledReason && <p>{item.disabledReason}</p>}
      <Button size="sm" variant="outline" disabled={loading || busyDeliveryId !== null || !canManage || !item.canRetry} onClick={() => setPendingRetry(item)}>Review one retry</Button>
    </div>)}
    <ConfirmDialog
      open={pendingRetry !== null}
      onOpenChange={(open) => { if (!open && busyDeliveryId === null) setPendingRetry(null); }}
      title="Retry this callback once?"
      description={pendingRetry
        ? `This queues one bounded attempt for delivery ${pendingRetry.deliveryId} (${pendingRetry.attempts} of ${pendingRetry.maxAttempts} attempts used). The same ID and payload are reused. The recipient may already have processed it, so confirm only when it can deduplicate by delivery ID.`
        : 'Review the callback before retrying.'}
      confirmText="Queue one retry"
      cancelText="Go back"
      variant="destructive"
      isLoading={busyDeliveryId !== null}
      onConfirm={() => { if (pendingRetry) void retry(pendingRetry); }}
    />
  </section>;
}

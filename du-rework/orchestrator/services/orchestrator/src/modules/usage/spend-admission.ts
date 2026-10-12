import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { UsageEventSchema } from '@du/contracts';
import { loadEffectiveCharges } from './effective-charges';

type Reader = Pick<Db, 'query'>;
/** Decimal database money is never compared through IEEE754. */
export function usdMicros(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Stored billing amount is invalid.');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? '').padEnd(6, '0')));
}
export async function readKeySpend(db: Reader, apiKeyId: string, tenantId?: string) {
  const result = await db.query<{ name: string | null; spending_limit: string; total_used: string; tenant_id: string }>(
    `SELECT k.name,k.spending_limit::text,k.total_used::text,k.tenant_id::text AS tenant_id
       FROM api_keys k WHERE k.id=$1 AND ($2::text IS NULL OR k.tenant_id=$2::uuid)`,
    [apiKeyId, tenantId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'API key is not available in this tenant.');
  const events = await db.query<{ event_id: string; tenant_id: string; payload: unknown }>(
    `SELECT ue.event_id,o.tenant_id::text AS tenant_id,ue.payload
       FROM usage_events ue JOIN operations o ON o.id=ue.operation_id
      WHERE o.api_key_id=$1 AND o.tenant_id=$2::uuid AND o.legacy_history IS NULL AND o.state='SUCCEEDED'
      ORDER BY ue.event_id`,
    [apiKeyId, row.tenant_id],
  );
  let newCost = 0n;
  for (let offset = 0; offset < events.rows.length; offset += 250) {
    const batch = events.rows.slice(offset, offset + 250);
    const projections = await loadEffectiveCharges(db, batch.map((event) => ({
      event_id: event.event_id, tenant_id: event.tenant_id, payload: event.payload,
    })));
    for (const entry of batch) {
      if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Stored usage event is invalid.');
      }
      const payload = entry.payload as Record<string, unknown>;
      if (payload['costStatus'] === 'unpriced' || payload['costStatus'] === 'pending') continue;
      const projection = projections.get(entry.event_id);
      const projectedCost = projection?.netChargeMicrousd;
      if (projectedCost !== null && projectedCost !== undefined) {
        newCost += BigInt(projectedCost);
        continue;
      }
      const parsed = UsageEventSchema.safeParse(payload);
      const raw = parsed.success && parsed.data.eventId === entry.event_id
        ? parsed.data.costMicrousd
        : payload['costMicrousd'];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Stored usage amount is invalid.');
      }
      newCost += BigInt(raw);
    }
  }
  return { name: row.name, limit: usdMicros(row.spending_limit), used: usdMicros(row.total_used) + newCost };
}
export async function assertKeySpendAvailable(db: Reader, apiKeyId: string, tenantId: string): Promise<void> {
  const spend = await readKeySpend(db, apiKeyId, tenantId);
  if (spend.limit > 0n && spend.used >= spend.limit) {
    const cents = (spend.limit + 5_000n) / 10_000n;
    const limit = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
    throw new HttpError(402, 'SPENDING_LIMIT_EXCEEDED', `API key spending limit of $${limit} USD has been reached.`, {
      type: 'https://dugate.vn/errors/spending-limit-exceeded', title: 'Payment Required',
    });
  }
}
export function moneyAsUsd(micros: bigint): number {
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) || micros < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Billing total exceeds the wire integer range.');
  }
  return Number(micros) / 1_000_000;
}

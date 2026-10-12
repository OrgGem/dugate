import {
  UsageEventSchema,
  canonicalize,
  type UsageEvent,
} from '@du/contracts';
import type { QueryResultRow } from 'pg';
import { HttpError } from '../../http/errors';
import type { Queryable } from '../audit/audit';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The raw immutable charge row. Callers select roots by their own authorized
 * tenant/window/scope, then pass every selected root here before aggregating. */
export interface EffectiveChargeRootRow {
  event_id: string;
  tenant_id: string;
  payload: unknown;
}

/** Database representation of one append-only financial adjustment. */
export interface EffectiveChargeAdjustmentRow extends QueryResultRow {
  adjustment_event_id: string;
  root_event_id: string;
  tenant_id: string;
  adjustment_revision: string | number;
  previous_adjustment_event_id: string | null;
  kind: 'correction' | 'refund';
  target_charge_microusd: string | number | null;
  refund_microusd: string | number | null;
  initial_charge_microusd: string | number;
  gross_charge_microusd: string | number;
  refunded_microusd: string | number;
  net_charge_microusd: string | number;
  effective_at: Date | string;
  quota_window_pins: unknown;
  recorded_at: Date | string;
  /** Added after legacy rows already existed; absent proof is explicitly null. */
  evidence_object_size_bytes?: string | number | null;
  evidence_object_sha256?: string | null;
}

export interface EffectiveChargeProjection {
  rootEventId: string;
  tenantId: string;
  /** Null is explicit unavailable/BASIC cost data, not a measured zero. */
  initialChargeMicrousd: number | null;
  grossChargeMicrousd: number | null;
  refundedMicrousd: number | null;
  netChargeMicrousd: number | null;
  adjustmentRevision: number;
  headAdjustmentEventId: string | null;
  /** Adjustment effective time always remains the original root time. */
  effectiveAt: string | null;
  recordedAt: string | null;
  quotaWindowPins: unknown[];
  costStatus: 'measured' | 'estimated' | 'pending' | 'unpriced' | null;
  event: UsageEvent | null;
}

export interface EffectiveChargeOptions {
  /** Historical as-of reads include only adjustments committed by this time. */
  recordedAsOf?: Date;
}

function unavailable(message: string): never {
  throw new HttpError(503, 'FINANCIAL_ACCOUNTING_UNAVAILABLE', message);
}

function safeDbInteger(value: string | number | null, field: string): bigint | null {
  if (value === null) return null;
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { return unavailable(`financial adjustment ${field} is invalid`); }
  if (parsed < 0n || parsed > MAX_SAFE) return unavailable(`financial adjustment ${field} is outside the supported range`);
  return parsed;
}

function iso(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return unavailable(`financial adjustment ${field} timestamp is invalid`);
  return parsed.toISOString();
}

function checkedNumber(value: bigint | null, field: string): number | null {
  if (value === null) return null;
  if (value < 0n || value > MAX_SAFE) return unavailable(`financial adjustment ${field} exceeds the supported range`);
  return Number(value);
}

function parseRoot(row: EffectiveChargeRootRow): {
  event: UsageEvent | null;
  initial: bigint | null;
  costStatus: EffectiveChargeProjection['costStatus'];
} {
  const parsed = UsageEventSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.eventId !== row.event_id
      || (parsed.data.costProvenance !== undefined && parsed.data.costProvenance.tenantId !== row.tenant_id)) {
    // Legacy/basic rows remain visible to the callers, but a linked financial
    // adjustment can never be applied to one whose immutable identity is not
    // trustworthy.
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : null;
    if (payload && payload['eventId'] === row.event_id && payload['costMicrousd'] === undefined) {
      return { event: null, initial: null, costStatus: 'pending' };
    }
    return { event: null, initial: null, costStatus: null };
  }
  const raw = row.payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(raw, 'costMicrousd')) {
    return { event: parsed.data, initial: null, costStatus: parsed.data.costStatus ?? 'pending' };
  }
  if (parsed.data.costStatus === 'pending' || parsed.data.costStatus === 'unpriced') {
    return { event: parsed.data, initial: null, costStatus: parsed.data.costStatus };
  }
  const initial = safeDbInteger(parsed.data.costMicrousd, 'initial charge');
  return {
    event: parsed.data,
    initial,
    costStatus: parsed.data.costStatus ?? (parsed.data.measurement === 'estimated' ? 'estimated' : 'measured'),
  };
}

/**
 * Project one initial UsageEvent plus its direct-root adjustment chain. The
 * chain is validated before applying an as-of cutoff so a broken later row
 * cannot silently make an older accounting view look complete.
 */
export function projectEffectiveCharge(
  root: EffectiveChargeRootRow,
  adjustments: readonly EffectiveChargeAdjustmentRow[],
  options: EffectiveChargeOptions = {},
): EffectiveChargeProjection {
  const parsedRoot = parseRoot(root);
  const rows = [...adjustments].sort((left, right) => Number(left.adjustment_revision) - Number(right.adjustment_revision));
  let revision = 0;
  let head: string | null = null;
  let gross = parsedRoot.initial;
  let refunded = 0n;
  let effectiveAt: string | null = parsedRoot.event?.occurredAt ?? null;
  let recordedAt: string | null = null;
  let pins: unknown[] = [];
  let lastRecordedMillis = -1;
  let asOfState: { revision: number; head: string | null; gross: bigint | null; refunded: bigint; effectiveAt: string | null; recordedAt: string | null; pins: unknown[] } = {
    revision: 0, head: null, gross, refunded, effectiveAt, recordedAt: null, pins: [],
  };
  const asOf = options.recordedAsOf?.getTime() ?? Number.POSITIVE_INFINITY;
  if (options.recordedAsOf && !Number.isFinite(asOf)) unavailable('financial accounting as-of time is invalid');

  for (const row of rows) {
    if (row.root_event_id !== root.event_id || row.tenant_id !== root.tenant_id) {
      unavailable('financial adjustment is linked to a different root or tenant');
    }
    const currentRevision = Number(row.adjustment_revision);
    if (!Number.isSafeInteger(currentRevision) || currentRevision !== revision + 1) {
      unavailable('financial adjustment revision chain is incomplete');
    }
    if (row.previous_adjustment_event_id !== head) {
      unavailable('financial adjustment previous-head chain is inconsistent');
    }
    if (gross === null || parsedRoot.event?.costProvenance?.priceSnapshot === null
        || parsedRoot.event?.costProvenance?.priceSnapshot === undefined
        || parsedRoot.event.costProvenance.priceRevision === null
        || parsedRoot.event.costStatus === 'pending' || parsedRoot.event.costStatus === 'unpriced') {
      unavailable('financial adjustment exists for a root without trusted priced cost provenance');
    }

    const target = safeDbInteger(row.target_charge_microusd, 'target charge');
    const refund = safeDbInteger(row.refund_microusd, 'refund amount');
    if ((row.kind !== 'correction' && row.kind !== 'refund')
        || (row.kind === 'correction' && (target === null || refund !== null))
        || (row.kind === 'refund' && (target !== null || refund === null || refund === 0n))) {
      unavailable('financial adjustment kind and amount do not match');
    }
    const nextGross = row.kind === 'correction' ? target! : gross;
    const nextRefunded = row.kind === 'refund' ? refunded + refund! : refunded;
    if (nextRefunded > MAX_SAFE || nextGross < nextRefunded) unavailable('financial adjustment would produce an invalid net charge');
    const initialColumn = safeDbInteger(row.initial_charge_microusd, 'initial charge');
    const grossColumn = safeDbInteger(row.gross_charge_microusd, 'gross charge');
    const refundedColumn = safeDbInteger(row.refunded_microusd, 'refunded amount');
    const netColumn = safeDbInteger(row.net_charge_microusd, 'net charge');
    if (initialColumn !== parsedRoot.initial || grossColumn !== nextGross || refundedColumn !== nextRefunded
        || netColumn !== nextGross - nextRefunded) {
      unavailable('financial adjustment stored totals do not reconcile to the original charge');
    }
    const nextEffectiveAt = iso(row.effective_at, 'effective');
    if (!parsedRoot.event || Date.parse(nextEffectiveAt) !== Date.parse(parsedRoot.event.occurredAt)) {
      unavailable('financial adjustment effective time does not match the original usage event');
    }
    const nextRecordedAt = iso(row.recorded_at, 'recorded');
    const recordedMillis = Date.parse(nextRecordedAt);
    if (recordedMillis < lastRecordedMillis) unavailable('financial adjustment recording time moved backwards');
    lastRecordedMillis = recordedMillis;
    const nextPins = Array.isArray(row.quota_window_pins) ? row.quota_window_pins : null;
    if (!nextPins) unavailable('financial adjustment quota window pins are malformed');
    if (revision > 0 && canonicalize(nextPins) !== canonicalize(pins)) {
      unavailable('financial adjustment changed the original quota window pins');
    }

    revision = currentRevision;
    head = row.adjustment_event_id;
    gross = nextGross;
    refunded = nextRefunded;
    effectiveAt = nextEffectiveAt;
    recordedAt = nextRecordedAt;
    pins = nextPins;
    if (recordedMillis <= asOf) {
      asOfState = { revision, head, gross, refunded, effectiveAt, recordedAt, pins };
    }
  }

  return {
    rootEventId: root.event_id,
    tenantId: root.tenant_id,
    initialChargeMicrousd: checkedNumber(parsedRoot.initial, 'initial charge'),
    grossChargeMicrousd: checkedNumber(asOfState.gross, 'gross charge'),
    refundedMicrousd: checkedNumber(asOfState.gross === null ? null : asOfState.refunded, 'refund total'),
    netChargeMicrousd: checkedNumber(asOfState.gross === null ? null : asOfState.gross - asOfState.refunded, 'net charge'),
    adjustmentRevision: asOfState.revision,
    headAdjustmentEventId: asOfState.head,
    effectiveAt: asOfState.effectiveAt,
    recordedAt: asOfState.recordedAt,
    quotaWindowPins: asOfState.pins,
    costStatus: parsedRoot.costStatus,
    event: parsedRoot.event,
  };
}

/**
 * Shared database reader for all monetary projections. It deliberately takes
 * root rows first, then loads every linked adjustment row without a time
 * predicate; an as-of cutoff is applied by the projector only after each
 * complete append-only chain has been checked.
 */
export async function loadEffectiveCharges(
  client: Queryable,
  roots: readonly EffectiveChargeRootRow[],
  options: EffectiveChargeOptions = {},
): Promise<Map<string, EffectiveChargeProjection>> {
  if (roots.length === 0) return new Map();
  const rootIds = roots.map((root) => root.event_id);
  if (new Set(rootIds).size !== rootIds.length) unavailable('effective charge root set contains duplicate event IDs');
  const result = await client.query<EffectiveChargeAdjustmentRow>(
    `SELECT adjustment_event_id::text AS adjustment_event_id,root_event_id,tenant_id::text AS tenant_id,
            adjustment_revision::text AS adjustment_revision,previous_adjustment_event_id::text AS previous_adjustment_event_id,
            kind,target_charge_microusd::text AS target_charge_microusd,refund_microusd::text AS refund_microusd,
            initial_charge_microusd::text AS initial_charge_microusd,gross_charge_microusd::text AS gross_charge_microusd,
            refunded_microusd::text AS refunded_microusd,net_charge_microusd::text AS net_charge_microusd,
            effective_at,quota_window_pins,recorded_at
       FROM usage_financial_adjustments
      WHERE root_event_id=ANY($1::text[])
      ORDER BY root_event_id,adjustment_revision`,
    [rootIds],
  );
  const grouped = new Map<string, EffectiveChargeAdjustmentRow[]>();
  for (const row of result.rows) {
    const bucket = grouped.get(row.root_event_id) ?? [];
    bucket.push(row);
    grouped.set(row.root_event_id, bucket);
  }
  const projection = new Map<string, EffectiveChargeProjection>();
  for (const root of roots) {
    projection.set(root.event_id, projectEffectiveCharge(root, grouped.get(root.event_id) ?? [], options));
  }
  return projection;
}


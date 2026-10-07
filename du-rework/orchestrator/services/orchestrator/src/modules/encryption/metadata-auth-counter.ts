import type { Db } from '../../db/db';
import { readStoredText, type MetadataCrypto, type MetadataSlot } from '../runtime/metadata-crypto';

/**
 * GATE-AUTHENTICATE-808 (A11) — count unsealed rows, AUTHENTICATING each one.
 *
 * The shape-only counter (coordination/backfill-leftover-counter-803.sql) has a
 * false-pass: a broken envelope still satisfies the shape predicate, so a
 * database holding one valid envelope and three broken ones reported
 * GATE PASSES while the real reader failed on all three.
 *
 * This helper closes that. For every non-null value it:
 *   1. applies the shape predicate (cheap, no key material), then
 *   2. for every shape-passing row, calls the REAL `readStored` under the
 *      row's own (tenantId, slot, refId) binding and classifies the outcome.
 *
 * Three groups, and the gate treats the middle one exactly like plaintext:
 *
 *   sealed_valid        — opens. Safe.
 *   sealed_broken_*     — shape-passes but the reader refuses it. NOT safe.
 *                        An attacker who can plant a broken envelope has
 *                        found a row the flip will fail-closed on, and a row
 *                        the shape counter called done.
 *   plaintext           — never sealed. NOT safe.
 *
 * The gate is: plaintext + sealed_broken_* == 0 AND every slot was scanned
 * AND the observed tenant set exactly matches an independently sourced,
 * full-visibility expected tenant census. Without that census an empty RLS-
 * filtered result is indistinguishable from an empty database, so it FAILS.
 *
 * READ-ONLY: this only ever SELECTs. It reads column VALUES because
 * authentication is impossible without them, but it never logs, returns, or
 * persists a value — only counts and error codes. Each slot query includes
 * NULL rows as tenant-presence evidence, and authenticates only non-null
 * values.
 */

export type MetadataAuthSlot = MetadataSlot;

export interface MetadataAuthSlotSpec {
  readonly slot: MetadataAuthSlot;
  readonly table: 'operations' | 'tasks' | 'human_waits' | 'step_checkpoints';
  readonly column: string;
  readonly kind: 'jsonb' | 'text';
  /** SQL expression yielding the row's tenant id. */
  readonly tenantExpr: string;
  /** SQL expression yielding the AAD refId the writer binds on. */
  readonly refIdExpr: string;
}

/**
 * BA-05: the gate must always cover exactly the eight METADATA_SLOTS.
 *
 * `specs` used to be optional and unvalidated, so a caller that passed a
 * trimmed list got a PASS that never counted the slots it omitted. Coverage is
 * now an exact set match — no missing, no extra, no duplicates.
 */
function assertFullCoverage(specs: readonly MetadataAuthSlotSpec[]): void {
  const expected = METADATA_AUTH_SLOT_SPECS.map((s) => s.slot);
  const expectedSet = new Set<string>(expected);
  const seen = specs.map((s) => s.slot);
  const seenSet = new Set<string>(seen);
  const missing = expected.filter((s) => !seenSet.has(s));
  const extra = seen.filter((s) => !expectedSet.has(s));
  const duplicates = seen.filter((s, i) => seen.indexOf(s) !== i);
  if (missing.length > 0 || extra.length > 0 || duplicates.length > 0 || specs.length !== expected.length) {
    throw new Error(
      'gate coverage must be exactly the 8 METADATA_SLOTS: '
        + 'missing=[' + missing.join(', ') + '] '
        + 'extra=[' + extra.join(', ') + '] '
        + 'duplicates=[' + duplicates.join(', ') + '] '
        + 'count=' + specs.length + '/' + expected.length
    );
  }
}
/**
 * The eight METADATA_SLOTS, with the exact refId each writer binds on. These
 * were read out of runtime.ts; a wrong refId produces CONTEXT_MISMATCH and
 * would misclassify a valid envelope as broken.
 */
export const METADATA_AUTH_SLOT_SPECS: readonly MetadataAuthSlotSpec[] = [
  { slot: 'operations.input_ref', table: 'operations', column: 'input_ref', kind: 'jsonb', tenantExpr: 'tenant_id', refIdExpr: 'id' },
  { slot: 'tasks.payload_ref', table: 'tasks', column: 'payload_ref', kind: 'jsonb', tenantExpr: 'o.tenant_id', refIdExpr: 't.id' },
  { slot: 'human_waits.response_ref', table: 'human_waits', column: 'response_ref', kind: 'jsonb', tenantExpr: 'o.tenant_id', refIdExpr: 'w.wait_id' },
  { slot: 'step_checkpoints.output_ref', table: 'step_checkpoints', column: 'output_ref', kind: 'text', tenantExpr: 'o.tenant_id', refIdExpr: "sc.task_id || ':' || sc.step_key" },
  { slot: 'step_checkpoints.session_ref', table: 'step_checkpoints', column: 'session_ref', kind: 'jsonb', tenantExpr: 'o.tenant_id', refIdExpr: "sc.task_id || ':' || sc.step_key || ':' || sc.generation" },
  { slot: 'operations.prompt_overrides_ref', table: 'operations', column: 'prompt_overrides_ref', kind: 'jsonb', tenantExpr: 'tenant_id', refIdExpr: 'id' },
  { slot: 'tasks.result_ref', table: 'tasks', column: 'result_ref', kind: 'text', tenantExpr: 'o.tenant_id', refIdExpr: 't.id' },
  { slot: 'operations.result_ref', table: 'operations', column: 'result_ref', kind: 'text', tenantExpr: 'tenant_id', refIdExpr: 'id' },
] as const;

export interface MetadataAuthCounts {
  /** Rows returned by the slot query, including rows whose value is NULL. */
  rowsVisible: number;
  /** Non-null values considered by the metadata gate. */
  total: number;
  nonNull: number;
  plaintext: number;
  sealedValid: number;
  sealedBrokenAuth: number;
  sealedBrokenContext: number;
  sealedBrokenOther: number;
  shapePass: number;
  shapePassAuthFail: number;
  shapeFailAuthPass: number;
  /** Calls made to the real crypto reader with this row's tenant/slot/refId. */
  valuesAuthenticated: number;
  /** Rows that could not be assigned to a tenant from the returned row. */
  unattributedRows: number;
}

export interface MetadataAuthSlotResult extends MetadataAuthCounts {
  readonly slot: MetadataAuthSlot;
  readonly table: string;
  readonly column: string;
  readonly tenantIds: readonly string[];
}

export interface MetadataAuthCoverage {
  /** Supplied from an independent, full-visibility tenant census; null means absent. */
  readonly expectedTenantIds: readonly string[] | null;
  readonly observedTenantIds: readonly string[];
  readonly missingTenantIds: readonly string[];
  readonly unexpectedTenantIds: readonly string[];
  readonly tenantsSeen: number;
  readonly slotsExpected: number;
  readonly slotQueriesAttempted: number;
  readonly slotQueriesSucceeded: number;
  readonly slotsRead: number;
  readonly slotsScanned: number;
  readonly valuesAuthenticated: number;
  readonly emptySlots: readonly {
    readonly slot: MetadataAuthSlot;
    readonly rowsVisible: number;
    readonly nonNullValues: number;
    readonly reason: string;
  }[];
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export interface MetadataAuthCounterResult {
  readonly slots: readonly MetadataAuthSlotResult[];
  readonly totals: MetadataAuthCounts;
  /** plaintext + every sealed_broken_* — the rows the flip must not leave behind. */
  readonly blockers: number;
  readonly coverage: MetadataAuthCoverage;
  readonly gate: 'PASS' | 'FAIL';
}

function isShapeSealedJsonb(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1
    && v.algorithm === 'aes-256-gcm'
    && typeof v.ciphertext === 'string'
    && typeof v.dek === 'object' && v.dek !== null
    && typeof v.nonce === 'string'
    && typeof v.tag === 'string';
}

function isShapeSealedText(value: string): boolean {
  return value.includes('"version":1')
    && value.includes('"algorithm":"aes-256-gcm"')
    && value.includes('"ciphertext"');
}

function emptyCounts(): MetadataAuthCounts {
  return {
    rowsVisible: 0, total: 0, nonNull: 0, plaintext: 0, sealedValid: 0,
    sealedBrokenAuth: 0, sealedBrokenContext: 0, sealedBrokenOther: 0,
    shapePass: 0, shapePassAuthFail: 0, shapeFailAuthPass: 0,
    valuesAuthenticated: 0, unattributedRows: 0,
  };
}

function addInto(target: MetadataAuthCounts, delta: MetadataAuthCounts): MetadataAuthCounts {
  return {
    rowsVisible: target.rowsVisible + delta.rowsVisible,
    total: target.total + delta.total,
    nonNull: target.nonNull + delta.nonNull,
    plaintext: target.plaintext + delta.plaintext,
    sealedValid: target.sealedValid + delta.sealedValid,
    sealedBrokenAuth: target.sealedBrokenAuth + delta.sealedBrokenAuth,
    sealedBrokenContext: target.sealedBrokenContext + delta.sealedBrokenContext,
    sealedBrokenOther: target.sealedBrokenOther + delta.sealedBrokenOther,
    shapePass: target.shapePass + delta.shapePass,
    shapePassAuthFail: target.shapePassAuthFail + delta.shapePassAuthFail,
    shapeFailAuthPass: target.shapeFailAuthPass + delta.shapeFailAuthPass,
    valuesAuthenticated: target.valuesAuthenticated + delta.valuesAuthenticated,
    unattributedRows: target.unattributedRows + delta.unattributedRows,
  };
}

function slotSql(spec: MetadataAuthSlotSpec): string {
  const join =
    spec.table === 'tasks'
      ? ' JOIN operations o ON o.id = t.operation_id'
      : spec.table === 'human_waits'
        ? ' JOIN operations o ON o.id = w.operation_id'
        : spec.table === 'step_checkpoints'
          ? ' JOIN tasks t ON t.id = sc.task_id JOIN operations o ON o.id = t.operation_id'
          : '';
  const alias = spec.table === 'tasks' ? 't' : spec.table === 'human_waits' ? 'w' : spec.table === 'step_checkpoints' ? 'sc' : 'operations';
  // Qualify the column with the alias: tasks and operations BOTH have a
  // `result_ref`, so an unqualified reference is ambiguous the moment they are
  // joined (measured on PG16).
  const column = alias + '.' + spec.column;
  return 'SELECT ' + spec.tenantExpr + ' AS tenant_id, '
    + spec.refIdExpr + ' AS ref_id, '
    + column + ' AS value'
    + ' FROM ' + spec.table + ' ' + alias + join;
}

export async function countUnsealedWithAuth(options: {
  readonly db: Db;
  readonly crypto: MetadataCrypto | undefined;
  readonly specs?: readonly MetadataAuthSlotSpec[];
  /**
   * Must come from an independent full-visibility tenant census (for example,
   * a platform connection that is not subject to the row security being
   * tested). Without it, an RLS-filtered empty result cannot prove coverage.
   */
  readonly expectedTenantIds?: readonly string[];
}): Promise<MetadataAuthCounterResult> {
  const specs = options.specs ?? METADATA_AUTH_SLOT_SPECS;
  assertFullCoverage(specs);
  const slots: MetadataAuthSlotResult[] = [];
  let totals = emptyCounts();
  let slotQueriesAttempted = 0;
  let slotQueriesSucceeded = 0;
  let slotsScanned = 0;

  for (const spec of specs) {
    slotQueriesAttempted += 1;
    const res = await options.db.query(slotSql(spec));
    slotQueriesSucceeded += 1;
    const counts = emptyCounts();
    counts.rowsVisible = res.rows.length;
    const tenantIds = new Set<string>();

    for (const row of res.rows as unknown as {
      tenant_id: unknown; ref_id: unknown; value: unknown;
    }[]) {
      const rowTenantId = typeof row.tenant_id === 'string' && row.tenant_id.length > 0
        ? row.tenant_id
        : undefined;
      if (rowTenantId !== undefined) {
        tenantIds.add(rowTenantId);
      } else {
        counts.unattributedRows += 1;
      }
      if (row.value === null || row.value === undefined) continue;
      counts.total += 1;
      counts.nonNull += 1;
      const shapePass = spec.kind === 'jsonb'
        ? isShapeSealedJsonb(row.value)
        : isShapeSealedText(String(row.value));
      if (shapePass) counts.shapePass += 1;

      if (!options.crypto) {
        // No seam configured: nothing can be sealed, so every non-null value is
        // plaintext by definition. This is the honest answer, not a pass.
        counts.plaintext += 1;
        continue;
      }

      if (!shapePass) {
        counts.plaintext += 1;
        continue;
      }

      if (rowTenantId === undefined) {
        counts.shapePassAuthFail += 1;
        counts.sealedBrokenOther += 1;
        continue;
      }

      counts.valuesAuthenticated += 1;

      // Shape passes: prove it opens under THIS row's binding. TEXT columns
      // go through readStoredText, which parses the JSON text before opening;
      // readStored expects an already-parsed value and answers NOT_SEALED for a
      // string, so using it here would mark every text envelope broken.
      try {
        if (spec.kind === 'text') {
          await readStoredText(options.crypto, row.value, {
            tenantId: rowTenantId,
            slot: spec.slot,
            refId: String(row.ref_id),
          }, false);
        } else {
          await options.crypto.readStored(row.value, {
            tenantId: rowTenantId,
            slot: spec.slot,
            refId: String(row.ref_id),
          }, false);
        }
        counts.sealedValid += 1;
      } catch (err) {
        counts.shapePassAuthFail += 1;
        const code = (err as { code?: string }).code ?? '';
        if (code === 'AUTHENTICATION_FAILED') counts.sealedBrokenAuth += 1;
        else if (code === 'CONTEXT_MISMATCH') counts.sealedBrokenContext += 1;
        else counts.sealedBrokenOther += 1;
      }
    }

    slotsScanned += 1;
    slots.push({
      ...counts,
      slot: spec.slot,
      table: spec.table,
      column: spec.column,
      tenantIds: [...tenantIds].sort(),
    });
    totals = addInto(totals, counts);
  }

  const blockers = totals.plaintext
    + totals.sealedBrokenAuth + totals.sealedBrokenContext + totals.sealedBrokenOther;
  const expectedTenantIds = options.expectedTenantIds === undefined
    ? null
    : [...new Set(options.expectedTenantIds)].sort();
  const expectedInput = options.expectedTenantIds ?? [];
  const expectedSet = new Set(expectedTenantIds ?? []);
  const observedTenantIds = [...new Set(slots.flatMap((slot) => slot.tenantIds))].sort();
  const observedSet = new Set(observedTenantIds);
  const missingTenantIds = (expectedTenantIds ?? []).filter((tenantId) => !observedSet.has(tenantId));
  const unexpectedTenantIds = observedTenantIds.filter((tenantId) => !expectedSet.has(tenantId));
  const emptySlots = slots
    .filter((slot) => slot.nonNull === 0)
    .map((slot) => ({
      slot: slot.slot,
      rowsVisible: slot.rowsVisible,
      nonNullValues: slot.nonNull,
      reason: slot.rowsVisible === 0
        ? 'No rows were visible to this connection; the table may be empty or RLS/policy may have filtered rows.'
        : 'Rows were visible, but every value in this slot was NULL.',
    }));
  const coverageReasons: string[] = [];
  if (options.expectedTenantIds === undefined) {
    coverageReasons.push('Expected tenant IDs were not supplied from an independent full-visibility census.');
  }
  if (options.expectedTenantIds !== undefined && expectedInput.length === 0) {
    coverageReasons.push('The expected tenant census is empty; vacuous coverage cannot pass.');
  }
  if (options.expectedTenantIds !== undefined && expectedInput.length !== expectedSet.size) {
    coverageReasons.push('The expected tenant census contains duplicate IDs.');
  }
  if (expectedInput.some((tenantId) => typeof tenantId !== 'string' || tenantId.length === 0)) {
    coverageReasons.push('The expected tenant census contains an empty or invalid ID.');
  }
  if (slotQueriesSucceeded !== specs.length || slotsScanned !== specs.length) {
    coverageReasons.push(`Only ${slotsScanned}/${specs.length} slots were fully scanned (${slotQueriesSucceeded} queries succeeded).`);
  }
  if (missingTenantIds.length > 0) {
    coverageReasons.push(`Expected tenants were not visible in any slot: ${missingTenantIds.join(', ')}. Possible causes include RLS/policy filtering, missing joined rows, or a tenant with no rows in the scanned tables.`);
  }
  if (unexpectedTenantIds.length > 0) {
    coverageReasons.push(`Unexpected tenant IDs were observed outside the expected census: ${unexpectedTenantIds.join(', ')}.`);
  }
  if (totals.unattributedRows > 0) {
    coverageReasons.push(`${totals.unattributedRows} visible rows had no usable tenant ID.`);
  }
  const coverageComplete = coverageReasons.length === 0;
  const coverage: MetadataAuthCoverage = {
    expectedTenantIds,
    observedTenantIds,
    missingTenantIds,
    unexpectedTenantIds,
    tenantsSeen: observedTenantIds.length,
    slotsExpected: specs.length,
    slotQueriesAttempted,
    slotQueriesSucceeded,
    slotsRead: slotQueriesSucceeded,
    slotsScanned,
    valuesAuthenticated: totals.valuesAuthenticated,
    emptySlots,
    complete: coverageComplete,
    reasons: coverageReasons,
  };
  return {
    slots,
    totals,
    blockers,
    coverage,
    gate: blockers === 0 && coverageComplete ? 'PASS' : 'FAIL',
  };
}

/**
 * The shape-only counter, kept for comparison. It is the one that false-passes;
 * it exists so a run can show both numbers side by side and the gap between
 * them is visible rather than asserted.
 */
export function shapeOnlyCounts(result: MetadataAuthCounterResult): {
  readonly shapeSealed: number;
  readonly shapeLeftover: number;
  readonly authSealed: number;
  readonly authBlockers: number;
} {
  let shapeSealed = 0;
  let shapeLeftover = 0;
  for (const s of result.slots) {
    shapeSealed += s.shapePass;
    shapeLeftover += s.plaintext;
  }
  return {
    shapeSealed,
    shapeLeftover,
    authSealed: result.totals.sealedValid,
    authBlockers: result.blockers,
  };
}

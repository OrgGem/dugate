#!/usr/bin/env node
/**
 * BACKFILL-CLI-825: the production caller for the ENC-09 control-plane
 * backfill. Before this file backfillLegacyPayloads had a framework and a
 * store but NO caller, so the six non-result_ref slots could never be sealed
 * by anything.
 *
 * It drives ALL EIGHT METADATA_SLOTS through ControlPlanePgMigrationStore
 * (the store module generalized sibling of ResultRefPgMigrationStore).
 *
 * Fail-closed by construction:
 *   - refuses to run at all without DU_ENCRYPTION_METADATA_ENABLED=true;
 *   - refuses to run against a production database without --allow-production;
 *   - refuses to report success while any slot is unresolved: the run exits
 *     non-zero and reports how many values are still unmigrated.
 */
import { createDb } from '../../db/db';
import { buildEncryptionBootOptions } from '../encryption/boot-options';
import { adaptKeyProviderForMetadata } from '../encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../runtime/metadata-crypto';
import { countUnsealedWithAuth } from '../encryption/metadata-auth-counter';
import {
  backfillLegacyPayloads,
  ControlPlanePayloadCodec,
  ControlPlanePgMigrationStore,
  CONTROL_PLANE_SLOT_SPECS,
  type BoundedDualReadWindow,
  type ControlPlaneSealer,
} from '../encryption/legacy-payload-migration';

export const BACKFILL_METADATA_EXIT_OK = 0;
export const BACKFILL_METADATA_EXIT_REFUSED = 2;
export const CONTROL_PLANE_SLOT_COUNT = CONTROL_PLANE_SLOT_SPECS.length;

export interface BackfillGateInput {
  readonly gate: 'PASS' | 'FAIL';
  readonly blockers: number;
  readonly slotsScanned: number;
  readonly slotsExpected: number;
  readonly rowsVisible: number;
}

/**
 * The single decision the CLI makes about a gate result. Exported so the
 * refusal rule is testable without a database: unresolved data never yields
 * proceed=true, whatever the caller asked for.
 */
export function evaluateBackfillGate(result: BackfillGateInput): {
  readonly proceed: boolean;
  readonly reason: string;
} {
  if (result.gate !== 'PASS') {
    return {
      proceed: false,
      reason: 'gate is ' + result.gate + ' with ' + result.blockers + ' unresolved value(s) across '
        + result.slotsScanned + '/' + result.slotsExpected + ' slots; refusing to treat the data as migrated',
    };
  }
  if (result.slotsScanned !== result.slotsExpected) {
    return {
      proceed: false,
      reason: 'only ' + result.slotsScanned + '/' + result.slotsExpected + ' slots were scanned',
    };
  }
  return { proceed: true, reason: 'gate PASS with zero unresolved values' };
}

/** Production guard: an explicit flag is the only way past it. */
export function databaseApproval(
  env: Readonly<Record<string, string | undefined>>,
  allowProductionFlag: boolean,
): { readonly approved: boolean; readonly reason: string } {
  const nodeEnv = env['NODE_ENV'];
  const url = env['DATABASE_URL'] ?? '';
  const looksProduction = nodeEnv === 'production'
    || /(^|[/.])prod(uction)?([/.]|$)/i.test(url);
  if (!looksProduction) return { approved: true, reason: 'not a production database' };
  if (allowProductionFlag) return { approved: true, reason: 'explicit --allow-production flag supplied' };
  return {
    approved: false,
    reason: 'refusing to run against a production database without --allow-production',
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write('refusing to run: ' + name + ' is required\n');
    process.exit(BACKFILL_METADATA_EXIT_REFUSED);
  }
  return value;
}

function refuse(message: string): never {
  process.stderr.write('refusing to run: ' + message + '\n');
  process.exit(BACKFILL_METADATA_EXIT_REFUSED);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  /** Optional window override for an offline/in-process caller. */
  window?: BoundedDualReadWindow,
): Promise<number> {
  const backfill = argv.includes('--backfill');
  const allowProduction = argv.includes('--allow-production');

  // Fail-closed #1: no seam, no run. Without the flag there is no key to seal
  // with, so any success would be a lie about plaintext data.
  if (process.env.DU_ENCRYPTION_METADATA_ENABLED !== 'true') {
    refuse('DU_ENCRYPTION_METADATA_ENABLED is not true; nothing can be sealed without the metadata seam');
  }
  const databaseUrl = required('DATABASE_URL');

  const approval = databaseApproval(process.env, allowProduction);
  if (!approval.approved) refuse(approval.reason);

  const boot = buildEncryptionBootOptions(process.env);
  if (!boot?.metadataEncryption) {
    refuse('no metadataEncryption block was built from the environment');
  }
  const crypto = createMetadataCrypto(
    adaptKeyProviderForMetadata(boot.metadataEncryption.keyProvider),
    boot.metadataEncryption.keyRef,
  );

  // MetadataCrypto is the same seam structurally; its open() is declared over
  // the narrower SealedMetadata, so the structural interface needs one cast.
  const sealer = crypto as unknown as ControlPlaneSealer;

  const db = createDb(databaseUrl);
  try {
    const tenantRows = await db.query('SELECT id FROM tenants ORDER BY id');
    const expectedTenantIds = (tenantRows.rows as { id: string }[]).map((row) => row.id);

    const counter = await countUnsealedWithAuth({ db, crypto, expectedTenantIds });
    const gate = evaluateBackfillGate({
      gate: counter.gate,
      blockers: counter.blockers,
      slotsScanned: counter.coverage.slotsScanned,
      slotsExpected: counter.coverage.slotsExpected,
      rowsVisible: counter.totals.rowsVisible,
    });

    const report = {
      mode: backfill ? 'backfill' : 'check',
      slots: counter.coverage.slotsExpected,
      slotsScanned: counter.coverage.slotsScanned,
      rowsProcessed: counter.totals.rowsVisible,
      plaintext: counter.totals.plaintext,
      sealedValid: counter.totals.sealedValid,
      unresolved: counter.blockers,
      gate: counter.gate,
      tenants: expectedTenantIds.length,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    if (!gate.proceed) {
      // Fail-closed #2: unresolved data is never reported as done.
      process.stderr.write(gate.reason + '\n');
      return BACKFILL_METADATA_EXIT_REFUSED;
    }
    if (!backfill) return BACKFILL_METADATA_EXIT_OK;

    const store = new ControlPlanePgMigrationStore({ db, sealer, ...(window ? { window } : {}) });
    const result = await backfillLegacyPayloads(store, new ControlPlanePayloadCodec(sealer));
    process.stdout.write(JSON.stringify({
      backfill: {
        scannedPayloads: result.scannedPayloads,
        migratedPayloads: result.migratedPayloads,
        verifiedPayloads: result.verifiedPayloads,
        failedPayloads: result.failedPayloads,
        unresolvedReferences: result.unresolvedReferences,
        state: result.state,
        issues: result.issues,
      },
    }, null, 2) + '\n');

    // Re-check after the run: the gate, not the run, decides the exit code.
    const after = await countUnsealedWithAuth({ db, crypto, expectedTenantIds });
    const afterGate = evaluateBackfillGate({
      gate: after.gate,
      blockers: after.blockers,
      slotsScanned: after.coverage.slotsScanned,
      slotsExpected: after.coverage.slotsExpected,
      rowsVisible: after.totals.rowsVisible,
    });
    process.stdout.write(JSON.stringify({
      afterBackfill: {
        slots: after.coverage.slotsExpected,
        rowsProcessed: after.totals.rowsVisible,
        unresolved: after.blockers,
        gate: after.gate,
      },
    }, null, 2) + '\n');
    if (!afterGate.proceed) {
      process.stderr.write(afterGate.reason + '\n');
      return BACKFILL_METADATA_EXIT_REFUSED;
    }
    return BACKFILL_METADATA_EXIT_OK;
  } finally {
    await db.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write('refusing to run: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(BACKFILL_METADATA_EXIT_REFUSED);
  });
}

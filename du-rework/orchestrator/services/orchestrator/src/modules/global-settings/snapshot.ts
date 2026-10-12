import { TenantDefaultsSnapshotSchema, type TenantDefaultsSnapshot } from '@du/contracts';
import { HttpError } from '../../http/errors';
import { metadataPlaintextHash, type MetadataCrypto } from '../runtime/metadata-crypto';

export interface TenantDefaultsBinding {
  tenantId: string;
  operationId: string;
}

export function tenantDefaultsSnapshotDigest(
  snapshot: Omit<TenantDefaultsSnapshot, 'settingsDigest'>,
): string {
  return `sha256:${metadataPlaintextHash(snapshot)}`;
}

export function createTenantDefaultsSnapshot(
  input: Omit<TenantDefaultsSnapshot, 'settingsDigest'>,
): TenantDefaultsSnapshot {
  return TenantDefaultsSnapshotSchema.parse({
    ...input,
    settingsDigest: tenantDefaultsSnapshotDigest(input),
  });
}

/** Seal the fully resolved admission snapshot under its own operation AAD. */
export async function sealTenantDefaultsSnapshot(
  crypto: MetadataCrypto | undefined,
  snapshot: TenantDefaultsSnapshot,
  binding: TenantDefaultsBinding,
): Promise<string> {
  if (!crypto) throw new HttpError(503, 'METADATA_ENCRYPTION_REQUIRED', 'tenant defaults cannot be pinned without metadata encryption');
  const parsed = TenantDefaultsSnapshotSchema.parse(snapshot);
  const { settingsDigest, ...content } = parsed;
  if (tenantDefaultsSnapshotDigest(content) !== settingsDigest) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenant defaults digest does not match the snapshot');
  }
  const envelope = await crypto.seal(parsed, {
    tenantId: binding.tenantId,
    slot: 'operations.tenant_defaults_ref',
    refId: binding.operationId,
  });
  return JSON.stringify(envelope);
}

/** Open and verify a tenant defaults carrier only at the trusted claim seam. */
export async function openTenantDefaultsSnapshot(
  crypto: MetadataCrypto | undefined,
  raw: unknown,
  binding: TenantDefaultsBinding,
): Promise<TenantDefaultsSnapshot | null> {
  if (raw === null || raw === undefined) return null;
  if (!crypto) throw new HttpError(503, 'METADATA_ENCRYPTION_REQUIRED', 'tenant defaults carrier cannot be opened without metadata encryption');
  let envelope: unknown = raw;
  if (typeof raw === 'string') {
    try { envelope = JSON.parse(raw) as unknown; }
    catch { throw new HttpError(422, 'INVALID_SCHEMA', 'tenant defaults carrier is not a sealed envelope'); }
  }
  if (!crypto.isSealed(envelope)) throw new HttpError(422, 'INVALID_SCHEMA', 'tenant defaults carrier is not sealed');
  const opened = await crypto.readStored(envelope, {
    tenantId: binding.tenantId,
    slot: 'operations.tenant_defaults_ref',
    refId: binding.operationId,
  }, false);
  const parsed = TenantDefaultsSnapshotSchema.safeParse(opened);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'tenant defaults carrier does not match its frozen schema');
  const { settingsDigest, ...content } = parsed.data;
  if (tenantDefaultsSnapshotDigest(content) !== settingsDigest) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenant defaults carrier digest does not match its content');
  }
  return parsed.data;
}

/**
 * SC-03 — runtime parsing for the Secret catalog read wire.
 *
 * The BFF proxies the frozen `@du/contracts` projection; this module is the
 * only validator the browser trusts. Rules:
 *  - a read with any `value` member is rejected whole (no plaintext readback),
 *  - provider-specific shape is validated (managed_value vs vault_reference),
 *  - unknown states/purposes are rejected rather than displayed as truth.
 */
import {
  SECRET_PURPOSES,
  SECRET_SERVICES,
  type SecretCatalogEntryRead,
  type SecretCatalogListPage,
  type SecretProvider,
  type SecretPurpose,
  type SecretRotationMetadata,
  type SecretService,
  type SecretState,
  type SecretUsageReference,
  type VaultVersionMode,
} from '@/lib/api';

const STATES: readonly SecretState[] = ['ACTIVE', 'DISABLED', 'REVOKED'];
const USAGE_KINDS = ['connector_credential', 'profile_callback', 'oidc_client', 'source_auth'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseVersion(value: unknown): VaultVersionMode | null {
  if (!isRecord(value)) return null;
  if (value['mode'] === 'latest') return { mode: 'latest' };
  if (value['mode'] === 'pinned' && typeof value['version'] === 'number' && Number.isInteger(value['version']) && value['version'] > 0) {
    return { mode: 'pinned', version: value['version'] };
  }
  return null;
}

function parseProvider(value: unknown): SecretProvider | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'managed_value') return { kind: 'managed_value' };
  if (value['kind'] !== 'vault_reference') return null;
  const connectionId = str(value['connectionId']);
  const mount = str(value['mount']);
  const path = str(value['path']);
  const field = str(value['field']);
  const version = parseVersion(value['version']);
  if (connectionId === null || mount === null || path === null || field === null || version === null) return null;
  const namespace = str(value['namespace']);
  return {
    kind: 'vault_reference',
    connectionId,
    mount,
    path,
    field,
    version,
    ...(namespace !== null ? { namespace } : {}),
  };
}

function parseRotation(value: unknown): SecretRotationMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const rotatedAt = typeof value['rotatedAt'] === 'string' ? value['rotatedAt'] : null;
  const intervalDays = typeof value['intervalDays'] === 'number' && Number.isInteger(value['intervalDays'])
    ? value['intervalDays']
    : null;
  return { rotatedAt, intervalDays };
}

function parseUsage(value: unknown): SecretUsageReference[] {
  if (!Array.isArray(value)) return [];
  const out: SecretUsageReference[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = item['kind'];
    const refId = str(item['refId']);
    if (typeof kind !== 'string' || !(USAGE_KINDS as readonly string[]).includes(kind) || refId === null) continue;
    out.push({
      kind: kind as SecretUsageReference['kind'],
      refId,
      ...(typeof item['revision'] === 'number' && Number.isInteger(item['revision'])
        ? { revision: item['revision'] as number }
        : {}),
    });
  }
  return out;
}

export function parseSecretEntry(value: unknown): SecretCatalogEntryRead | null {
  if (!isRecord(value)) return null;
  // No-plaintext readback fence: any value member rejects the whole row.
  if ('value' in value) return null;
  const secretId = str(value['secretId']);
  const tenantId = str(value['tenantId']);
  const name = str(value['name']);
  const purpose = value['purpose'];
  const state = value['state'];
  const revision = value['revision'];
  const provider = parseProvider(value['provider']);
  if (
    secretId === null
    || tenantId === null
    || name === null
    || provider === null
    || typeof purpose !== 'string'
    || !(SECRET_PURPOSES as readonly string[]).includes(purpose)
    || typeof state !== 'string'
    || !(STATES as readonly string[]).includes(state)
    || typeof revision !== 'number'
    || !Number.isInteger(revision)
    || revision < 1
  ) {
    return null;
  }
  const services = Array.isArray(value['services'])
    ? (value['services'] as unknown[]).filter(
        (service): service is SecretService => typeof service === 'string' && (SECRET_SERVICES as readonly string[]).includes(service),
      )
    : [];
  if (services.length === 0) return null;
  return {
    catalogVersion: 1,
    secretId,
    tenantId,
    name,
    purpose: purpose as SecretPurpose,
    services,
    provider,
    state: state as SecretState,
    revision,
    ...(parseRotation(value['rotation']) !== undefined ? { rotation: parseRotation(value['rotation']) as SecretRotationMetadata } : {}),
    valueConfigured: value['valueConfigured'] === true,
    usageReferences: parseUsage(value['usageReferences']),
  };
}

export function parseSecretListPage(value: unknown): SecretCatalogListPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: SecretCatalogEntryRead[] = [];
  for (const raw of value['items']) {
    const entry = parseSecretEntry(raw);
    if (entry === null) return null;
    items.push(entry);
  }
  const nextCursor = typeof value['nextCursor'] === 'string' && value['nextCursor'].length > 0 ? value['nextCursor'] : null;
  return { items, nextCursor };
}

export function providerLabel(provider: SecretProvider): string {
  return provider.kind === 'managed_value' ? 'Managed value' : 'Vault reference';
}

export function providerDetail(provider: SecretProvider): string {
  if (provider.kind === 'managed_value') return 'managed by the platform';
  const version = provider.version.mode === 'pinned' ? 'v' + provider.version.version : 'latest';
  return `${provider.connectionId}/${provider.mount}/${provider.path}#${provider.field}/${version}`;
}

export function secretStateVariant(state: SecretState): 'success' | 'warning' | 'danger' {
  if (state === 'ACTIVE') return 'success';
  if (state === 'DISABLED') return 'warning';
  return 'danger';
}

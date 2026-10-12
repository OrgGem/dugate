import type { SecretCatalogEntryRead, SecretCatalogListQuery } from '../../lib/api';

export function storageSecretCatalogQuery(tenantId: string, q: string, cursor: string | null): SecretCatalogListQuery {
  return {
    tenantId,
    purpose: 'storage.credential',
    service: 'orchestrator',
    state: 'ACTIVE',
    limit: '200',
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function exactStorageSecretReference(secret: SecretCatalogEntryRead): string {
  return `${secret.secretId}@${secret.revision}`;
}

export function isManagedStorageCredential(secret: SecretCatalogEntryRead, tenantId: string): boolean {
  return secret.tenantId === tenantId
    && secret.purpose === 'storage.credential'
    && secret.state === 'ACTIVE'
    && secret.provider.kind === 'managed_value'
    && secret.services.includes('orchestrator')
    && Number.isSafeInteger(secret.revision)
    && secret.revision > 0;
}

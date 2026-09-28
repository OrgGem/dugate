import type { AdapterConfig } from './types';
import type { CredentialSource } from './vault/resolver';
import type { ConnectorRevision } from './db/repository';

export interface RedactedConnectorRevision {
  connectorId: string;
  revision: number;
  adapter: string;
  config: AdapterConfig;
  credentialRef: string;
  state: 'PENDING' | 'ACTIVE' | 'RETIRED';
  /** VAULT-06: metadata (ref coordinates) — never a secret; passes through redact. */
  credentialSource: CredentialSource;
  /** W-VAULT01-BIND-1R: binding coordinates are metadata, not secrets. */
  tenantId: string;
  accountId?: string;
}

export function redactConnectorRevision(revision: ConnectorRevision): RedactedConnectorRevision {
  const headers = revision.config.headers
    ? Object.fromEntries(Object.keys(revision.config.headers).map((key) => [key, '[REDACTED]']))
    : undefined;
  return {
    ...revision,
    config: {
      ...revision.config,
      headers,
    },
  };
}

import type { AdapterConfig } from './types';
import type { ConnectorRevision } from './db/repository';

export interface RedactedConnectorRevision {
  connectorId: string;
  revision: number;
  adapter: string;
  config: AdapterConfig;
  credentialRef: string;
  state: 'ACTIVE' | 'DISABLED';
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

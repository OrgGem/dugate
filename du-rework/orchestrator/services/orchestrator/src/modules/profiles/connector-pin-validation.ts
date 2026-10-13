import type { ConnectorManagementStore } from '../connectors/connector-management-store';

export interface ConnectorPin {
  connectorId: string;
  revision: number;
}

/**
 * Validate a persisted Profile pin against both supported Connector ledgers.
 * The management store maps only typed-revision NOT_FOUND to `undefined`;
 * authorization, transport and response-validation errors propagate and must
 * not be hidden by a legacy row with the same ID and revision.
 */
export async function isActiveConnectorPin(
  connectors: Pick<ConnectorManagementStore, 'getRecipeRevision' | 'hasRecipeChain' | 'getRevision'>,
  tenantId: string,
  pin: ConnectorPin,
): Promise<boolean> {
  const typed = await connectors.getRecipeRevision({
    tenantId,
    connectorId: pin.connectorId,
    revision: pin.revision,
  });
  if (typed !== undefined) {
    return typed.tenantId === tenantId
      && typed.connectorId === pin.connectorId
      && typed.revision === pin.revision
      && typed.state === 'ACTIVE';
  }

  // Invocation routes every revision for a typed-chain connector through the
  // typed ledger. A missing exact typed revision therefore cannot safely fall
  // back to an otherwise-active legacy row with the same connector ID.
  if (await connectors.hasRecipeChain({ tenantId, connectorId: pin.connectorId })) return false;

  const legacy = await connectors.getRevision(pin.connectorId, pin.revision);
  return legacy !== undefined
    && legacy.connectorId === pin.connectorId
    && legacy.revision === pin.revision
    && legacy.state === 'ACTIVE'
    && (!legacy.tenantId || legacy.tenantId === tenantId);
}

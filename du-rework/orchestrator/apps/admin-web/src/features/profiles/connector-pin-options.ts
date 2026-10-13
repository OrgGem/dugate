import { TenantActiveConnectorCatalogPageSchema } from '@du/contracts';
import type { AdminApiClient } from '@/lib/api';
import { parseConnectorList } from '@/features/connectors/state';

export interface ConnectorPinOption {
  connectorId: string;
  revision: number;
  tenantId?: string;
  state: 'ACTIVE';
  provider?: string;
  model?: string | null;
}

/**
 * Profile bindings can still point at legacy connector_revisions, while new
 * recipes live in connector_parity_revisions. Load both supported catalogs;
 * typed rows take precedence when both ledgers contain the same exact pin.
 */
export async function loadConnectorPinOptions(
  client: Pick<AdminApiClient, 'listConnectors' | 'listTenantActiveConnectorRevisions' | 'hasTenantConnectorRecipeChain'>,
  tenantId: string,
): Promise<{ items: ConnectorPinOption[]; problem: string | null }> {
  const items = new Map<string, ConnectorPinOption>();
  const problems: string[] = [];
  const [legacyResult, firstTypedPage] = await Promise.all([
    client.listConnectors(),
    client.listTenantActiveConnectorRevisions({ tenantId, limit: 100 }),
  ]);

  if (legacyResult.ok) {
    const parsed = parseConnectorList(legacyResult.data);
    if (!parsed) {
      problems.push('Legacy Connector catalog response was unreadable.');
    } else {
      const eligible = parsed.items.filter((revision) =>
        revision.state === 'ACTIVE' && (!revision.tenantId || revision.tenantId === tenantId)
      );
      const legacyChainStates = new Map<string, boolean>();
      await Promise.all([...new Set(eligible.map((revision) => revision.connectorId))].map(async (connectorId) => {
        const chain = await client.hasTenantConnectorRecipeChain({ tenantId, connectorId });
        if (!chain.ok || typeof chain.data?.hasTypedChain !== 'boolean') {
          problems.push(`Legacy Connector ${connectorId} availability could not be verified.`);
          legacyChainStates.set(connectorId, true);
          return;
        }
        legacyChainStates.set(connectorId, chain.data.hasTypedChain);
      }));
      for (const revision of parsed.items) {
        if (revision.state !== 'ACTIVE' || (revision.tenantId && revision.tenantId !== tenantId)) continue;
        // The invocation bridge treats the connector ID as a typed chain once
        // one exists, even when an older legacy revision remains ACTIVE.
        if (legacyChainStates.get(revision.connectorId) !== false) continue;
        const key = `${revision.connectorId}@${revision.revision}`;
        items.set(key, {
          connectorId: revision.connectorId,
          revision: revision.revision,
          ...(revision.tenantId ? { tenantId: revision.tenantId } : {}),
          state: 'ACTIVE',
        });
      }
      if (parsed.skipped > 0) problems.push(`${parsed.skipped} legacy Connector revisions could not be read.`);
    }
  } else {
    problems.push(`Legacy Connector catalog unavailable (${legacyResult.status}).`);
  }

  if (!firstTypedPage.ok) {
    problems.push(`Typed tenant Connector catalog unavailable (${firstTypedPage.status}).`);
  } else {
    let pageValue: unknown = firstTypedPage.data;
    const visitedCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const parsed = TenantActiveConnectorCatalogPageSchema.safeParse(pageValue);
      if (!parsed.success || parsed.data.tenantId !== tenantId) {
        problems.push('Typed tenant Connector catalog response was unreadable or out of scope.');
        break;
      }
      for (const revision of parsed.data.items) {
        const key = `${revision.connectorId}@${revision.revision}`;
        items.set(key, {
          connectorId: revision.connectorId,
          revision: revision.revision,
          tenantId: revision.tenantId,
          state: 'ACTIVE',
          provider: revision.provider,
          model: revision.model,
        });
      }
      const cursor = parsed.data.nextCursor;
      if (cursor === null) break;
      if (visitedCursors.has(cursor) || pageNumber === 99) {
        problems.push('Typed tenant Connector catalog pagination did not finish safely.');
        break;
      }
      visitedCursors.add(cursor);
      const nextPage = await client.listTenantActiveConnectorRevisions({ tenantId, limit: 100, cursor });
      if (!nextPage.ok) {
        problems.push(`Typed tenant Connector catalog page unavailable (${nextPage.status}).`);
        break;
      }
      pageValue = nextPage.data;
    }
  }

  const sorted = [...items.values()].sort((a, b) =>
    a.connectorId.localeCompare(b.connectorId) || a.revision - b.revision,
  );
  return { items: sorted, problem: problems.length ? problems.join(' ') : null };
}

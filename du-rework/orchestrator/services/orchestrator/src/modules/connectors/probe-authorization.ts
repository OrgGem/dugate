import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { parseConnectorBindings } from '../profiles/profiles';

export interface ConnectorProbePrincipal {
  readonly id: string;
  readonly tenantId: string;
}

/** Readiness is restricted to enabled, currently published bindings for this key. */
export async function authorizeConnectorProbe(
  db: Pick<Db, 'query'>,
  principal: ConnectorProbePrincipal,
  connectorId: string,
): Promise<void> {
  const result = await db.query<{
    api_key_id: string;
    tenant_id: string;
    enabled: boolean;
    connector_bindings: unknown;
  }>(
    `SELECT p.api_key_id, p.tenant_id, p.enabled, p.connector_bindings
       FROM profile_active_revisions a
       JOIN profile_bindings p
         ON p.profile_id = a.profile_id AND p.revision = a.revision
       JOIN api_keys k ON k.id = p.api_key_id AND k.tenant_id = p.tenant_id
      WHERE p.api_key_id = $1 AND p.tenant_id = $2
        AND p.enabled = true AND k.status = 'ACTIVE'`,
    [principal.id, principal.tenantId],
  );
  for (const row of result.rows) {
    // Keep the ownership boundary explicit even if a repository projection changes.
    if (row.api_key_id !== principal.id || row.tenant_id !== principal.tenantId || row.enabled !== true) continue;
    let bindings: ReturnType<typeof parseConnectorBindings>;
    try {
      bindings = parseConnectorBindings(row.connector_bindings);
    } catch {
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector probe authorization is unavailable');
    }
    if (Object.values(bindings).some((binding) => binding.connectorId === connectorId)) return;
  }
  // No legacy fallback to the global deployment registry for a public probe.
  throw new HttpError(403, 'PERMISSION_DENIED', 'connector probe is not permitted');
}

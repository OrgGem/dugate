import { PromptOverrideKey, PromptOverrideRead } from '@du/contracts';
import { Db } from '../../db/db';

/**
 * T-PROM-01 — the `connector_prompt_overrides` repository (migration 0026 §3).
 *
 * Storage for legacy `ExternalApiOverride`, keyed by the same composite
 * `(connection_id, api_key_id, endpoint_slug, step_id)`. Two legacy semantics
 * are load-bearing and are enforced here rather than left to a caller:
 *
 *  1. **`isActive: false` DELETES.** Legacy
 *     `app/api/internal/ext-overrides/route.ts` deletes the row when
 *     `isActive === false`; a stored row therefore always means active. The
 *     `is_active` column exists because the plan's action schema carries the
 *     flag, but this repository never sets it to false — parking a disabled
 *     row would strand it where legacy's list endpoint could not show it.
 *  2. **`promptOverride: null` and `promptOverride: ""` are the same act**:
 *     both clear the override (legacy `.trim() ?? null`), and clearing is
 *     distinct from deleting. Clearing leaves an empty row; deleting removes
 *     the key. Both end with no effective prompt at this step.
 *
 * The read half (`resolvePromptOverride`) is what T-PROM-02 pins at submit.
 */

interface OverrideRow {
  id: string;
  connection_id: string;
  api_key_id: string;
  endpoint_slug: string;
  step_id: string;
  prompt_override: string | null;
  updated_at: Date;
}

/** DB row → wire shape (PromptOverrideReadSchema). */
function toRead(row: OverrideRow): PromptOverrideRead {
  return {
    connectionId: row.connection_id,
    apiKeyId: row.api_key_id,
    endpointSlug: row.endpoint_slug,
    stepId: row.step_id,
    promptOverride: row.prompt_override,
    isActive: true,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The `ON CONFLICT` target: the same four columns the unique constraint
 * names, so an upsert hits the row rather than the constraint failure.
 */
const UPSERT_SQL = `
  INSERT INTO connector_prompt_overrides
    (tenant_id, connection_id, api_key_id, endpoint_slug, step_id, prompt_override, is_active)
  VALUES ($1,$2,$3,$4,$5,$6, true)
  ON CONFLICT (connection_id, api_key_id, endpoint_slug, step_id)
  DO UPDATE SET prompt_override = EXCLUDED.prompt_override,
                is_active       = true,
                updated_at      = now()
  RETURNING id, connection_id, api_key_id, endpoint_slug, step_id,
            prompt_override, updated_at
`;

const ROW_COLUMNS = `
  id, connection_id, api_key_id, endpoint_slug, step_id, prompt_override, updated_at
`;

export function createPromptOverrideService(db: Db) {
  return {
    /**
     * The override for one step, or `null` when the step has none.
     *
     * Legacy resolved two steps, exact then `_default`; this is the exact
     * lookup and is what the caller pins. The `_default` fallback is
     * `resolvePromptOverride`'s job (T-PROM-02) because it needs the caller's
     * step id too.
     */
    async get(
      key: PromptOverrideKey,
      tenantId?: string
    ): Promise<PromptOverrideRead | null> {
      const params: unknown[] = [key.connectionId, key.apiKeyId, key.endpointSlug, key.stepId];
      let sql = `SELECT ${ROW_COLUMNS} FROM connector_prompt_overrides
                  WHERE connection_id=$1 AND api_key_id=$2 AND endpoint_slug=$3 AND step_id=$4`;
      if (tenantId) {
        sql += ' AND tenant_id=$5';
        params.push(tenantId);
      }
      const hit = await db.query<OverrideRow>(sql, params);
      return hit.rowCount ? toRead(hit.rows[0]!) : null;
    },

    /**
     * Every override row for one (api key, endpoint) — the same query legacy
     * ran once before its pipeline loop, returning the whole bucket instead
     * of one row. T-SUB-02 pins this bucket into the operation so the worker
     * never reads the live table.
     */
    async listFor(
      apiKeyId: string,
      endpointSlug: string,
      tenantId?: string
    ): Promise<PromptOverrideRead[]> {
      const params: unknown[] = [apiKeyId, endpointSlug];
      let sql = `SELECT ${ROW_COLUMNS} FROM connector_prompt_overrides
                  WHERE api_key_id=$1 AND endpoint_slug=$2`;
      if (tenantId) {
        sql += ' AND tenant_id=$3';
        params.push(tenantId);
      }
      const hit = await db.query<OverrideRow>(sql, params);
      return hit.rows.map(toRead);
    },

    /**
     * Create or update one override.
     *
     * `isActive === false` becomes a DELETE (legacy POST semantics). The
     * method still returns the read shape so a caller can render the result
     * without knowing which branch ran; a delete yields the shape with
     * `promptOverride: null`.
     */
    async upsert(
      tenantId: string,
      params: {
        connectionId: string;
        apiKeyId: string;
        endpointSlug: string;
        stepId: string;
        promptOverride: string | null;
        isActive?: boolean;
      }
    ): Promise<PromptOverrideRead> {
      // Legacy trims the content and stores null for the empty string.
      const content =
        params.promptOverride === null ? null : params.promptOverride.trim() || null;

      if (params.isActive === false) {
        const removed = await db.query<OverrideRow>(
          `DELETE FROM connector_prompt_overrides
            WHERE tenant_id=$1 AND connection_id=$2 AND api_key_id=$3
              AND endpoint_slug=$4 AND step_id=$5
            RETURNING ${ROW_COLUMNS}`,
          [tenantId, params.connectionId, params.apiKeyId, params.endpointSlug, params.stepId]
        );
        // Not found is still a successful clear: the desired end state (no
        // override at this step) already holds. Throwing here would make a
        // client's idempotent "turn this off" fail on a second press.
        const row = removed.rows[0];
        return row
          ? toRead(row)
          : {
              connectionId: params.connectionId,
              apiKeyId: params.apiKeyId,
              endpointSlug: params.endpointSlug,
              stepId: params.stepId,
              promptOverride: null,
              isActive: false,
              updatedAt: new Date().toISOString(),
            };
      }

      const hit = await db.query<OverrideRow>(UPSERT_SQL, [
        tenantId,
        params.connectionId,
        params.apiKeyId,
        params.endpointSlug,
        params.stepId,
        content,
      ]);
      return toRead(hit.rows[0]!);
    },

    /**
     * Delete every override for one (api key) — or (api key, connection) when
     * a connection id is given. Matches legacy DELETE, which took only those
     * two keys and deliberately ignored step/endpoint.
     */
    async remove(
      tenantId: string,
      filter: { apiKeyId: string; connectionId?: string }
    ): Promise<number> {
      const params: unknown[] = [tenantId, filter.apiKeyId];
      let sql = 'DELETE FROM connector_prompt_overrides WHERE tenant_id=$1 AND api_key_id=$2';
      if (filter.connectionId) {
        params.push(filter.connectionId);
        sql += ' AND connection_id=$3';
      }
      const hit = await db.query(sql, params);
      return hit.rowCount ?? 0;
    },
  };
}

export type PromptOverrideService = ReturnType<typeof createPromptOverrideService>;

/**
 * The override a `connectionId` + `stepId` should use, applying legacy's
 * two-step fallback (exact step → `_default`).
 *
 * Deliberately NOT a DB query: T-PROM-02 pins the bucket at submit, so this
 * only ever reads the already-pinned list. A live lookup here would be the
 * PRF-02 violation the whole snapshot design exists to prevent.
 *
 * `code`-injected `_prompt` outranks everything, but it is not a row in this
 * table — it arrives in the call's `variables`, so it is checked by the
 * caller before this function is consulted.
 */
export function pickPromptOverride(
  bucket: readonly PromptOverrideRead[],
  connectionId: string,
  stepId: string
): PromptOverrideRead | null {
  const exact = bucket.find(
    (row) => row.connectionId === connectionId && row.stepId === stepId
  );
  return exact ?? (bucket.find(
    (row) => row.connectionId === connectionId && row.stepId === '_default'
  ) ?? null);
}

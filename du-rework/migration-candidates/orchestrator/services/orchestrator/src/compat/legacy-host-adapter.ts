import type { LegacyBillingSnapshot, LegacyCompatHost, LegacyOperationRow } from './legacy-http-mount';
import type { RouteContext } from '../server';

/**
 * Binds the legacy facade to the live orchestrator.
 *
 * Every capability is OPTIONAL on the host interface, and this factory reports
 * only what it can genuinely do. A capability left undefined makes the mount
 * answer 500 rather than fabricate a success — which is the honest outcome
 * while the corresponding queue/lifecycle work is still outstanding, and keeps
 * a half-wired path from looking like parity.
 *
 * ## Fencing
 *
 * Every query filters on `tenant_id = $2` with the tenant that came from the
 * resolved API key. The legacy routes guarded with `if (apiKeyId && ...)` after
 * an edge that stripped the header, so the fence usually never ran; the
 * predicates here are unconditional instead.
 */
/**
 * The canonical business the six core legacy actions route into.
 *
 * `legacy-action-router.ts` declares the same default, so the compat submit and
 * the compat serializer cannot drift onto different businesses.
 */
export const LEGACY_BUSINESS_ID = 'document-core';

/**
 * Map a legacy multipart field name onto the canonical artifact role.
 *
 * `compare` reads its two documents by role, so `source_file` must stay
 * distinguishable from `target_file` after the legacy field name is gone.
 * Everything else is a plain source input, which is what `files[]` and `file`
 * meant in the old runner.
 */
function legacyFileRole(field: string): string {
  if (field === 'source_file') return 'source';
  if (field === 'target_file') return 'target';
  return 'source';
}

export function legacyCompatHost(ctx: RouteContext): LegacyCompatHost {
  const base: LegacyCompatHost = {
    db: ctx.db,
    loadOperation: (operationId, tenantId) => loadLegacyRow(ctx, operationId, tenantId),
    loadOutputContent: (operationId, tenantId) => loadLegacyOutput(ctx, operationId, tenantId),
  };

  return {
    ...base,
    submitLegacy: async (principal, action, decoded) => {
      // Files first: the submission references their artifact ids, so they
      // must exist before the operation row is written.
      const artifacts: { artifactId: string; role: string }[] = [];
      for (const part of decoded.files) {
        const file = part.value as { name: string; size: number; type: string; bytes: Buffer };
        const stored = await ctx.artifacts.putPublicArtifact({
          tenantId: principal.tenantId,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          bytes: file.bytes,
        });
        artifacts.push({ artifactId: stored.artifactId, role: legacyFileRole(part.field) });
      }
      const result = await ctx.submission.submit({
        tenantId: principal.tenantId,
        apiKeyId: principal.apiKeyId,
        businessId: LEGACY_BUSINESS_ID,
        action,
        ...(decoded.idempotencyKey === undefined ? {} : { idempotencyKey: decoded.idempotencyKey }),
        ...(decoded.correlationId === undefined ? {} : { correlationId: decoded.correlationId }),
        submission: {
          input: decoded.submission.input,
          output: decoded.submission.output,
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(decoded.submission.sourceUrl === undefined ? {} : { sourceUrl: decoded.submission.sourceUrl }),
          ...(decoded.submission.callback === undefined ? {} : { callback: decoded.submission.callback }),
        },
      });
      return { operationId: result.operation.id, replayed: result.replayed };
    },
    cancelLegacy: async (operationId, tenantId) => {
      const existing = await loadLegacyRow(ctx, operationId, tenantId);
      if (existing === null) return { ok: false, status: 404 };
      if (existing.done) return { ok: false, status: 409 };
      // CANCEL_REQUESTED, not CANCELLED: the legacy route wrote a terminal
      // state while the worker was still running, and API-COMPAT-DUGATE
      // :56 forbids faking a terminal state. The worker flips it to CANCELLED
      // when it actually stops. See docs/39-legacy-parity-contract.md 4.2.
      const res = await ctx.db.query(
        `UPDATE operations SET state = 'CANCEL_REQUESTED', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
        [operationId, tenantId],
      );
      if (!res.rowCount) return { ok: false, status: 409 };
      const after = await loadLegacyRow(ctx, operationId, tenantId);
      if (after === null) return { ok: false, status: 404 };
      return { ok: true, row: after };
    },
    resumeLegacy: async (operationId, tenantId, body) => {
      const existing = await loadLegacyRow(ctx, operationId, tenantId);
      if (existing === null) return { ok: false, status: 404, state: '' };
      if (existing.state !== 'WAITING_INPUT') {
        return { ok: false, status: 400, state: existing.state };
      }
      const resumed = await ctx.runtime.resumeOperation(operationId, tenantId, body as never);
      return { ok: true, wasReplayed: resumed.replayed };
    },
    softDeleteOperation: async (operationId, tenantId) => {
      const res = await ctx.db.query(
        'UPDATE operations SET deleted_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
        [operationId, tenantId],
      );
      return Boolean(res.rowCount);
    },
    listLegacyOperations: async (input) => {
      const params: unknown[] = [input.tenantId, input.pageSize + 1];
      const where: string[] = ['tenant_id = $1', 'deleted_at IS NULL'];
      if (input.states.length > 0) {
        params.push(input.states);
        where.push(`state = ANY($${params.length}::text[])`);
      }
      for (const processor of input.processors) {
        params.push(`%${processor}%`);
        where.push(`pipeline_json::text ILIKE $${params.length}`);
      }
      if (input.pageToken !== null) {
        // The legacy page_token is the id of the last row on the previous
        // page, read back through an equality lookup on id.
        params.push(input.pageToken);
        where.push(
          `(created_at, id) < (SELECT created_at, id FROM operations WHERE id = $${params.length})`,
        );
      }
      const rows = await ctx.db.query(
        `SELECT * FROM operations WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $2`,
        params,
      );
      const all = rows.rows as Record<string, unknown>[];
      const hasMore = all.length > input.pageSize;
      return { rows: all.slice(0, input.pageSize).map(toLegacyRow), hasMore };
    },
    billingFor: async (apiKeyId) => loadLegacyBilling(ctx, apiKeyId),
  };
}

/**
 * Map a database row onto the projection the legacy envelope reads.
 *
 * The numeric and jsonb columns arrive as strings from `pg` when the type has
 * no parser, so they are coerced here rather than at every read site. A NULL
 * stays null on purpose: the legacy formatter emitted the column value as-is,
 * and coalescing to 0 would report an unmeasured call as free.
 */
export function toLegacyRow(row: Record<string, unknown>): LegacyOperationRow {
  const num = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    done: isTerminalState(String(row.state)),
    state: String(row.state),
    pipelineJson: jsonOrNull(row.pipeline_json),
    stepsResultJson: jsonOrNull(row.steps_result_json),
    currentStep: num(row.current_step),
    progressPercent: num(row.progress_percent),
    progressMessage: text(row.progress_message),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    outputFormat: text(row.output_format),
    outputContent: text(row.output_content),
    extractedData: jsonOrNull(row.extracted_data),
    totalInputTokens: num(row.total_input_tokens),
    totalOutputTokens: num(row.total_output_tokens),
    pagesProcessed: num(row.pages_processed),
    modelUsed: text(row.model_used),
    totalCostUsd: num(row.total_cost_usd),
    usageBreakdown: jsonOrNull(row.usage_breakdown),
    errorCode: text(row.error_code),
    errorMessage: text(row.error_message),
    failedAtStep: num(row.failed_at_step),
    endpointSlug: text(row.endpoint_slug),
  };
}

/** `jsonb` columns arrive already parsed; the legacy contract wants a string. */
function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
]);

/**
 * `done` is derived from the state, exactly as the legacy formatter derived it
 * from the row — never from a caller-supplied flag.
 */
function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Read one operation for the legacy surface.
 *
 * `deleted_at IS NULL` is part of the predicate, not a post-filter, so a
 * soft-deleted row 404s exactly like a missing one and cannot be probed by
 * timing the difference between two 404 shapes.
 */
async function loadLegacyRow(
  ctx: RouteContext,
  operationId: string,
  tenantId: string,
): Promise<LegacyOperationRow | null> {
  const res = await ctx.db.query(
    'SELECT * FROM operations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
    [operationId, tenantId],
  );
  if (!res.rowCount) return null;
  return toLegacyRow(res.rows[0] as Record<string, unknown>);
}

/**
 * Inline output bytes for the download route.
 *
 * Only the inline branch is implemented: the legacy route also streamed from
 * `outputFilePath` through a storage backend, and returning null for that case
 * surfaces as the documented 404 `no-output` rather than a wrong MIME type.
 */
async function loadLegacyOutput(
  ctx: RouteContext,
  operationId: string,
  tenantId: string,
): Promise<Buffer | null> {
  const res = await ctx.db.query(
    'SELECT output_content FROM operations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
    [operationId, tenantId],
  );
  if (!res.rowCount) return null;
  const raw = (res.rows[0] as { output_content: string | null }).output_content;
  return raw === null ? null : Buffer.from(raw, 'utf8');
}

/**
 * Per-API-KEY spend for the two billing routes.
 *
 * The key row supplies the name and the limit; the operation rows supply the
 * spend. Aggregating from operations rather than from a tenant-level usage
 * view is deliberate: the legacy balance is a KEY total, and
 * `docs/06-public-api.md:29` forbids substituting a tenant total for it.
 */
async function loadLegacyBilling(
  ctx: RouteContext,
  apiKeyId: string,
): Promise<LegacyBillingSnapshot | null> {
  const key = await ctx.db.query(
    'SELECT name, spending_limit, total_used FROM api_keys WHERE id = $1',
    [apiKeyId],
  );
  if (!key.rowCount) return null;
  const keyRow = key.rows[0] as { name: string | null; spending_limit: string; total_used: string };

  const spend = await ctx.db.query(
    `SELECT model_used,
           COALESCE(SUM(total_input_tokens), 0)  AS prompt_tokens,
           COALESCE(SUM(total_output_tokens), 0) AS completion_tokens,
           COALESCE(SUM(pages_processed), 0)      AS pages_processed,
           COALESCE(SUM(total_cost_usd), 0)       AS cost_usd
     FROM operations
     WHERE api_key_id = $1 AND state = 'SUCCEEDED' AND deleted_at IS NULL
     GROUP BY model_used`,
    [apiKeyId],
  );

  const byModel = (spend.rows as Record<string, unknown>[]).map((row) => ({
    model: row.model_used === null ? 'unknown' : String(row.model_used),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    pagesProcessed: Number(row.pages_processed),
    costUsd: Number(row.cost_usd),
  }));

  const count = await ctx.db.query(
    "SELECT COUNT(*)::int AS n FROM operations WHERE api_key_id = $1 AND state = 'SUCCEEDED' AND deleted_at IS NULL",
    [apiKeyId],
  );
  const operationCount = Number((count.rows[0] as { n: number }).n);

  return {
    name: keyRow.name,
    spendingLimit: Number(keyRow.spending_limit),
    totalUsed: Number(keyRow.total_used),
    byModel,
    operationCount,
  };
}



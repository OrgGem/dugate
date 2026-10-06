/**
 * CONV-01: admin operation detail projection (moved verbatim from server.ts).
 */
import type { Db } from '../../db/db';
import type { createRuntimeService } from '../runtime/runtime';
import type { createUsageService } from '../usage/usage';
import { assertReadableWithoutSeam, type MetadataCrypto } from '../runtime/metadata-crypto';
import { compatibilityMetadataReader, type MetadataReader } from '../encryption/metadata-read-policy';
import { toOperationView } from './facade';
import { RequestRedactionRulesSchema, type RequestRedactionRule } from '@du/contracts';
import { redactRequestInput, hiddenRequestInput, type RequestInputView } from './request-redaction';

type RuntimeService = ReturnType<typeof createRuntimeService>;
type UsageService = ReturnType<typeof createUsageService>;

/** Narrow context: only the three collaborators this projection reads. */
export interface AdminOperationDetailContext {
  db: Db;
  runtime: Pick<RuntimeService, 'getOperation'>;
  usage: Pick<UsageService, 'project'>;
  /**
   * FU-ENCMETA-ADMIN: the metadata-encryption seam. Optional so callers that
   * have no seam keep compiling; when absent the projection falls back to the
   * stored value verbatim (the historical backfill-window convention).
   */
  metadataCrypto?: MetadataCrypto | null;
  /** CONTROL-PLANE-IMPL-818: boot-built reader; compat fallback when absent. */
  metadataReader?: MetadataReader | null;
}

/**
 * ADM-BASE-01: camelCase operation row for the shell's detail envelope.
 * The fetcher's `normaliseOperation` requires camelCase `id`,
 * `tenantId`, `businessId`, … — `toOperationView` (docs-06 public
 * shape) uses the same names, so it is reused and extended with the
 * admin-only tenant pin.
 */
export function toOperationDetailWire(r: Record<string, unknown>): Record<string, unknown> {
  return { ...toOperationView(r), tenantId: r.tenant_id };
}

/** Current rules also protect historical requests; execution still uses its pin. */
export async function buildAdminRequestInput(ctx: AdminOperationDetailContext, op: Record<string, unknown>): Promise<RequestInputView | undefined> {
  if (op.input_ref === undefined || op.input_ref === null) return undefined;
  try {
    let rules: RequestRedactionRule[] = [];
    if (op.profile_id) {
      const policies = await ctx.db.query<{
        request_redaction: unknown; is_current: boolean; is_pinned: boolean;
      }>(`SELECT p.request_redaction, p.revision = a.revision AS is_current,
                 p.revision = $3 AS is_pinned
            FROM profile_bindings p
            JOIN profile_active_revisions a ON a.profile_id = p.profile_id
           WHERE p.profile_id = $1 AND p.tenant_id = $2
             AND (p.revision = $3 OR p.revision = a.revision)
           ORDER BY (p.revision = a.revision), p.revision`,
      [op.profile_id, op.tenant_id, op.profile_revision]);
      if (!policies.rows.some(row => row.is_current) || !policies.rows.some(row => row.is_pinned)) return hiddenRequestInput();
      const unique = new Map<string, RequestRedactionRule>();
      for (const row of policies.rows) {
        const parsed = RequestRedactionRulesSchema.safeParse(row.request_redaction);
        if (!parsed.success) return hiddenRequestInput();
        for (const rule of parsed.data) unique.set(JSON.stringify(rule), rule);
      }
      rules = [...unique.values()];
    }
    let stored: unknown = op.input_ref;
    if (typeof stored === 'string') stored = JSON.parse(stored) as unknown;
    if (!ctx.metadataCrypto) assertReadableWithoutSeam(stored);
    const input = ctx.metadataCrypto
      ? await (ctx.metadataReader ?? compatibilityMetadataReader(ctx.metadataCrypto)).readStored(stored, {
          tenantId: String(op.tenant_id), slot: 'operations.input_ref', refId: String(op.id),
        })
      : stored;
    return await redactRequestInput(input, rules);
  } catch { return hiddenRequestInput(); }
}

/**
 * ADM-BASE-01: merged `{ operation, result, artifacts, serverNow }`
 * envelope the shell's detail fetcher parses. `result` reuses the
 * public result projection (SUCCEEDED only, else null); `artifacts`
 * reuses the CR-12/MM-02 READY-refs projection. Cross-tenant for the
 * platform bearer; behind requireResourceTenant() for tenant operators
 * (ADM-BASE-02, by-id 404 fence).
 */
export async function buildAdminOperationDetail(ctx: AdminOperationDetailContext, operationId: string): Promise<Record<string, unknown>> {
  const op = await ctx.runtime.getOperation(operationId);
  const terminal = (op.state as string) === 'SUCCEEDED';
  let result: unknown = null;
  let artifacts: unknown[] = [];
  if (terminal) {
    const arts = await ctx.db.query(
      `SELECT a.id, a.purpose, a.mime_type, a.size_bytes, a.sha256,
              COALESCE(o.submit_artifacts, '[]'::jsonb) AS submit_roles
       FROM operations o
       LEFT JOIN artifacts a
         ON a.state = 'READY'
        AND a.tenant_id = o.tenant_id
        AND a.purpose IN ('input', 'output')
        AND (
          (a.operation_id = o.id AND a.purpose = 'output')
          OR COALESCE(o.submit_artifacts, '[]'::jsonb) @>
             jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
        )
       WHERE o.id = $1`,
      [operationId]
    );
    const submitRoles = new Map<string, string>();
    for (const row of arts.rows as { submit_roles: unknown }[]) {
      const declared = (row.submit_roles as { artifactId?: unknown; role?: unknown }[] | null) ?? [];
      if (Array.isArray(declared)) {
        for (const d of declared) {
          if (typeof d?.artifactId === 'string' && typeof d?.role === 'string') {
            submitRoles.set(d.artifactId, d.role);
          }
        }
      }
      break;
    }
    artifacts = (arts.rows as {
      id: string | null; purpose: string | null; mime_type: string | null;
      size_bytes: number | string | null; sha256: string | null;
    }[])
      .filter((r) => r.id !== null)
      .map((r) => ({
        artifactId: r.id as string,
        role: submitRoles.get(r.id as string) ?? r.purpose ?? 'output',
        mimeType: r.mime_type ?? undefined,
        sizeBytes: r.size_bytes === null ? undefined : Number(r.size_bytes),
        hashSha256: r.sha256 ?? undefined,
        download: `/api/v1/artifacts/${r.id as string}/download`,
      }));
    // FU-ENCMETA-ADMIN: `getOperation` is SELECT *, so `result_ref` arrives
    // exactly as stored — which is a SEALED envelope once the metadata seam is
    // on. Copying it through leaked that envelope to the admin wire while the
    // public R1 route opened it and returned the opaque pointer, so the two
    // readers disagreed about the same value. Open it with the SAME slot/tenant/
    // id triple R1 uses; no seam (or a legacy plaintext row) keeps the stored
    // value verbatim, which is the backfill-window convention everywhere else.
    const openedResultRef =
      op.result_ref == null
        ? undefined
        : await (ctx.metadataReader ?? compatibilityMetadataReader(ctx.metadataCrypto ?? undefined)).readStoredText(
            String(op.result_ref),
            { tenantId: String(op.tenant_id), slot: 'operations.result_ref', refId: String(op.id) },
          );
    result = {
      schemaVersion: '1',
      data: openedResultRef ? { resultRef: openedResultRef } : {},
      artifacts,
      usage: await ctx.usage.project(operationId),
      warnings: [],
    };
  }
  const tasks = await ctx.db.query(
    `SELECT id, task_key AS "taskKey", kind, state, attempt, max_attempts AS "maxAttempts",
            error_code AS "errorCode" FROM tasks WHERE operation_id=$1 ORDER BY created_at ASC, id ASC`,
    [operationId],
  );
  return {
    tasks: tasks.rows,
    operation: toOperationDetailWire(op),
    ...(op.input_ref != null ? { requestInput: await buildAdminRequestInput(ctx, op) } : {}),
    result,
    artifacts,
    serverNow: new Date().toISOString(),
  };
}
import { z } from 'zod';
import { LegacyWorkflowTaskInputSchema } from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import type { createSubmissionService } from '../operations/submission';
import { resolveLegacyWorkflowSchema } from '../workflow-schemas/workflow-schemas';
import type { createAdminIdentityService } from '../identity/service';
import type { AdminActionAuth } from '../admin-actions/rbac';
import { assertAdminWorkbenchAdmissionScope, trustedLocalAdminWorkbenchActor } from '../admin-workbench/service';

export const WorkflowTestSchema = z.object({
  tenantId: z.string().uuid(), apiKeyId: z.string().uuid(), slug: z.string().min(1).max(128),
  expectedRevision: z.number().int().positive(), variables: z.record(z.unknown()),
  artifacts: z.array(z.object({ artifactId: z.string().uuid(), role: z.string().min(1) }).strict()).max(20).default([]),
}).strict();

export async function submitWorkflowTest(deps: {
  db: Db;
  submission: ReturnType<typeof createSubmissionService>;
  metadataCrypto?: MetadataCrypto;
  correlationId: string;
  /** Supplied only by the server-owned admin actions route. */
  identity?: ReturnType<typeof createAdminIdentityService>;
  /** Opaque-session/bearer auth resolved by the server, never by request JSON. */
  auth?: AdminActionAuth;
}, input: unknown, idempotencyKey?: string) {
  const parsed = WorkflowTestSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow.test requires tenant, active API key, schema revision, variables and optional artifact references');
  const p = parsed.data;
  const key = await deps.db.query('SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status=\'ACTIVE\'', [p.apiKeyId, p.tenantId]);
  if (!key.rowCount) throw new HttpError(404, 'NOT_FOUND', 'active API key not found in tenant');
  const pin = await resolveLegacyWorkflowSchema(deps.db, { tenantId: p.tenantId, slug: p.slug }, deps.metadataCrypto);
  if (!pin) throw new HttpError(404, 'NOT_FOUND', 'active workflow schema not found');
  if (pin.revision !== p.expectedRevision) throw new HttpError(409, 'STATE_CONFLICT', 'workflow revision changed; reload before testing');
  const artifactIds = p.artifacts.map(artifact => artifact.artifactId);
  // The worker contract pairs filenames with artifactIds in caller order. Resolve
  // metadata server-side; callers may not spoof extensions or another key's file.
  const files = artifactIds.length ? await deps.db.query<{ id: string; file_name: string | null }>(
    `SELECT id,file_name FROM artifacts WHERE id=ANY($1::uuid[]) AND tenant_id=$2
      AND state='READY' AND (expires_at IS NULL OR expires_at>now())
      AND ((operation_id IS NULL AND upload_api_key_id=$3) OR EXISTS (
        SELECT 1 FROM operations owner WHERE owner.id=artifacts.operation_id AND owner.tenant_id=$2 AND owner.api_key_id=$3 AND owner.deleted_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM operations owner WHERE owner.tenant_id=$2 AND owner.api_key_id=$3 AND owner.deleted_at IS NULL
          AND owner.submit_artifacts @> jsonb_build_array(jsonb_build_object('artifactId',artifacts.id::text))
      ))
      AND NOT EXISTS (
        SELECT 1 FROM operations owner WHERE owner.tenant_id=$2 AND owner.api_key_id<>$3
          AND owner.submit_artifacts @> jsonb_build_array(jsonb_build_object('artifactId',artifacts.id::text))
      )`, [artifactIds,p.tenantId,p.apiKeyId],
  ) : { rows: [] };
  const names = new Map(files.rows.map(file => [file.id, file.file_name]));
  if (artifactIds.some(id => !names.get(id))) throw new HttpError(404, 'NOT_FOUND', 'ready named artifact not found for the selected API key');
  const taskInput = LegacyWorkflowTaskInputSchema.safeParse({ variables: p.variables, artifactIds, fileNames: artifactIds.map(id => names.get(id)), artifacts: p.artifacts });
  if (!taskInput.success) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow test input failed worker contract validation');
  // The local USER path must prove both live key and Profile assignments for
  // the exact Profile selected by the normal action admission resolver. No
  // profile identifier or local identity is accepted from the body. The final
  // submit repeats normal admission against current state after this fence.
  const localActor = deps.auth ? trustedLocalAdminWorkbenchActor(deps.auth) : null;
  if (localActor) {
    if (typeof deps.submission.preflightLegacyWorkflow !== 'function') {
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'workflow Profile admission is unavailable');
    }
    const profile = await deps.submission.preflightLegacyWorkflow({
      tenantId: p.tenantId,
      apiKeyId: p.apiKeyId,
      businessId: 'document-core',
      action: 'schema-workflow',
      input: taskInput.data as unknown as Record<string, unknown>,
      fileNames: taskInput.data.fileNames,
    });
    if (profile.mode !== 'pinned') {
      throw new HttpError(403, 'PERMISSION_DENIED', 'local USER workflow tests require an assigned active Profile');
    }
    await assertAdminWorkbenchAdmissionScope(deps.identity, deps.auth!, {
      tenantId: p.tenantId,
      apiKeyId: p.apiKeyId,
      profileId: profile.profileId,
    });
  }
  const result = await deps.submission.submit({ tenantId: p.tenantId, apiKeyId: p.apiKeyId, businessId: 'document-core', action: 'schema-workflow', correlationId: deps.correlationId, idempotencyKey, workflowSchemaPin: pin,
    legacyProjection: { endpointSlug: `workflows:schema:${p.slug}`, pipelineJson: [{ processor: 'ext-classifier', workflow: p.slug, schemaRevision: pin.revision, schemaDigest: pin.digest }], progressMessage: 'Initializing schema workflow...' },
    submission: { input: taskInput.data, output: {}, ...(p.artifacts.length ? { artifacts: p.artifacts } : {}) },
  });
  return { operationId: result.operation.id, operation: result.operation, replayed: result.replayed };
}

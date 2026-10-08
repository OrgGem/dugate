import { randomUUID } from 'node:crypto';
import type { LegacyBillingSnapshot, LegacyCompatHost, LegacyOperationRow } from './legacy-http-mount';
import { LegacyWorkflowResultSchema, type LegacyWorkflowSchemaPin } from '@du/contracts';
import type { RouteContext } from '../server';
import { resolveLegacyWorkflowSchema } from '../modules/workflow-schemas/workflow-schemas';
import { compatibilityMetadataReader } from '../modules/encryption/metadata-read-policy';

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

function isPostgresLockUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === '55P03';
}

/**
 * Map the canonical parked-wait state onto the legacy token.
 *
 * WFA 6c: the legacy contract exposes `WAITING_USER_INPUT` for every parked
 * wait; the canonical `WAITING_INPUT` token must never leak back to old
 * clients, whether or not the row carries a workflow marker. The mapping is
 * therefore applied unconditionally at every legacy projection.
 */
function legacyWorkflowState(state: string): string {
  return state === 'WAITING_INPUT' ? 'WAITING_USER_INPUT' : state;
}

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

function legacyWorkflowFileRole(field: string, index: number): string {
  if (field === 'source_file') return 'source';
  if (field === 'target_file') return 'target';
  if (field === 'file') return 'file';
  return `files-${index + 1}`;
}

export function legacyCompatHost(ctx: RouteContext): LegacyCompatHost {
  const base: LegacyCompatHost = {
    db: ctx.db,
    loadOperation: (operationId, tenantId, apiKeyId) => loadLegacyRow(ctx, operationId, tenantId, apiKeyId),
    loadOutputContent: (operationId, tenantId, apiKeyId) => loadLegacyOutput(ctx, operationId, tenantId, apiKeyId),
  };

  return {
    ...base,
    loadOperation: (operationId, tenantId, apiKeyId) => loadLegacyRow(ctx, operationId, tenantId, apiKeyId),
    loadOutputContent: (operationId, tenantId, apiKeyId) => loadLegacyOutput(ctx, operationId, tenantId, apiKeyId),
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
    resolveLegacyWorkflowSchema: (tenantId, slug) =>
      resolveLegacyWorkflowSchema(ctx.db, { tenantId, slug }, ctx.metadataCrypto),
    submitLegacyWorkflow: async (principal, decoded, schemaPin) => {
      const workflowName = decoded.kind === 'named' ? decoded.process : decoded.schemaSlug;
      const businessId = decoded.kind === 'schema'
        ? LEGACY_BUSINESS_ID
        : decoded.process === 'lc-checker'
          ? 'lc-checker'
          : LEGACY_BUSINESS_ID;
      const action = decoded.kind === 'schema' ? 'schema-workflow' : decoded.process;
      const workflowVariables = decoded.kind === 'named' ? decoded.variables : decoded.input;
      const legacyWorkflow = decoded.kind === 'named'
        ? { version: 'legacy-workflow-named-input-v1' as const, process: decoded.process }
        : undefined;
      // Artifact IDs exist only after the upload below, so the pre-write check
      // validates the request shape with stand-in references that are never
      // persisted. submit() re-runs the same action-schema validation against
      // the real uploaded references, and the decoder has already refused a
      // request with fewer than one file.
      const pendingArtifactIds = decoded.files.map(() => randomUUID());
      const pendingArtifactRefs = decoded.files.map((file, index) => ({
        artifactId: pendingArtifactIds[index]!,
        role: legacyWorkflowFileRole(file.field, index),
      }));
      await ctx.submission.preflightLegacyWorkflow({
        tenantId: principal.tenantId,
        apiKeyId: principal.apiKeyId,
        businessId,
        action,
        input: {
          variables: workflowVariables,
          artifactIds: pendingArtifactIds,
          fileNames: decoded.files.map((file) => file.fileName),
          artifacts: pendingArtifactRefs,
          ...(legacyWorkflow ? { legacyWorkflow } : {}),
        },
        fileNames: decoded.files.map((file) => file.fileName),
        ...(schemaPin ? { workflowSchemaPin: schemaPin } : {}),
      });

      // Metadata encryption protects the operation/task snapshots. Artifact
      // bytes have their own envelope and must also be configured before any
      // upload row or blob is created.
      if (decoded.files.length > 0) ctx.artifacts.assertPublicArtifactEncryptionReady();

      const artifactRefs: { artifactId: string; role: string }[] = [];
      const createdArtifactIds: string[] = [];
      try {
        for (let index = 0; index < decoded.files.length; index += 1) {
          const part = decoded.files[index]!;
          const stored = await ctx.artifacts.putPublicArtifact({
            tenantId: principal.tenantId,
            fileName: part.fileName,
            mimeType: part.mimeType || 'application/octet-stream',
            bytes: part.bytes,
            requireEncryption: true,
          });
          createdArtifactIds.push(stored.artifactId);
          artifactRefs.push({ artifactId: stored.artifactId, role: legacyWorkflowFileRole(part.field, index) });
        }

        const endpointSlug = decoded.kind === 'named'
          ? `workflows:${decoded.process}`
          : `workflows:schema:${decoded.schemaSlug}`;
        const workflowInput = {
          variables: decoded.kind === 'named' ? decoded.variables : decoded.input,
          artifactIds: artifactRefs.map((artifact) => artifact.artifactId),
          fileNames: decoded.files.map((file) => file.fileName),
          artifacts: artifactRefs,
          ...(legacyWorkflow ? { legacyWorkflow } : {}),
        };
        const pipelineMarker: Record<string, unknown> = {
          processor: 'ext-classifier',
          workflow: workflowName,
        };
        if (schemaPin) {
          pipelineMarker.schemaRevision = schemaPin.revision;
          pipelineMarker.schemaDigest = schemaPin.digest;
        }

        const result = await ctx.submission.submit({
          tenantId: principal.tenantId,
          apiKeyId: principal.apiKeyId,
          businessId,
          action,
          correlationId: ctx.correlationId,
          ...(schemaPin ? { workflowSchemaPin: schemaPin } : {}),
          legacyProjection: {
            endpointSlug,
            pipelineJson: [pipelineMarker],
            progressMessage: decoded.kind === 'schema'
              ? 'Initializing schema workflow...'
              : 'Initializing workflow...',
          },
          submission: {
            input: workflowInput,
            output: {},
            ...(artifactRefs.length > 0 ? { artifacts: artifactRefs } : {}),
          },
        });

        // The operation, root task and outbox row committed atomically in
        // submission.submit(). A queue outage leaves its durable outbox entry
        // for the dispatcher; it never converts an accepted submission into a
        // compensation or a fabricated HTTP success.
        const dispatchOnce = (ctx.dispatcher as unknown as { dispatchOnce?: () => Promise<unknown> } | undefined)?.dispatchOnce;
        if (ctx.config.autoDispatch !== false && dispatchOnce) {
          void dispatchOnce.call(ctx.dispatcher).catch(() => undefined);
        }
        return { operationId: result.operation.id };
      } catch (error: unknown) {
        if (createdArtifactIds.length > 0) {
          await ctx.artifacts.cleanupUnlinkedPublicArtifacts(principal.tenantId, createdArtifactIds).catch(() => undefined);
        }
        throw error;
      }
    },
    cancelLegacy: async (operationId, principal) => {
      const opFence = `id = $1 AND tenant_id = $2 AND api_key_id = $3 AND deleted_at IS NULL`;
      const terminalStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
      const operation = await ctx.db.query(
        `SELECT state FROM operations WHERE ${opFence}`,
        [operationId, principal.tenantId, principal.apiKeyId],
      );
      if (!operation.rowCount) return { ok: false, status: 404 };
      if (terminalStates.includes(String((operation.rows[0] as { state: string }).state))) {
        return { ok: false, status: 409 };
      }

      let result: { kind: 'cancelled' | 'requested' | 'missing' | 'terminal'; state?: string };
      try {
        result = await ctx.db.tx(async (client) => {
          const locked = await client.query(
            `SELECT id, state FROM operations WHERE ${opFence} FOR UPDATE`,
            [operationId, principal.tenantId, principal.apiKeyId],
          );
          if (!locked.rowCount) return { kind: 'missing' as const };
          const state = String((locked.rows[0] as { state: string }).state);
          if (terminalStates.includes(state)) return { kind: 'terminal' as const };

          // Match the runtime's task-first claim lock order without deadlock:
          // lock all operation tasks with NOWAIT while the operation is locked.
          // If a claimer already owns a task row, this transaction aborts and
          // the fallback below records only CANCEL_REQUESTED after that claim
          // commits. Otherwise the locked task set proves nobody can acquire a
          // live lease before lifecycle cancellation closes every open wait.
          const tasks = await client.query(
            `SELECT id, state,
                    (lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp()) AS lease_active
               FROM tasks WHERE operation_id = $1 ORDER BY id FOR UPDATE NOWAIT`,
            [operationId],
          );
          const hasActiveWorker = tasks.rows.some((task) => {
            const value = task as { state: string; lease_active: boolean };
            // A yielded WAITING_INPUT task retains its last lease timestamp,
            // but no handler is running. Claim changes a task to RUNNING in
            // the same transaction that establishes a new lease; NOWAIT above
            // detects an in-flight claimant before this state check. A RUNNING
            // row whose lease has expired is fenced from writes and can be
            // terminalized safely by the lifecycle service.
            return value.state === 'RUNNING' && value.lease_active === true;
          });
          if (hasActiveWorker) {
            await client.query(
              `UPDATE operations SET state='CANCEL_REQUESTED', cancel_requested=true,
                                     state_version=state_version+1, updated_at=now()
                WHERE ${opFence} AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
              [operationId, principal.tenantId, principal.apiKeyId],
            );
            return { kind: 'requested' as const };
          }

          // The existing lifecycle service performs the atomic terminal
          // transition, cancels unleased tasks, closes OPEN waits and schedules
          // any terminal webhook. It runs inside the lock transaction above.
          await ctx.lifecycle.cancelOperation(operationId, principal.tenantId, client);
          return { kind: 'cancelled' as const };
        });
      } catch (error: unknown) {
        if (!isPostgresLockUnavailable(error)) throw error;
        // A claim can hold task→operation locks. After the NOWAIT rollback,
        // wait for that transaction, then persist the cancel signal without
        // taking task locks or claiming the worker has already stopped.
        const requested = await ctx.db.query(
          `UPDATE operations SET state='CANCEL_REQUESTED', cancel_requested=true,
                                 state_version=state_version+1, updated_at=now()
            WHERE ${opFence} AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
            RETURNING state`,
          [operationId, principal.tenantId, principal.apiKeyId],
        );
        if (requested.rowCount) result = { kind: 'requested' };
        else result = { kind: 'terminal' };
      }

      if (result.kind === 'missing') return { ok: false, status: 404 };
      if (result.kind === 'terminal') return { ok: false, status: 409 };
      const after = await ctx.db.query(
        `SELECT * FROM operations WHERE ${opFence}`,
        [operationId, principal.tenantId, principal.apiKeyId],
      );
      if (!after.rowCount) return { ok: false, status: 404 };
      return { ok: true, row: toLegacyRow(after.rows[0] as Record<string, unknown>) };
    },
    resumeLegacy: async (operationId, principal, body) => {
      // Derive the wait identity and CAS version from the authenticated
      // operation. The legacy body only carries `{step, extracted_data}`;
      // it cannot choose a wait belonging to another task or operation.
      const operation = await ctx.db.query(
        `SELECT id, root_task_id, state, state_version
           FROM operations
          WHERE id = $1 AND tenant_id = $2 AND api_key_id = $3 AND deleted_at IS NULL`,
        [operationId, principal.tenantId, principal.apiKeyId],
      );
      if (!operation.rowCount) return { ok: false, status: 404, state: '' };
      const row = operation.rows[0] as {
        id: string;
        root_task_id: string | null;
        state: string;
        state_version: number;
      };
      if (row.state !== 'WAITING_INPUT') {
        return { ok: false, status: 400, state: legacyWorkflowState(row.state) };
      }
      if (row.root_task_id === null) {
        return { ok: false, status: 400, state: legacyWorkflowState(row.state) };
      }

      const pendingWait = await ctx.db.query(
        `SELECT wait_id
           FROM human_waits
          WHERE operation_id = $1 AND task_id = $2 AND status = 'OPEN' AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 1`,
        [operationId, row.root_task_id],
      );
      if (!pendingWait.rowCount) {
        return { ok: false, status: 400, state: legacyWorkflowState(row.state) };
      }

      // The old route only edited a step when both fields were present; an
      // absent or partial edit still resumed the operation with no changes.
      // Keep that wire behavior and let the pinned wait schema validate the
      // resulting payload inside the runtime transaction.
      const answer: Record<string, unknown> = {};
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const legacy = body as Record<string, unknown>;
        if (typeof legacy.step === 'number' && Number.isSafeInteger(legacy.step)
            && Object.hasOwn(legacy, 'extracted_data')) {
          answer.step = legacy.step;
          answer.extracted_data = legacy.extracted_data;
        }
      }

      try {
        await ctx.runtime.resumeOperation(operationId, principal.tenantId, {
          waitId: String((pendingWait.rows[0] as { wait_id: string }).wait_id),
          input: answer,
          expectedStateVersion: Number(row.state_version),
        });
        return { ok: true };
      } catch (error: unknown) {
        // A concurrent resume/cancel/expiry is reported through the legacy
        // state error envelope. Re-read through the same tenant/key fence so
        // a lost CAS cannot turn into a second queue delivery.
        const current = await ctx.db.query(
          `SELECT state FROM operations
            WHERE id = $1 AND tenant_id = $2 AND api_key_id = $3 AND deleted_at IS NULL`,
          [operationId, principal.tenantId, principal.apiKeyId],
        );
        if (!current.rowCount) return { ok: false, status: 404, state: '' };
        const currentState = String((current.rows[0] as { state: string }).state);
        if (currentState !== 'WAITING_INPUT') {
          return { ok: false, status: 400, state: legacyWorkflowState(currentState) };
        }
        // An input-schema refusal remains a client error, while unexpected
        // storage/runtime failures are allowed to reach the outer error
        // boundary instead of being disguised as a state conflict.
        if (typeof error === 'object' && error !== null
            && 'status' in error && (error as { status?: unknown }).status === 422) {
          return { ok: false, status: 400, state: legacyWorkflowState(currentState) };
        }
        throw error;
      }
    },
    softDeleteOperation: async (operationId, tenantId, apiKeyId) => {
      const res = await ctx.db.query(
        `UPDATE operations SET deleted_at = now()
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
            AND (pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3)`,
        [operationId, tenantId, apiKeyId],
      );
      return Boolean(res.rowCount);
    },
    listLegacyOperations: async (input) => {
      const params: unknown[] = [input.tenantId, input.pageSize + 1, input.apiKeyId];
      const where: string[] = [
        'tenant_id = $1',
        'deleted_at IS NULL',
        "(pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3)",
      ];
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
  const pipelineJson = jsonOrNull(row.pipeline_json);
  const workflowMarkers = workflowMarkersFromPipeline(pipelineJson);
  const rawState = String(row.state);
  // WFA 6c: unconditional — the legacy state token does not depend on the
  // workflow marker. The markers are still projected for the workflow fields.
  const state = legacyWorkflowState(rawState);
  return {
    id: String(row.id),
    done: isTerminalState(rawState),
    state,
    pipelineJson,
    stepsResultJson: jsonOrNull(row.steps_result_json),
    currentStep: num(row.current_step),
    progressPercent: num(row.progress_percent),
    progressMessage: text(row.progress_message),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    outputFormat: text(row.output_format),
    outputContent: text(row.output_content),
    outputFilePath: text(row.output_file_path),
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
    workflow: workflowMarkers.workflow,
    schemaRevision: workflowMarkers.schemaRevision,
    schemaDigest: workflowMarkers.schemaDigest,
  };
}

function workflowMarkersFromPipeline(json: string | null): {
  workflow: string | null;
  schemaRevision: number | null;
  schemaDigest: string | null;
} {
  if (json === null) return { workflow: null, schemaRevision: null, schemaDigest: null };
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'object' || parsed[0] === null) {
      return { workflow: null, schemaRevision: null, schemaDigest: null };
    }
    const marker = parsed[0] as Record<string, unknown>;
    return {
      workflow: typeof marker.workflow === 'string' ? marker.workflow : null,
      schemaRevision: Number.isSafeInteger(marker.schemaRevision) ? Number(marker.schemaRevision) : null,
      schemaDigest: typeof marker.schemaDigest === 'string' ? marker.schemaDigest : null,
    };
  } catch {
    return { workflow: null, schemaRevision: null, schemaDigest: null };
  }
}

const MAX_LEGACY_WORKFLOW_RESULT_BYTES = 8 * 1024 * 1024;

async function projectWorkflowResult(
  ctx: RouteContext,
  row: LegacyOperationRow,
  raw: Record<string, unknown>,
  tenantId: string,
): Promise<LegacyOperationRow> {
  if (!row.workflow || row.state !== 'SUCCEEDED' || raw.result_ref === null || raw.result_ref === undefined) {
    return row;
  }
  const resultText = await (ctx.metadataReader ?? compatibilityMetadataReader(ctx.metadataCrypto)).readStoredText(
    raw.result_ref,
    { tenantId, slot: 'operations.result_ref', refId: row.id },
  );
  if (resultText === undefined || Buffer.byteLength(resultText, 'utf8') > MAX_LEGACY_WORKFLOW_RESULT_BYTES) {
    throw new Error('legacy workflow result is unavailable or exceeds its projection limit');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(resultText) as unknown;
  } catch {
    throw new Error('legacy workflow result is not valid JSON');
  }
  const parsed = LegacyWorkflowResultSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('legacy workflow result does not match its versioned contract');
  const result = parsed.data;
  const contentBytes = result.content === null ? 0 : Buffer.byteLength(result.content, 'utf8');
  if (contentBytes > MAX_LEGACY_WORKFLOW_RESULT_BYTES) {
    throw new Error('legacy workflow content exceeds its projection limit');
  }
  const extractedData = JSON.stringify(result.extractedData);
  const pipelineSteps = JSON.stringify(result.pipelineSteps);
  if (Buffer.byteLength(extractedData, 'utf8') + Buffer.byteLength(pipelineSteps, 'utf8') > MAX_LEGACY_WORKFLOW_RESULT_BYTES) {
    throw new Error('legacy workflow output exceeds its projection limit');
  }
  return {
    ...row,
    outputFormat: result.outputFormat,
    outputContent: result.content,
    extractedData,
    stepsResultJson: pipelineSteps,
    currentStep: result.pipelineSteps.length - 1,
    totalInputTokens: result.usage.inputTokens ?? row.totalInputTokens ?? null,
    totalOutputTokens: result.usage.outputTokens ?? row.totalOutputTokens ?? null,
    pagesProcessed: result.usage.pages ?? row.pagesProcessed ?? null,
    modelUsed: result.usage.model ?? row.modelUsed ?? null,
    totalCostUsd: result.usage.costUsd ?? row.totalCostUsd ?? null,
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
  apiKeyId: string,
): Promise<LegacyOperationRow | null> {
  const res = await ctx.db.query(
    `SELECT * FROM operations
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
        AND (pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3)`,
    [operationId, tenantId, apiKeyId],
  );
  if (!res.rowCount) return null;
  const raw = res.rows[0] as Record<string, unknown>;
  return projectWorkflowResult(ctx, toLegacyRow(raw), raw, tenantId);
}

/**
 * Output bytes for the download route, from either legacy backend.
 *
 * The row carries bytes inline (`output_content`) or behind a storage backend
 * (`output_file_path`). A file-backend reference is opened through the
 * platform's server-side blob reader — the same store the canonical download
 * route uses — and a reference that no longer resolves answers null, so the
 * mount keeps its documented 404 `no-output` instead of leaking a canonical
 * problem+json shape onto the legacy wire. (The legacy route distinguished a
 * broken file reference as 404 `file-not-found`; this host contract has one
 * absent-output signal, not two.)
 */
async function loadLegacyOutput(
  ctx: RouteContext,
  operationId: string,
  tenantId: string,
  apiKeyId: string,
): Promise<Buffer | null> {
  const row = await loadLegacyRow(ctx, operationId, tenantId, apiKeyId);
  if (row === null) return null;
  if (row.outputContent != null) return Buffer.from(row.outputContent, 'utf8');
  const filePath = row.outputFilePath;
  if (filePath == null || filePath.length === 0) return null;
  try {
    return await collectOutputBytes(await ctx.artifacts.getBlob(filePath));
  } catch {
    // Unreadable file-backend reference behaves like absent output; the
    // caller's 404 keeps the legacy problem+json shape either way.
    return null;
  }
}

/** Collect a blob reader into one buffer; the download wire is buffer-based. */
async function collectOutputBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

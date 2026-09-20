import { randomUUID } from 'node:crypto';
import {
  BusinessManifest,
  OperationView,
  SubmissionSchema,
  canonicalRequestHash,
  normalizeRouteAction,
} from '@du/contracts';
import { normalizeCorrelationId } from '@du/observability';
import { Db } from '../../db/db';
import { RegistryService } from '../registry/registry';
import { HttpError, badRequest, conflict, unprocessable } from '../../http/errors';
import Ajv from 'ajv';

/**
 * Submission + idempotency + admission (docs 06, P2-04, OPS-01..03).
 *
 * One transaction writes: operation, root task, idempotency key, and the
 * outbox dispatch row. The queue publish happens AFTER commit (dispatchOutbox)
 * so a crash between DB write and publish is recovered by the outbox sweeper —
 * never a lost or double job. Idempotency scope is
 * (tenantId, apiKeyId, routeAction, key); same key + same request hash replays
 * the original operation, same key + different hash is a 409.
 */

export interface SubmitContext {
  tenantId: string;
  apiKeyId: string;
  businessId: string;
  action: string;
  alias?: string;
  idempotencyKey?: string;
  correlationId?: string;
  submission: unknown;
  /** Seconds an idempotency record is retained (>= retry/replay window). */
  idempotencyTtlSeconds?: number;
}

export interface SubmitResult {
  operation: OperationView;
  replayed: boolean;
  correlationId: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });

export function createSubmissionService(db: Db, registry: RegistryService) {
  return {
    async submit(ctx: SubmitContext): Promise<SubmitResult> {
      const parsed = SubmissionSchema.safeParse(ctx.submission);
      if (!parsed.success) {
        throw unprocessable('INVALID_SCHEMA', 'submission validation failed', {
          errors: parsed.error.issues.slice(0, 50).map((i) => ({
            pointer: '/' + i.path.join('/'),
            message: i.message,
          })),
        });
      }
      const submission = parsed.data;
      const correlationId = normalizeCorrelationId(ctx.correlationId);
      const canonicalAction = ctx.alias ?? ctx.action;
      const routeAction = normalizeRouteAction(ctx.businessId, ctx.action, ctx.alias);

      // Resolve the registered+enabled version (profile pinning is P2-02; the
      // slice submits against the single enabled version per business/action).
      const enabled = await resolveEnabledVersion(db, ctx.businessId, canonicalAction);
      const { version, manifest, digest, queue } = enabled;

      // Validate input against the action's inputSchema (422 on mismatch).
      const actionDef = manifest.actions.find((a) => a.name === canonicalAction);
      if (!actionDef) {
        throw badRequest(`action ${canonicalAction} not declared by ${ctx.businessId}@${version}`);
      }
      const validate = ajv.compile(actionDef.inputSchema as object);
      if (!validate(submission.input)) {
        throw unprocessable('INVALID_SCHEMA', 'input failed action schema', {
          errors: (validate.errors ?? []).slice(0, 50).map((e) => ({
            pointer: e.instancePath || '/',
            message: e.message ?? 'invalid',
          })),
        });
      }

      const requestHash = canonicalRequestHash({
        input: submission.input,
        artifacts: submission.artifacts,
        output: submission.output,
        callback: submission.callback,
      });

      // Fast path: existing idempotency record for this scope+key.
      if (ctx.idempotencyKey) {
        const existing = await findSubmissionKey(
          db,
          ctx.tenantId,
          ctx.apiKeyId,
          routeAction,
          ctx.idempotencyKey
        );
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw conflict(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key reused with a different request body'
            );
          }
          const op = await loadOperationView(db, existing.operation_id);
          return { operation: op, replayed: true, correlationId };
        }
      }

      const operationId = randomUUID();
      const rootTaskId = randomUUID();
      const deliveryId = randomUUID();
      const ttlSeconds = ctx.idempotencyTtlSeconds ?? 24 * 3600;

      const created = await db.tx(async (client) => {
        // Re-check idempotency inside the tx to close the concurrent-submit race
        // (unique constraint is the ultimate authority; this avoids a duplicate
        // operation row before the constraint fires).
        if (ctx.idempotencyKey) {
          const dup = await client.query(
            `SELECT operation_id, request_hash FROM submission_keys
             WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 FOR UPDATE`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey]
          );
          if (dup.rowCount && dup.rowCount > 0) {
            const row = dup.rows[0] as { operation_id: string; request_hash: string };
            if (row.request_hash !== requestHash) {
              throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
            }
            return { operationId: row.operation_id, replayed: true };
          }
        }

        await client.query(
          `INSERT INTO operations
             (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version,
              root_task_id, input_ref, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,'ACCEPTED',1,$7,$8,$9)`,
          [
            operationId,
            ctx.tenantId,
            ctx.apiKeyId,
            ctx.businessId,
            version,
            canonicalAction,
            rootTaskId,
            JSON.stringify(submission.input),
            correlationId,
          ]
        );

        await client.query(
          `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, due_at)
           VALUES ($1,$2,'root',$3,$4,'READY',0, now())`,
          [rootTaskId, operationId, manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0], JSON.stringify(submission.input)]
        );

        if (ctx.idempotencyKey) {
          await client.query(
            `INSERT INTO submission_keys (tenant_id, api_key_id, route_action, key, request_hash, operation_id, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey, requestHash, operationId, String(ttlSeconds)]
          );
        }

        // Outbox dispatch row written in the SAME transaction as the state.
        await client.query(
          `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
           VALUES ($1,'task.dispatch',$2,$3)`,
          [
            rootTaskId,
            deliveryId,
            JSON.stringify({
              contractVersion: '1',
              deliveryId,
              taskId: rootTaskId,
              operationId,
              businessId: ctx.businessId,
              businessVersion: version,
              action: canonicalAction,
              kind: manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0],
              correlationId,
            }),
          ]
        );

        return { operationId, replayed: false };
      });

      const op = await loadOperationView(db, created.operationId);
      return { operation: op, replayed: created.replayed, correlationId };
    },
  };
}

async function resolveEnabledVersion(db: Db, businessId: string, action: string) {
  // Slice: pick the single ENABLED version for the business. Full profile
  // pinning (per-tenant/version selection) is P2-02.
  const res = await db.query(
    `SELECT version, manifest, digest, queue FROM business_versions
     WHERE business_id=$1 AND status='ENABLED'
     ORDER BY created_at DESC LIMIT 1`,
    [businessId]
  );
  if (!res.rowCount) {
    throw new HttpError(404, 'NOT_FOUND', `no enabled version for business ${businessId}`);
  }
  const row = res.rows[0] as { version: string; manifest: BusinessManifest; digest: string; queue: string };
  if (!row.manifest.actions.some((a) => a.name === action)) {
    throw badRequest(`action ${action} not offered by ${businessId}@${row.version}`);
  }
  return { version: row.version, manifest: row.manifest, digest: row.digest, queue: row.queue };
}

async function findSubmissionKey(
  db: Db,
  tenantId: string,
  apiKeyId: string,
  routeAction: string,
  key: string
): Promise<{ operation_id: string; request_hash: string } | null> {
  const res = await db.query(
    `SELECT operation_id, request_hash FROM submission_keys
     WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 AND expires_at > now()`,
    [tenantId, apiKeyId, routeAction, key]
  );
  return res.rowCount ? (res.rows[0] as { operation_id: string; request_hash: string }) : null;
}

export async function loadOperationView(db: Db, operationId: string): Promise<OperationView> {
  const res = await db.query(
    `SELECT id, tenant_id, business_id, business_version, action, state, state_version,
            created_at, updated_at, deadline_at, result_ref
     FROM operations WHERE id=$1`,
    [operationId]
  );
  if (!res.rowCount) {
    throw new HttpError(404, 'NOT_FOUND', `operation ${operationId} not found`);
  }
  const r = res.rows[0] as Record<string, unknown>;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    businessId: r.business_id as string,
    businessVersion: r.business_version as string,
    action: r.action as string,
    state: r.state as OperationView['state'],
    stateVersion: r.state_version as number,
    createdAt: new Date((r.created_at as string) ?? new Date().toISOString()).toISOString(),
    updatedAt: new Date((r.updated_at as string) ?? new Date().toISOString()).toISOString(),
    deadlineAt: r.deadline_at ? new Date(r.deadline_at as string).toISOString() : null,
    progress: { percent: 0, message: r.state as string },
    links: {
      self: `/api/v1/operations/${String(r.id)}`,
      result: `/api/v1/operations/${String(r.id)}/result`,
    },
  };
}

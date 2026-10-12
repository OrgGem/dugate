import { z } from 'zod';
const CountsSchema=z.record(z.number().int().nonnegative());
const EvidenceSchema=z.object({
  evidenceKind:z.enum(['inventory','reconciliation','backup','restore','runtime_probe','cutover_probe']),
  evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),recordedAt:z.string().datetime({offset:true}),status:z.string().regex(/^[A-Z_]{1,96}$/).nullable(),
  scope:z.enum(['synthetic','customer-authorized']).nullable(),
}).strict();
const ReadinessSchema=z.object({tenantId:z.string().uuid(),runs:z.array(z.object({
  sourceVersion:z.string(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),planSha256:z.string().regex(/^[a-f0-9]{64}$/),importedAt:z.string().datetime({offset:true}),
  sourceCounts:CountsSchema,destinationCounts:CountsSchema,
  latestInventory:z.object({
    recordedAt:z.string().datetime({offset:true}),inventorySha256:z.string().regex(/^[a-f0-9]{64}$/),targetCounts:CountsSchema,issueCounts:CountsSchema,
    totalIssues:z.number().int().nonnegative(),verifiedBlobCount:z.number().int().nonnegative(),failedBlobCount:z.number().int().nonnegative(),
    capabilities:z.record(z.unknown()),capabilityReady:z.boolean(),continuityEvidence:z.object({isolatedRestore:z.enum(['VERIFIED','PENDING']),sourceOffRuntimeProbe:z.enum(['VERIFIED','PENDING']),isolatedCutoverProbe:z.enum(['VERIFIED','PENDING']),rehearsalReady:z.boolean()}).strict(),
    customerEvidence:z.object({sourceFreeze:z.enum(['VERIFIED','PENDING_CUSTOMER_INPUT']),sourceTimezone:z.enum(['VERIFIED','PENDING_CUSTOMER_INPUT']),cutoverAuthorization:z.enum(['APPROVED','PENDING_CUSTOMER_INPUT']),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),productionCutover:z.literal('NOT_PERFORMED')}).strict(),
    unresolvedRequiredResetUsers:z.number().int().nonnegative(),stale:z.boolean(),staleObservedAt:z.string().datetime({offset:true}).nullable(),evidence:z.array(EvidenceSchema),externalGates:z.array(z.string()),
  }).nullable(),
  status:z.enum(['INVENTORY_REQUIRED','INVENTORY_STALE','RECONCILIATION_REQUIRED','IDENTITY_RESET_REQUIRED','SYNTHETIC_REHEARSAL_REQUIRED','CUSTOMER_EVIDENCE_PENDING','CUTOVER_READY']),
  capabilityReady:z.boolean(),rehearsalReady:z.boolean(),cutoverReady:z.boolean(),
}))});
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@du/observability';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import {
  boundedMessage,
  callUpstream,
  credentialFor,
  rbacPrincipal,
  relayUpstream,
  writeJson,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'admin-bff' } });

export type MigrationReadinessRoute = { kind: 'readiness' } | { kind: 'invalid' };

export function matchMigrationReadinessRoute(relative: string): MigrationReadinessRoute | null {
  if (relative === '/legacy-migration/readiness') return { kind: 'readiness' };
  return null;
}

export async function handleMigrationReadinessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: MigrationReadinessRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no migration readiness route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if(method !== 'GET') {writeProblem(res,405,'METHOD_NOT_ALLOWED','readiness accepts GET only',correlationId);return;}
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }

  // Tenant scope: the operator is pinned to its stored tenant; platform may
  // pass (or omit) any tenantId. A caller cannot widen its own scope here.
  let scope: string;
  try {
    scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId') ?? '');
  } catch (err) {
    if (isHttpError(err)) {
      writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
      return;
    }
    throw err;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL('/api/v1/admin/legacy-migration/readiness', runtime.jsonBaseUrl);
  if (scope !== '') upstream.searchParams.set('tenantId', scope);


  // 4xx keeps status+code; 5xx collapses to 502 UPSTREAM_ERROR via
  // relayUpstream → upstreamProblem.
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  if (!response.ok) {
    await relayUpstream(res, response, correlationId);
    return;
  }

  // Narrow the read model; archive/configuration values never cross this boundary.
  const raw = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const narrowed = parsed === null ? null : ReadinessSchema.safeParse(parsed);
  if (narrowed === null || !narrowed.success) {
    logger.warn('[admin-bff] settings read did not match the settings DTO', {
      correlationId,
      status: response.status,
    });
    writeProblem(res, 502, 'UPSTREAM_ERROR', 'the admin API returned an unreadable migration readiness view', correlationId);
    return;
  }
  writeJson(res, response.status, narrowed.data, correlationId);
}

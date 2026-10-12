import type { Db } from '../../db/db';
import { HttpError, forbidden, conflict, notFound } from '../../http/errors';
import type { RouteContext } from '../../http/route-context';
import type { AdminActionAuth, AdminPrincipal } from '../admin-actions/rbac';
import { requireResourceTenant } from '../admin-actions/rbac';
import { AdminWorkbenchEndpointTestRequestSchema, AdminWorkbenchPromptWizardRequestSchema, type AdminWorkbenchEndpointTestRequest } from '@du/contracts';

export const PROFILE_TEST_ENDPOINT_ACTIONS = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'] as const;

export function adminWorkbenchPrincipal(auth: AdminActionAuth): AdminPrincipal {
  if (auth.kind === 'bearer') return auth.principal;
  if (auth.role === 'admin') return { role: 'platform' };
  if (auth.role === 'operator' && auth.tenantId) return { role: 'tenant_operator', tenantId: auth.tenantId };
  throw new HttpError(403, 'PERMISSION_DENIED', 'viewer sessions cannot run Admin workbench operations');
}

export function adminWorkbenchActor(auth: AdminActionAuth): { actor: string; actorIssuer?: string; actorSub?: string; actorRole?: string } {
  if (auth.kind === 'bearer') return { actor: 'admin', actorRole: auth.principal.role };
  return {
    actor: `shell:${auth.role}`,
    actorRole: auth.role,
    ...(auth.issuer ? { actorIssuer: auth.issuer } : {}),
    ...(auth.principalId ? { actorSub: auth.principalId } : {}),
  };
}

export interface TrustedLocalAdminWorkbenchActor {
  tenantId: string;
  userId: string;
  roleVersion: number;
}

export interface AdminWorkbenchIdentityScope {
  getLocalUserOperationScope(input: { tenantId: string; userId: string; roleVersion: number }): Promise<{
    tenantId: string;
    userId: string;
    roleVersion: number;
    profileIds: string[];
    apiKeyIds: string[];
  } | null>;
}

export interface AdminWorkbenchAdmissionTarget {
  tenantId: string;
  apiKeyId: string;
  profileId: string;
}

/** Resolve local USER identity only from the trusted opaque-session auth. */
export function trustedLocalAdminWorkbenchActor(auth: AdminActionAuth): TrustedLocalAdminWorkbenchActor | null {
  if (auth.kind !== 'cookie' || auth.issuer !== 'du-local' || auth.role !== 'operator') return null;
  const roleVersion = (auth as typeof auth & { roleVersion?: unknown }).roleVersion;
  if (!auth.tenantId || !/^[0-9a-f-]{36}$/i.test(auth.tenantId)
      || !auth.principalId || !/^[0-9a-f-]{36}$/i.test(auth.principalId)
      || typeof roleVersion !== 'number' || !Number.isSafeInteger(roleVersion) || roleVersion < 1) {
    throw forbidden('local USER session is stale or lacks its verified version');
  }
  return { tenantId: auth.tenantId, userId: auth.principalId, roleVersion };
}

/**
 * Current local USER invocation fence shared with workflow/Provider Test and
 * operation-result owners. The profile preflight binds apiKeyId to profileId;
 * this helper independently proves the user has both explicit live grants.
 */
export async function assertAdminWorkbenchAdmissionScope(
  identity: AdminWorkbenchIdentityScope | undefined,
  auth: AdminActionAuth,
  target: AdminWorkbenchAdmissionTarget,
): Promise<void> {
  const actor = trustedLocalAdminWorkbenchActor(auth);
  if (actor === null) return;
  if (actor.tenantId !== target.tenantId) throw notFound('not found');
  if (!identity) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'local assignment validation is unavailable');
  const scope = await identity.getLocalUserOperationScope(actor);
  if (!scope || scope.tenantId !== target.tenantId || scope.userId !== actor.userId
      || scope.roleVersion !== actor.roleVersion
      || !scope.apiKeyIds.includes(target.apiKeyId)
      || !scope.profileIds.includes(target.profileId)) {
    throw forbidden('local USER must have current assignments to the selected active API key and Profile');
  }
}

function assertCallerTenant(principal: AdminPrincipal, tenantId: string): void {
  requireResourceTenant(principal, tenantId);
}

function assertNoDuplicateArtifacts(artifacts: readonly { artifactId: string }[]): void {
  if (new Set(artifacts.map((item) => item.artifactId)).size !== artifacts.length) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'artifact references must be unique');
  }
}

async function readReadyArtifacts(db: Db, tenantId: string, apiKeyId: string, artifactIds: readonly string[]): Promise<Map<string, string>> {
  if (artifactIds.length === 0) return new Map();
  const result = await db.query<{ id: string; file_name: string | null }>(
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
      )`,
    [artifactIds, tenantId, apiKeyId],
  );
  const byId = new Map(result.rows.filter((row) => typeof row.file_name === 'string').map((row) => [row.id, row.file_name!]));
  if (artifactIds.some((id) => !byId.has(id))) throw notFound('ready named artifact not found for the selected API key');
  return byId;
}

async function verifyActiveKey(db: Db, tenantId: string, apiKeyId: string): Promise<void> {
  const key = await db.query('SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status=\'ACTIVE\'', [apiKeyId, tenantId]);
  if (!key.rowCount) throw notFound('active API key not found in tenant');
}

async function verifyBusinessVersion(ctx: RouteContext, businessVersion: string, action: string): Promise<void> {
  const active = await ctx.db.query<{ version: string; manifest: { actions: Array<{ name: string }> } }>(
    'SELECT version,manifest FROM business_versions WHERE business_id=$1 AND is_active=true LIMIT 1', ['document-core'],
  );
  if (!active.rowCount) throw notFound('document-core has no active business version');
  const row = active.rows[0]!;
  if (row.version !== businessVersion) throw conflict('PROFILE_CHANGED', 'active document-core version changed; reload the workbench');
  if (!row.manifest.actions.some((item) => item.name === action)) throw new HttpError(422, 'INVALID_SCHEMA', 'the selected document-core action is unavailable');
}

async function preflightProfile(ctx: RouteContext, p: Pick<AdminWorkbenchEndpointTestRequest, 'tenantId' | 'apiKeyId' | 'businessVersion' | 'profileName' | 'expectedProfileRevision'>, action: string, input: Record<string, unknown>, fileNames: readonly string[]) {
  await verifyActiveKey(ctx.db, p.tenantId, p.apiKeyId);
  await verifyBusinessVersion(ctx, p.businessVersion, action);
  const profile = await ctx.submission.preflightLegacyWorkflow({
    tenantId: p.tenantId,
    apiKeyId: p.apiKeyId,
    businessId: 'document-core',
    action,
    input,
    fileNames,
  });
  if (profile.mode !== 'pinned' || profile.profileName !== p.profileName) {
    throw forbidden('the selected API key is not assigned to this active Profile for the action');
  }
  if (profile.revision !== p.expectedProfileRevision) throw conflict('PROFILE_CHANGED', 'Profile revision changed; reload before testing');
  if (!profile.policy.enabled) throw forbidden('the selected Profile is disabled');
  return profile;
}

export async function submitProfileEndpointTest(ctx: RouteContext, auth: AdminActionAuth, input: unknown, idempotencyKey: string | undefined) {
  const parsed = AdminWorkbenchEndpointTestRequestSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Test Endpoint needs a tenant, active key, Profile, action and valid parameters');
  if (!idempotencyKey) throw new HttpError(422, 'INVALID_SCHEMA', 'Test Endpoint requires an Idempotency-Key');
  const p = parsed.data;
  const principal = adminWorkbenchPrincipal(auth);
  assertCallerTenant(principal, p.tenantId);
  assertNoDuplicateArtifacts(p.artifacts);
  const artifactIds = p.artifacts.map((artifact) => artifact.artifactId);
  const names = await readReadyArtifacts(ctx.db, p.tenantId, p.apiKeyId, artifactIds);
  const actionInput = {
    ...p.parameters,
    ...(artifactIds.length ? { artifactIds } : {}),
  };
  const profile = await preflightProfile(ctx, p, p.action, actionInput, artifactIds.map((id) => names.get(id)!));
  await assertAdminWorkbenchAdmissionScope(ctx.identity, auth, { tenantId: p.tenantId, apiKeyId: p.apiKeyId, profileId: profile.profileId });
  const result = await ctx.submission.submit({
    tenantId: p.tenantId,
    apiKeyId: p.apiKeyId,
    businessId: p.businessId,
    action: p.action,
    correlationId: ctx.correlationId,
    idempotencyKey,
    legacyExpectedProfile: { profileId: profile.profileId, revision: profile.revision },
    submission: {
      input: actionInput,
      output: {},
      ...(p.artifacts.length ? { artifacts: p.artifacts } : {}),
      ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
    },
  });
  const actor = adminWorkbenchActor(auth);
  await ctx.audit.record({ tenantId: p.tenantId, ...actor, action: 'admin-workbench.test-endpoint', resource: `operation:${result.operation.id}`, severity: 'info', correlationId: ctx.correlationId });
  return { operationId: result.operation.id, operation: result.operation, replayed: result.replayed };
}

function promptWizardInput(currentPrompt: string, problem: string, metadata: Record<string, string>): Record<string, unknown> {
  const context = Object.entries(metadata).filter(([, value]) => value.trim() !== '').map(([key, value]) => `${key}: ${value}`).join('\n');
  const content = [
    'Improve the current system prompt for a document-processing AI workflow.',
    'Return only the revised prompt. Preserve every template placeholder exactly, including {{...}} values.',
    'Keep the same task and intended output contract.',
    problem.trim() ? `Problem to address:\n${problem.trim()}` : 'No specific problem was supplied; improve clarity, constraints, and output format.',
    context ? `Context:\n${context}` : '',
    `Current prompt:\n<prompt>\n${currentPrompt}\n</prompt>`,
  ].filter(Boolean).join('\n\n');
  return {
    task: 'report',
    text: content,
    tone: 'business',
    audience: 'Return only the complete revised system prompt, with no explanation.',
    maxWords: 4000,
  };
}

export async function submitPromptWizard(ctx: RouteContext, auth: AdminActionAuth, input: unknown, idempotencyKey: string | undefined) {
  const parsed = AdminWorkbenchPromptWizardRequestSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Prompt Wizard request is invalid or exceeds its configured bounds');
  if (!idempotencyKey) throw new HttpError(422, 'INVALID_SCHEMA', 'Prompt Wizard requires an Idempotency-Key');
  const p = parsed.data;
  const principal = adminWorkbenchPrincipal(auth);
  assertCallerTenant(principal, p.tenantId);
  if (!ctx.connectorManagement) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector management is unavailable; Prompt Wizard stays disabled');
  if (p.wizardConnectorId !== 'ext-prompt-wizard') throw new HttpError(422, 'INVALID_SCHEMA', 'Prompt Wizard requires the configured ext-prompt-wizard Connector');
  const wizardConnector = await ctx.connectorManagement.getRevision(p.wizardConnectorId, p.wizardConnectorRevision);
  if (!wizardConnector || wizardConnector.state !== 'ACTIVE' || (wizardConnector.tenantId !== undefined && wizardConnector.tenantId !== p.tenantId)) {
    throw notFound('active tenant-authorized Prompt Wizard Connector revision not found');
  }

  const actionInput = promptWizardInput(p.currentPrompt, p.problem, {
    endpointName: p.endpointName,
    endpointSlug: p.endpointSlug,
    connectorName: p.connectorName,
    connectorSlug: p.connectorSlug,
    stepId: p.stepId,
  });
  const profile = await preflightProfile(ctx, p, 'generate', actionInput, []);
  await assertAdminWorkbenchAdmissionScope(ctx.identity, auth, { tenantId: p.tenantId, apiKeyId: p.apiKeyId, profileId: profile.profileId });
  const reasoning = profile.bindings.reasoning;
  if (!reasoning || reasoning.connectorId !== p.wizardConnectorId || reasoning.revision !== p.wizardConnectorRevision) {
    throw forbidden('the selected Profile must pin the active ext-prompt-wizard revision in its reasoning slot');
  }

  const result = await ctx.submission.submit({
    tenantId: p.tenantId,
    apiKeyId: p.apiKeyId,
    businessId: 'document-core',
    action: 'generate',
    correlationId: ctx.correlationId,
    idempotencyKey,
    legacyExpectedProfile: { profileId: profile.profileId, revision: profile.revision },
    submission: { input: actionInput, output: {} },
  });
  const actor = adminWorkbenchActor(auth);
  await ctx.audit.record({ tenantId: p.tenantId, ...actor, action: 'admin-workbench.prompt-wizard', resource: `operation:${result.operation.id}`, severity: 'info', correlationId: ctx.correlationId });
  return { operationId: result.operation.id, operation: result.operation, replayed: result.replayed };
}

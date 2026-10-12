import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { RouteContext } from '../../http/route-context';
import { HttpError } from '../../http/errors';

import { CORE_ENDPOINTS } from './endpoints';
import { SettingsConfigurationSchema, readSettingsConfiguration, createSettingsRevision, validateSettingsRevision, applySettingsRevision, type SettingsRevisionDeps } from './revisions';
import { openPrompt, sealPrompt } from './prompt-crypto';
export const PROMPT_BINDINGS_QUERY = `SELECT p.connector_bindings,p.enabled FROM profile_active_revisions a
    JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
    JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.api_key_id=$1 AND m.state='ACTIVE' AND m.tenant_id=p.tenant_id
    JOIN business_versions b ON b.business_id=p.business_id AND b.version=p.business_version AND b.is_active=true
    WHERE p.tenant_id=$2 AND p.business_id='document-core' AND p.action=$3 AND (p.endpoint_slug IS NULL OR p.endpoint_slug=$4)
    ORDER BY (p.endpoint_slug IS NOT NULL) DESC,a.moved_at DESC,p.profile_id LIMIT 1`;

// A deliberately bounded read model: unknown runtime fields/credentials are stripped by the BFF.
export const EffectiveSettingsSchema = z.object({
  storage: z.object({ backend: z.enum(['postgres', 's3']), bucket: z.string().nullable(), region: z.string().nullable(), endpoint: z.string().nullable(), managedBy: z.literal('deployment'), restartRequired: z.literal(true) }),
  capabilities: z.object({ metadataEncryptionConfigured: z.boolean(), connectorManagementConfigured: z.boolean(), credentialManagementConfigured: z.boolean(), promptOverridesEditable: z.boolean(), configurationEditable: z.boolean().default(false) }),
  configuration: SettingsConfigurationSchema.optional(),
  availableConnections: z.array(z.object({ slot: z.string(), connectionId: z.string(), revision: z.number() })).default([]),
  promptOverrides: z.array(z.object({ connectionId: z.string(), apiKeyId: z.string(), endpointSlug: z.string(), stepId: z.string(), promptOverride: z.string().nullable(), updatedAt: z.string() })),
  scope: z.object({ tenantId: z.string().nullable(), apiKeyId: z.string().nullable(), endpointSlug: z.string().nullable() }),
});
export const PromptSettingSchema = z.object({
  tenantId: z.string().uuid(), apiKeyId: z.string().uuid(), connectionId: z.string().uuid(),
  endpointSlug: z.string().min(1).max(128), stepId: z.literal('_default'),
  promptOverride: z.string().max(32768).nullable(), expectedUpdatedAt: z.string().datetime().nullable(),
}).strict();

export async function readEffectiveSettings(ctx: RouteContext, tenantId: string | null) {
  const apiKeyId = ctx.searchParams.get('apiKeyId');
  const endpointSlug = ctx.searchParams.get('endpointSlug');
  if (apiKeyId && !z.string().uuid().safeParse(apiKeyId).success) throw new HttpError(422, 'INVALID_SCHEMA', 'apiKeyId must be a UUID');
  if ((apiKeyId || endpointSlug) && (!tenantId || !apiKeyId || !endpointSlug)) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId, apiKeyId and endpointSlug are required together');
  const rows = apiKeyId ? await ctx.db.query(`SELECT p.connection_id AS "connectionId", p.api_key_id AS "apiKeyId", p.endpoint_slug AS "endpointSlug", p.step_id AS "stepId", p.prompt_override AS "promptOverride", p.updated_at AS "updatedAt" FROM connector_prompt_overrides p JOIN api_keys k ON k.id=p.api_key_id AND k.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.api_key_id=$2 AND p.endpoint_slug=$3 ORDER BY p.connection_id,p.step_id`, [tenantId, apiKeyId, endpointSlug]) : { rows: [] };
  const action = endpointSlug?.startsWith('workflows:schema:') ? 'schema-workflow' : endpointSlug?.split(':')[0];
  const target = apiKeyId ? await ctx.db.query(PROMPT_BINDINGS_QUERY, [apiKeyId,tenantId,action,endpointSlug]) : { rows: [] };
  const bindings = (target.rows[0]?.enabled === false ? {} : target.rows[0]?.connector_bindings ?? {}) as Record<string, { connectorId: string; revision: number }>;
  const storage = ctx.config.artifactStorage;
  // Strip URL userinfo/query/fragment even when deployment accidentally put credentials there.
  let endpoint: string | null = null;
  if (storage?.backend === 's3' && storage.endpoint) {
    try { const url = new URL(storage.endpoint); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; endpoint = url.toString(); } catch { endpoint = null; }
  }
  const requestedRevision = ctx.searchParams.get('revision');
  if (requestedRevision !== null && !/^\d+$/.test(requestedRevision)) throw new HttpError(422, 'INVALID_SCHEMA', 'revision must be a nonnegative integer');
  const configuration = apiKeyId && tenantId && endpointSlug && target.rows.length ? await readSettingsConfiguration(ctx.db, {tenantId,apiKeyId,endpointSlug}, ctx, requestedRevision === null ? undefined : Number(requestedRevision)) : undefined;
  const promptOverrides = await Promise.all(rows.rows.map(async row => ({...row, promptOverride: await openPrompt(row.promptOverride, {tenantId: tenantId!, apiKeyId: row.apiKeyId, connectionId: row.connectionId, endpointSlug: row.endpointSlug, stepId: row.stepId}, ctx.metadataCrypto, ctx.metadataReader), updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt})));
  return EffectiveSettingsSchema.parse({
    configuration,
    storage: { backend: storage?.backend ?? 'postgres', bucket: storage?.backend === 's3' ? storage.bucket : null, region: storage?.backend === 's3' ? storage.region ?? null : null, endpoint, managedBy: 'deployment', restartRequired: true },
    capabilities: { metadataEncryptionConfigured: !!ctx.metadataCrypto, connectorManagementConfigured: !!ctx.connectorManagement, credentialManagementConfigured: !!ctx.credentialWorkflow, promptOverridesEditable: !!ctx.metadataCrypto, configurationEditable: !!ctx.metadataCrypto },
    availableConnections: Object.entries(bindings).map(([slot, binding]) => ({ slot, connectionId: binding.connectorId, revision: binding.revision })),
    promptOverrides,
    scope: { tenantId, apiKeyId, endpointSlug },
  });
}

export async function updatePromptSetting(client: PoolClient, input: unknown, deps: SettingsRevisionDeps = {}) {
  const parsed = PromptSettingSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'invalid prompt settings');
  const p = parsed.data;
  if (!CORE_ENDPOINTS.has(p.endpointSlug)) throw new HttpError(422, 'INVALID_SCHEMA', 'this editor supports the six core document API endpoint slugs; workflow prompts use workflow/profile revisions');
  if(deps.metadataCrypto) {
    await client.query('INSERT INTO settings_streams(id,tenant_id,api_key_id,endpoint_slug) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,api_key_id,endpoint_slug) DO NOTHING',[randomUUID(),p.tenantId,p.apiKeyId,p.endpointSlug]);
    await client.query('SELECT id FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3 FOR UPDATE',[p.tenantId,p.apiKeyId,p.endpointSlug]);
  }
  const key = await client.query('SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status=\'ACTIVE\' FOR UPDATE', [p.apiKeyId, p.tenantId]);
  if (!key.rowCount) throw new HttpError(404, 'NOT_FOUND', 'active API key not found in tenant');
  const action = p.endpointSlug.startsWith('workflows:schema:') ? 'schema-workflow' : p.endpointSlug.split(':')[0]!;
  const target = await client.query(PROMPT_BINDINGS_QUERY, [p.apiKeyId,p.tenantId,action,p.endpointSlug]);
  const bindings = target.rows[0]?.connector_bindings as Record<string, { connectorId?: string }> | undefined;
  if (target.rows[0]?.enabled === false || !bindings || !Object.values(bindings).some(binding => binding.connectorId === p.connectionId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'connection is not pinned by the active profile for this key and endpoint; configure the profile mapping first');
  }
  const prior = await client.query('SELECT updated_at FROM connector_prompt_overrides WHERE tenant_id=$1 AND connection_id=$2 AND api_key_id=$3 AND endpoint_slug=$4 AND step_id=$5 FOR UPDATE', [p.tenantId, p.connectionId, p.apiKeyId, p.endpointSlug, p.stepId]);
  const current = prior.rows[0]?.updated_at;
  if ((current ? new Date(current).toISOString() : null) !== p.expectedUpdatedAt) throw new HttpError(409, 'STATE_CONFLICT', 'prompt setting changed; reload before saving');
  if (deps.metadataCrypto) {
    const scope = {tenantId:p.tenantId,apiKeyId:p.apiKeyId,endpointSlug:p.endpointSlug};
    const heads = await client.query('SELECT active_revision FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3', [p.tenantId,p.apiKeyId,p.endpointSlug]);
    const expectedActiveRevision = heads.rows[0]?.active_revision ?? null;
    const draft = await createSettingsRevision(client,{...scope,expectedActiveRevision,changes:{prompts:[{connectionId:p.connectionId,stepId:p.stepId,promptOverride:p.promptOverride}]}},deps);
    const report = await validateSettingsRevision(client,{...scope,revision:draft.revision},deps);
    if(!report.valid) throw new HttpError(409,'STATE_CONFLICT',report.issues.map(i=>i.message).join(' '));
    const applied = await applySettingsRevision(client,{...scope,revision:draft.revision,expectedActiveRevision},deps);
    const saved = await client.query('SELECT updated_at FROM connector_prompt_overrides WHERE tenant_id=$1 AND connection_id=$2 AND api_key_id=$3 AND endpoint_slug=$4 AND step_id=$5', [p.tenantId,p.connectionId,p.apiKeyId,p.endpointSlug,p.stepId]);
    return {...applied,updatedAt:new Date(saved.rows[0]!.updated_at).toISOString()};
  }
  const result = await client.query(`INSERT INTO connector_prompt_overrides (tenant_id,connection_id,api_key_id,endpoint_slug,step_id,prompt_override,is_active) VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (connection_id,api_key_id,endpoint_slug,step_id) DO UPDATE SET prompt_override=EXCLUDED.prompt_override,updated_at=clock_timestamp(),is_active=true WHERE connector_prompt_overrides.tenant_id=EXCLUDED.tenant_id RETURNING updated_at`, [p.tenantId,p.connectionId,p.apiKeyId,p.endpointSlug,p.stepId,await sealPrompt(p.promptOverride?.trim() || null,p,deps.metadataCrypto)]);
  if (!result.rowCount) throw new HttpError(409, 'STATE_CONFLICT', 'prompt setting scope conflict');
  return { updatedAt: new Date(result.rows[0]!.updated_at).toISOString(), appliesTo: 'new submissions only' };
}

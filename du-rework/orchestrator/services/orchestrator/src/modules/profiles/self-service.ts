import Ajv from 'ajv';
import type { PoolClient } from 'pg';
import {
  ProfileSelfServiceAssignedEndpointSchema,
  ProfileSelfServiceAssignedQuerySchema,
  ProfileSelfServiceAssignedPageSchema,
  ProfileSelfServiceAssignedApiKeyQuerySchema,
  ProfileSelfServiceAssignedApiKeyPageSchema,
  ProfileSelfServiceEditRequestSchema,
  ProfileSelfServiceEditResponseSchema,
  findSecretParameterKeys,
  type ProfileSelfServiceAssignedPage,
  type ProfileSelfServiceAssignedQuery,
  type ProfileSelfServiceAssignedApiKeyPage,
  type ProfileSelfServiceAssignedApiKeyQuery,
  type ProfileSelfServiceEditRequest,
  type ProfileSelfServiceEditResponse,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { conflict, forbidden, HttpError, notFound } from '../../http/errors';
import type { AuditService } from '../audit/audit';
import { canonicalPayloadHash, executeIdempotent } from '../idempotency/idempotency';
import type { RegistryService } from '../registry/registry';
import type { ProfileService } from './profiles';
import { parseConnectorBindings } from './profiles';
import { coerceConnectionsOverride, coerceRowParameters, parseWriteParameters } from './policy';

export interface ProfileSelfServiceActor {
  /** Trusted identity from a live local session; never read from command JSON. */
  tenantId: string;
  issuer: string;
  userId: string;
  roleVersion: number;
}

export interface ProfileSelfServiceDependencies {
  db: Db;
  profiles: ProfileService;
  registry: RegistryService;
  audit: AuditService;
  identity: {
    isLocalUserAssignedProfile(input: { tenantId: string; userId: string; profileId: string }): Promise<boolean>;
  };
}

export interface ProfileSelfService {
  listAssignedProfileEndpoints(rawQuery: unknown, actor: ProfileSelfServiceActor): Promise<ProfileSelfServiceAssignedPage>;
  listAssignedProfileApiKeys(profileId: string, rawQuery: unknown, actor: ProfileSelfServiceActor): Promise<ProfileSelfServiceAssignedApiKeyPage>;
  editAssignedProfile(rawInput: unknown, actor: ProfileSelfServiceActor, idempotencyKey: string, correlationId: string): Promise<ProfileSelfServiceEditResponse>;
  canReadAssignedProfileGroup?(input: { profileIds: readonly string[]; apiKeyId: string }, actor: ProfileSelfServiceActor): Promise<boolean>;
}

interface ActiveProfileRow {
  user_version: number;
  profile_id: string;
  active_revision: number;
  api_key_id: string;
  api_key_hash: string;
  business_id: string;
  business_version: string;
  action: string;
  endpoint_slug: string | null;
  connector_bindings: unknown;
  enabled: boolean;
  parameters: unknown;
  job_priority: string | null;
  allowed_file_extensions: string | null;
  connections_override: unknown;
  group_id: string | null;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const IDEMPOTENCY_ROUTE = 'PATCH /admin/api/profiles/:businessId/:businessVersion/:profileName/self-service';
const MAX_CONNECTION_STEPS = 32;
const SESSION_SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

interface AssignedProfileRow {
  profile_id: string;
  tenant_id: string;
  business_id: string;
  business_version: string;
  profile_name: string;
  action: string;
  endpoint_slug: string | null;
  revision: number;
  connector_bindings: unknown;
  parameters: unknown;
  connections_override: unknown;
}

interface AssignedCursor {
  businessId: string;
  businessVersion: string;
  profileName: string;
  profileId: string;
}

interface AssignedApiKeyRow {
  api_key_id: string;
  name: string | null;
  prefix: string;
}

function parseAssignedCursor(raw: string | undefined): AssignedCursor | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<AssignedCursor>;
    if (typeof parsed.businessId !== 'string' || parsed.businessId.length > 128
        || typeof parsed.businessVersion !== 'string' || parsed.businessVersion.length > 128
        || typeof parsed.profileName !== 'string' || parsed.profileName.length > 128
        || typeof parsed.profileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.profileId)) throw new Error('invalid cursor');
    return { businessId: parsed.businessId, businessVersion: parsed.businessVersion, profileName: parsed.profileName, profileId: parsed.profileId };
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', 'assigned Profile cursor is invalid');
  }
}

function assignedCursor(row: AssignedProfileRow): string {
  return Buffer.from(JSON.stringify({
    businessId: row.business_id,
    businessVersion: row.business_version,
    profileName: row.profile_name,
    profileId: row.profile_id,
  } satisfies AssignedCursor)).toString('base64url');
}

function parseAssignedApiKeyCursor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { apiKeyId?: unknown };
    if (typeof parsed.apiKeyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.apiKeyId)) throw new Error('invalid cursor');
    return parsed.apiKeyId;
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', 'assigned API key cursor is invalid');
  }
}

function assignedApiKeyCursor(row: AssignedApiKeyRow): string {
  return Buffer.from(JSON.stringify({ apiKeyId: row.api_key_id })).toString('base64url');
}

function safeParameters(
  raw: unknown,
  inputSchema: Record<string, unknown>,
  action: string,
  endpointSlug: string | null,
): Record<string, { value: unknown; isLocked?: boolean }> {
  const properties = schemaProperties(inputSchema);
  const current = coerceRowParameters(raw);
  const output: Record<string, { value: unknown; isLocked?: boolean }> = Object.create(null) as Record<string, { value: unknown; isLocked?: boolean }>;
  for (const [key, entry] of Object.entries(current)) {
    const schemaKey = toActionParameterName(key, action, endpointSlug);
    if (!Object.hasOwn(properties, schemaKey) || findSecretParameterKeys({ [key]: entry }).length > 0) continue;
    output[key] = { value: entry.value, ...(entry.isLocked === undefined ? {} : { isLocked: entry.isLocked }) };
  }
  return output;
}

function safeInputSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = schemaProperties(inputSchema);
  const safeProperties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, rawProperty] of Object.entries(properties)) {
    if (findSecretParameterKeys({ [key]: true }).length > 0) continue;
    if (!isRecord(rawProperty)) {
      safeProperties[key] = rawProperty;
      continue;
    }
    const nested = schemaProperties(rawProperty);
    safeProperties[key] = Object.keys(nested).length > 0
      ? { ...rawProperty, properties: safeInputSchema(rawProperty).properties }
      : rawProperty;
  }
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((key): key is string => typeof key === 'string' && Object.hasOwn(safeProperties, key))
    : inputSchema.required;
  return { ...inputSchema, ...(Object.keys(properties).length > 0 ? { properties: safeProperties } : {}), ...(required === undefined ? {} : { required }) };
}

async function assertCurrentLocalActor(deps: ProfileSelfServiceDependencies, actor: ProfileSelfServiceActor): Promise<void> {
  requireTrustedActor(actor);
  const live = await deps.db.query<{ version: number }>(
    `SELECT version FROM admin_local_users WHERE id=$1 AND tenant_id=$2 AND role='operator'
      AND is_enabled=true AND is_locked=false`, [actor.userId, actor.tenantId],
  );
  if (!live.rowCount || Number(live.rows[0]?.version) !== actor.roleVersion) {
    throw conflict('IDENTITY_VERSION_CONFLICT', 'local identity changed; sign in again before continuing');
  }
}

function requireTrustedActor(actor: ProfileSelfServiceActor): void {
  if (!actor || typeof actor !== 'object'
      || typeof actor.tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(actor.tenantId)
      || typeof actor.userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(actor.userId)
      || typeof actor.issuer !== 'string' || actor.issuer.trim().length === 0 || actor.issuer.length > 512
      || !Number.isSafeInteger(actor.roleVersion) || actor.roleVersion < 1) {
    throw forbidden('local USER identity is unavailable or stale');
  }
}

function schemaProperties(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) return {};
  const properties = (inputSchema as { properties?: unknown }).properties;
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toActionParameterName(key: string, action: string, endpointSlug: string | null): string {
  if (endpointSlug && action === 'transform' && key === 'action') return 'variant';
  if (!endpointSlug) return key;
  return key.replace(/_+([a-zA-Z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function validateParameterValue(
  inputSchema: unknown,
  key: string,
  value: unknown,
  action: string,
  endpointSlug: string | null,
): void {
  const properties = schemaProperties(inputSchema);
  const schemaKey = toActionParameterName(key, action, endpointSlug);
  if (!Object.hasOwn(properties, schemaKey)) {
    throw new HttpError(422, 'PROFILE_UNKNOWN_FIELD', `parameter '${key}' is not declared by the active endpoint schema`);
  }
  const base = inputSchema as Record<string, unknown>;
  const oneFieldSchema = {
    ...base,
    properties: { [schemaKey]: properties[schemaKey] },
    required: [schemaKey],
  };
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(oneFieldSchema);
  } catch {
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'the active endpoint parameter schema could not be validated');
  }
  if (!validate({ [schemaKey]: value })) {
    throw new HttpError(422, 'INVALID_SCHEMA', `parameter '${key}' does not match the active endpoint schema`, {
      errors: (validate.errors ?? []).slice(0, 20).map((error) => ({
        pointer: `/parameterValues/${key}${error.instancePath ?? ''}`,
        message: error.message ?? 'invalid value',
      })),
    });
  }
}

function validateConnectionOverrides(
  existingRaw: unknown,
  next: ProfileSelfServiceEditRequest['connectionsOverride'],
): NonNullable<ProfileSelfServiceEditRequest['connectionsOverride']> {
  const existing = coerceConnectionsOverride(existingRaw);
  const parsed = next ?? existing;
  if (parsed.length > MAX_CONNECTION_STEPS) throw new HttpError(422, 'INVALID_SCHEMA', 'connection overrides exceed the 32-step limit');

  const allowedSlugs = new Set(existing.map((step) => step.slug));
  const allowedStepIds = new Set(existing.flatMap((step) => typeof step.stepId === 'string' ? [step.stepId] : []));
  const seenSteps = new Set<string>();
  const capturedSlots = new Set<string>();
  const injectedSlots = new Set<string>();
  for (const [index, step] of parsed.entries()) {
    if (step.slug.length > 128 || !allowedSlugs.has(step.slug)) {
      throw forbidden('connection overrides may only reference connector steps already assigned to this Profile');
    }
    if (step.stepId !== undefined) {
      if (step.stepId.length > 64 || !/^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/.test(step.stepId)
          || !allowedStepIds.has(step.stepId) || seenSteps.has(step.stepId)) {
        throw forbidden('connection override step ids must be unique existing steps of this endpoint');
      }
      seenSteps.add(step.stepId);
    }
    for (const [field, slot] of [['captureSession', step.captureSession], ['injectSession', step.injectSession]] as const) {
      if (slot === undefined || slot === null) continue;
      if (slot.length > 64 || !SESSION_SLOT_RE.test(slot) || ['__proto__', 'prototype', 'constructor'].includes(slot)) {
        throw new HttpError(422, 'INVALID_SCHEMA', `connectionsOverride[${index}].${field} is not a safe session slot name`);
      }
      (field === 'captureSession' ? capturedSlots : injectedSlots).add(slot);
    }
  }
  for (const slot of injectedSlots) {
    if (!capturedSlots.has(slot)) {
      throw new HttpError(422, 'INVALID_SCHEMA', `session slot '${slot}' is injected but no existing step captures it`);
    }
  }
  return parsed;
}

async function findActiveProfileForEdit(client: PoolClient, input: ProfileSelfServiceEditRequest, actor: ProfileSelfServiceActor): Promise<ActiveProfileRow> {
  const result = await client.query<ActiveProfileRow>(
    `SELECT u.version AS user_version, p.profile_id, a.revision AS active_revision,
            pk.api_key_id, k.hash AS api_key_hash, p.business_id, p.business_version, p.action,
            p.endpoint_slug, p.connector_bindings, p.enabled, p.parameters, p.job_priority,
            p.allowed_file_extensions, p.connections_override, n.group_id
       FROM admin_local_users u
       JOIN admin_local_user_profile_grants g ON g.user_id=u.id AND g.tenant_id=u.tenant_id
       JOIN profile_active_revisions a ON a.profile_id=g.profile_id
       JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision AND p.tenant_id=u.tenant_id
       JOIN profile_api_keys pk ON pk.profile_id=p.profile_id AND pk.tenant_id=p.tenant_id AND pk.state='ACTIVE'
       JOIN api_keys k ON k.id=pk.api_key_id AND k.tenant_id=p.tenant_id AND k.status='ACTIVE'
       JOIN profile_names n ON n.profile_id=p.profile_id AND n.tenant_id=p.tenant_id
            AND n.business_id=p.business_id
            AND n.business_version=p.business_version AND n.action=p.action
      WHERE u.id=$1 AND u.tenant_id=$2 AND u.role='operator' AND u.is_enabled=true AND u.is_locked=false
        AND g.profile_id=$3 AND p.profile_id=$3 AND p.tenant_id=$2
        AND p.business_id=$4 AND p.business_version=$5 AND n.profile_name=$6
      ORDER BY pk.created_at,pk.api_key_id LIMIT 1
      FOR UPDATE OF u,g,a,p,k,pk`,
    [actor.userId, input.tenantId, input.profileId, input.businessId, input.businessVersion, input.profileName],
  );
  const row = result.rows[0];
  if (!row) throw notFound('assigned active Profile endpoint was not found');
  if (row.group_id) throw conflict('STATE_CONFLICT', 'this profile is owned by a profile group; edit it through the profile group');
  if (Number(row.user_version) !== actor.roleVersion) throw conflict('IDENTITY_VERSION_CONFLICT', 'local identity changed; sign in again before editing');
  if (row.business_id !== input.businessId || row.business_version !== input.businessVersion) {
    throw notFound('assigned active Profile endpoint was not found');
  }
  return row;
}

export function createProfileSelfServiceService(deps: ProfileSelfServiceDependencies) {
  return {
    /**
     * Group visibility is only the intersection of EXISTING child-profile
     * grants and the selected active API-key grant/memberships. This does not
     * create group grants or widen the profile assignment model.
     */
    async canReadAssignedProfileGroup(
      input: { profileIds: readonly string[]; apiKeyId: string },
      actor: ProfileSelfServiceActor,
    ): Promise<boolean> {
      await assertCurrentLocalActor(deps, actor);
      const profileIds = [...new Set(input.profileIds)];
      if (profileIds.length === 0 || profileIds.some((profileId) => !/^[0-9a-f-]{36}$/i.test(profileId))
          || !/^[0-9a-f-]{36}$/i.test(input.apiKeyId)) return false;
      for (const profileId of profileIds) {
        if (!await deps.identity.isLocalUserAssignedProfile({
          tenantId: actor.tenantId,
          userId: actor.userId,
          profileId,
        })) return false;
      }
      const selected = await deps.db.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM admin_local_users u
             JOIN admin_local_user_api_key_grants ug
               ON ug.user_id=u.id AND ug.tenant_id=u.tenant_id AND ug.api_key_id=$4
             JOIN api_keys k ON k.id=ug.api_key_id AND k.tenant_id=u.tenant_id AND k.status='ACTIVE'
            WHERE u.id=$1 AND u.tenant_id=$2 AND u.role='operator'
              AND u.is_enabled=true AND u.is_locked=false AND u.version=$3
              AND (SELECT count(DISTINCT m.profile_id)
                     FROM profile_api_keys m
                     JOIN profile_names n ON n.profile_id=m.profile_id AND n.tenant_id=m.tenant_id
                    WHERE m.profile_id=ANY($5::uuid[]) AND m.tenant_id=u.tenant_id
                      AND m.api_key_id=k.id AND m.state='ACTIVE' AND n.group_id IS NOT NULL
                  )=cardinality($5::uuid[])
         ) AS ok`,
        [actor.userId, actor.tenantId, actor.roleVersion, input.apiKeyId, profileIds],
      );
      return selected.rows[0]?.ok === true;
    },

    async listAssignedProfileApiKeys(
      profileId: string,
      rawQuery: unknown,
      actor: ProfileSelfServiceActor,
    ): Promise<ProfileSelfServiceAssignedApiKeyPage> {
      const parsedQuery = ProfileSelfServiceAssignedApiKeyQuerySchema.safeParse(rawQuery ?? {});
      if (!parsedQuery.success || !/^[0-9a-f-]{36}$/i.test(profileId)) throw new HttpError(422, 'INVALID_SCHEMA', 'assigned API key query is invalid');
      const query: ProfileSelfServiceAssignedApiKeyQuery = parsedQuery.data;
      await assertCurrentLocalActor(deps, actor);
      if (!await deps.identity.isLocalUserAssignedProfile({ tenantId: actor.tenantId, userId: actor.userId, profileId })) {
        throw notFound('assigned Profile endpoint was not found');
      }
      const clauses = [
        `u.id=$1 AND u.tenant_id=$2 AND u.role='operator' AND u.is_enabled=true AND u.is_locked=false AND u.version=$3`,
        `pg.tenant_id=u.tenant_id AND pg.user_id=u.id AND pg.profile_id=p.profile_id`,
        `a.profile_id=p.profile_id AND a.revision=p.revision`,
        `p.tenant_id=u.tenant_id AND p.profile_id=$4 AND p.enabled=true`,
        `uk.tenant_id=u.tenant_id AND uk.user_id=u.id AND uk.api_key_id=k.id`,
        `pk.tenant_id=p.tenant_id AND pk.profile_id=p.profile_id AND pk.api_key_id=k.id AND pk.state='ACTIVE'`,
        `k.tenant_id=p.tenant_id AND k.status='ACTIVE'`,
        `EXISTS (SELECT 1 FROM profile_names n WHERE n.profile_id=p.profile_id AND n.group_id IS NULL)`,
      ];
      const params: unknown[] = [actor.userId, actor.tenantId, actor.roleVersion, profileId];
      const needle = query.query?.trim();
      if (needle) {
        params.push(`%${needle.replace(/[\\%_]/g, '\\$&')}%`);
        clauses.push(`(coalesce(k.name,'') ILIKE $${params.length} ESCAPE '\\' OR k.prefix ILIKE $${params.length} ESCAPE '\\')`);
      }
      const where = clauses.join(' AND ');
      const count = await deps.db.query<{ total: number }>(
        `SELECT count(DISTINCT k.id)::int AS total
           FROM admin_local_users u
           JOIN admin_local_user_profile_grants pg ON pg.user_id=u.id AND pg.tenant_id=u.tenant_id
           JOIN profile_active_revisions a ON a.profile_id=pg.profile_id
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_api_keys pk ON pk.profile_id=p.profile_id AND pk.tenant_id=p.tenant_id
           JOIN api_keys k ON k.id=pk.api_key_id AND k.tenant_id=pk.tenant_id
           JOIN admin_local_user_api_key_grants uk ON uk.user_id=u.id AND uk.tenant_id=u.tenant_id AND uk.api_key_id=k.id
          WHERE ${where}`,
        params,
      );
      const pageParams = [...params];
      const cursor = parseAssignedApiKeyCursor(query.cursor);
      let cursorClause = '';
      if (cursor) {
        pageParams.push(cursor);
        cursorClause = `AND k.id>$${pageParams.length}::uuid`;
      }
      pageParams.push(query.limit + 1);
      const rows = await deps.db.query<AssignedApiKeyRow>(
        `SELECT DISTINCT k.id AS api_key_id,k.name,k.prefix
           FROM admin_local_users u
           JOIN admin_local_user_profile_grants pg ON pg.user_id=u.id AND pg.tenant_id=u.tenant_id
           JOIN profile_active_revisions a ON a.profile_id=pg.profile_id
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_api_keys pk ON pk.profile_id=p.profile_id AND pk.tenant_id=p.tenant_id
           JOIN api_keys k ON k.id=pk.api_key_id AND k.tenant_id=pk.tenant_id
           JOIN admin_local_user_api_key_grants uk ON uk.user_id=u.id AND uk.tenant_id=u.tenant_id AND uk.api_key_id=k.id
          WHERE ${where} ${cursorClause}
          ORDER BY k.id LIMIT $${pageParams.length}`,
        pageParams,
      );
      const hasMore = rows.rows.length > query.limit;
      const items = rows.rows.slice(0, query.limit).map((row) => ({
        apiKeyId: row.api_key_id,
        name: row.name,
        prefix: row.prefix,
        status: 'ACTIVE' as const,
      }));
      return ProfileSelfServiceAssignedApiKeyPageSchema.parse({
        tenantId: actor.tenantId,
        profileId,
        items,
        nextCursor: hasMore && rows.rows[query.limit - 1] ? assignedApiKeyCursor(rows.rows[query.limit - 1]!) : null,
        total: Number(count.rows[0]?.total ?? 0),
        limit: query.limit,
      });
    },

    async listAssignedProfileEndpoints(
      rawQuery: unknown,
      actor: ProfileSelfServiceActor,
    ): Promise<ProfileSelfServiceAssignedPage> {
      const parsedQuery = ProfileSelfServiceAssignedQuerySchema.safeParse(rawQuery ?? {});
      if (!parsedQuery.success) throw new HttpError(422, 'INVALID_SCHEMA', 'assigned Profile query is invalid');
      const query: ProfileSelfServiceAssignedQuery = parsedQuery.data;
      await assertCurrentLocalActor(deps, actor);
      const cursor = parseAssignedCursor(query.cursor);
      const clauses = [
        `u.id=$1 AND u.tenant_id=$2 AND u.role='operator' AND u.is_enabled=true AND u.is_locked=false AND u.version=$3`,
        `g.tenant_id=u.tenant_id AND g.user_id=u.id AND g.profile_id=p.profile_id`,
        `p.tenant_id=u.tenant_id AND p.profile_id=a.profile_id AND p.revision=a.revision AND p.enabled=true`,
        `n.profile_id=p.profile_id AND n.tenant_id=p.tenant_id AND n.business_id=p.business_id AND n.business_version=p.business_version AND n.action=p.action AND n.group_id IS NULL`,
        `b.business_id=p.business_id AND b.version=p.business_version AND b.status='ENABLED' AND b.is_active=true`,
        `EXISTS (SELECT 1 FROM profile_api_keys m JOIN api_keys k ON k.id=m.api_key_id AND k.tenant_id=m.tenant_id
                 WHERE m.profile_id=p.profile_id AND m.tenant_id=p.tenant_id AND m.state='ACTIVE' AND k.status='ACTIVE')`,
      ];
      const params: unknown[] = [actor.userId, actor.tenantId, actor.roleVersion];
      const needle = query.query?.trim();
      if (needle) {
        params.push(`%${needle.replace(/[\\%_]/g, '\\$&')}%`);
        clauses.push(`(n.business_id ILIKE $${params.length} ESCAPE '\\' OR n.business_version ILIKE $${params.length} ESCAPE '\\'
          OR n.profile_name ILIKE $${params.length} ESCAPE '\\' OR p.action ILIKE $${params.length} ESCAPE '\\')`);
      }
      const where = clauses.join(' AND ');
      const count = await deps.db.query<{ total: number }>(
        `SELECT count(DISTINCT p.profile_id)::int AS total
           FROM admin_local_users u
           JOIN admin_local_user_profile_grants g ON g.user_id=u.id AND g.tenant_id=u.tenant_id
           JOIN profile_active_revisions a ON a.profile_id=g.profile_id
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_names n ON n.profile_id=p.profile_id
           JOIN business_versions b ON b.business_id=p.business_id AND b.version=p.business_version
          WHERE ${where}`,
        params,
      );
      const pageParams = [...params];
      let cursorClause = '';
      if (cursor) {
        pageParams.push(cursor.businessId, cursor.businessVersion, cursor.profileName, cursor.profileId);
        const base = params.length;
        cursorClause = `AND (n.business_id,n.business_version,n.profile_name,p.profile_id) > ($${base + 1},$${base + 2},$${base + 3},$${base + 4}::uuid)`;
      }
      pageParams.push(query.limit + 1);
      const rows = await deps.db.query<AssignedProfileRow>(
        `SELECT p.profile_id,p.tenant_id,p.business_id,p.business_version,n.profile_name,p.action,
                p.endpoint_slug,p.revision,p.connector_bindings,p.parameters,p.connections_override
           FROM admin_local_users u
           JOIN admin_local_user_profile_grants g ON g.user_id=u.id AND g.tenant_id=u.tenant_id
           JOIN profile_active_revisions a ON a.profile_id=g.profile_id
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_names n ON n.profile_id=p.profile_id
           JOIN business_versions b ON b.business_id=p.business_id AND b.version=p.business_version
          WHERE ${where} ${cursorClause}
          ORDER BY n.business_id,n.business_version,n.profile_name,p.profile_id
          LIMIT $${pageParams.length}`,
        pageParams,
      );
      const hasMore = rows.rows.length > query.limit;
      const items: ProfileSelfServiceAssignedPage['items'] = [];
      const manifestCache = new Map<string, Awaited<ReturnType<RegistryService['getEnabledVersion']>>>();
      for (const row of rows.rows.slice(0, query.limit)) {
        if (!await deps.identity.isLocalUserAssignedProfile({ tenantId: actor.tenantId, userId: actor.userId, profileId: row.profile_id })) continue;
        const manifestKey = `${row.business_id}\u0000${row.business_version}`;
        let registered = manifestCache.get(manifestKey);
        if (!registered) {
          registered = await deps.registry.getEnabledVersion(row.business_id, row.business_version);
          manifestCache.set(manifestKey, registered);
        }
        const action = registered.manifest.actions.find((candidate) => candidate.name === row.action);
        if (!action || typeof action.inputSchema !== 'object' || action.inputSchema === null || Array.isArray(action.inputSchema)) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'assigned endpoint manifest is unavailable');
        }
        items.push(ProfileSelfServiceAssignedEndpointSchema.parse({
          profileId: row.profile_id,
          tenantId: row.tenant_id,
          businessId: row.business_id,
          businessVersion: row.business_version,
          profileName: row.profile_name,
          action: row.action,
          endpointSlug: row.endpoint_slug,
          revision: Number(row.revision),
          connectorBindings: parseConnectorBindings(row.connector_bindings),
          inputSchema: safeInputSchema(action.inputSchema as Record<string, unknown>),
          parameters: safeParameters(row.parameters, action.inputSchema as Record<string, unknown>, row.action, row.endpoint_slug),
          connectionsOverride: coerceConnectionsOverride(row.connections_override),
        }));
      }
      return ProfileSelfServiceAssignedPageSchema.parse({
        tenantId: actor.tenantId,
        items,
        nextCursor: hasMore && rows.rows[query.limit - 1] ? assignedCursor(rows.rows[query.limit - 1]!) : null,
        total: Number(count.rows[0]?.total ?? 0),
        limit: query.limit,
      });
    },

    async editAssignedProfile(
      rawInput: unknown,
      actor: ProfileSelfServiceActor,
      idempotencyKey: string,
      correlationId: string,
    ): Promise<ProfileSelfServiceEditResponse> {
      requireTrustedActor(actor);
      const parsed = ProfileSelfServiceEditRequestSchema.safeParse(rawInput);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'assigned Profile edit is invalid');
      const input = parsed.data;
      if (input.tenantId !== actor.tenantId) throw notFound('assigned active Profile endpoint was not found');
      if (typeof idempotencyKey !== 'string' || !/^[!-~]{8,200}$/.test(idempotencyKey)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'Idempotency-Key must be 8-200 printable ASCII characters');
      }

      // This trusted identity helper is the public assignment authority. The
      // transaction below repeats and locks the assignment so revocation cannot
      // race an edit after this check.
      if (!await deps.identity.isLocalUserAssignedProfile({
        tenantId: actor.tenantId,
        userId: actor.userId,
        profileId: input.profileId,
      })) throw forbidden('this local user is not assigned to the selected Profile');

      await assertCurrentLocalActor(deps, actor);

      const idem = {
        key: idempotencyKey,
        route: IDEMPOTENCY_ROUTE,
        payloadHash: canonicalPayloadHash({ input, actor: { tenantId: actor.tenantId, issuer: actor.issuer, userId: actor.userId, roleVersion: actor.roleVersion } }),
      };
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => deps.db.tx(async (client) => {
        // Serialize retries before taking profile/user locks. The shared
        // executeIdempotent helper reads after commit; this lock closes the
        // concurrent first-request window for this endpoint.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`admin-idempotency:${idempotencyKey}`]);
        const previous = await client.query<{ route: string; payload_hash: string; response_code: number; response_body: unknown }>(
          'SELECT route,payload_hash,response_code,response_body FROM admin_idempotency WHERE key=$1', [idempotencyKey],
        );
        if (previous.rowCount) {
          const saved = previous.rows[0]!;
          if (saved.route !== idem.route || saved.payload_hash !== idem.payloadHash) {
            throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with different input');
          }
          const replay = { status: Number(saved.response_code), body: saved.response_body as ProfileSelfServiceEditResponse };
          await withMarker(client, replay);
          return replay;
        }

        const row = await findActiveProfileForEdit(client, input, actor);
        if (Number(row.active_revision) !== input.expectedRevision) {
          throw conflict('REVISION_CONFLICT', `expected active Profile revision ${input.expectedRevision} but it changed; reload and review the draft`);
        }
        if (row.enabled !== true) throw forbidden('assigned Profile endpoint is disabled');

        const registered = await deps.registry.getEnabledVersion(row.business_id, row.business_version);
        const action = registered.manifest.actions.find((candidate) => candidate.name === row.action);
        if (!action) throw notFound('the assigned Profile endpoint is no longer in the enabled business manifest');

        const currentParameters = coerceRowParameters(row.parameters);
        const nextParameters: Record<string, { value: unknown; isLocked?: boolean }> = Object.assign(Object.create(null) as Record<string, { value: unknown; isLocked?: boolean }>, currentParameters);
        const properties = schemaProperties(action.inputSchema);
        for (const [key, value] of Object.entries(input.parameterValues ?? {})) {
          if (findSecretParameterKeys({ [key]: { value } }).length > 0) {
            throw new HttpError(422, 'INVALID_SCHEMA', `parameter '${key}' is credential-shaped and cannot be edited here`);
          }
          const schemaKey = toActionParameterName(key, row.action, row.endpoint_slug);
          if (!Object.hasOwn(properties, schemaKey)) {
            throw new HttpError(422, 'PROFILE_UNKNOWN_FIELD', `parameter '${key}' is not declared by the active endpoint schema`);
          }
          const property = properties[schemaKey];
          const defaultLocked = isRecord(property) && property.defaultLocked === true;
          if (currentParameters[key]?.isLocked === true || (currentParameters[key] === undefined && defaultLocked)) {
            throw new HttpError(400, 'PROFILE_LOCKED_FIELD', `parameter '${key}' is locked by the administrator`);
          }
          validateParameterValue(action.inputSchema, key, value, row.action, row.endpoint_slug);
          nextParameters[key] = {
            value,
            ...(currentParameters[key]?.isLocked === undefined ? {} : { isLocked: currentParameters[key]!.isLocked }),
          };
        }
        const parameters = parseWriteParameters(nextParameters);
        const connectionsOverride = validateConnectionOverrides(row.connections_override, input.connectionsOverride);

        const result = await deps.profiles.createRevision({
          profileId: input.profileId,
          apiKeyHash: row.api_key_hash,
          businessId: row.business_id,
          businessVersion: row.business_version,
          action: row.action,
          connectorBindings: parseConnectorBindings(row.connector_bindings),
          ...(row.endpoint_slug ? { endpointSlug: row.endpoint_slug } : {}),
          policy: {
            enabled: row.enabled,
            parameters,
            jobPriority: row.job_priority ?? 'MEDIUM',
            allowedFileExtensions: row.allowed_file_extensions ?? '',
            connectionsOverride,
          },
        }, client);
        const response: ProfileSelfServiceEditResponse = {
          tenantId: actor.tenantId,
          profileId: result.profileId,
          revision: result.revision,
          replayed: false,
        };
        await deps.audit.record({
          tenantId: actor.tenantId,
          actor: `local-user:${actor.userId}`,
          actorIssuer: actor.issuer,
          actorSub: actor.userId,
          actorRole: 'USER',
          action: 'profile.self-service.edit',
          resource: `profile:${result.profileId}:revision:${result.revision}`,
          severity: 'success',
          correlationId,
        }, client);
        await withMarker(client, { status: 200, body: response });
        return { status: 200, body: response };
      }));
      return { ...ProfileSelfServiceEditResponseSchema.parse(outcome.body), replayed: outcome.replayed };
    },
  };
}

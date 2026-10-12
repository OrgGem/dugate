import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  CostAlertRecipientCatalogQuerySchema,
  CostAlertRecipientCatalogSchema,
  CostAlertRecipientSchema,
  type CostAlertRecipientCatalog,
  type CostAlertRecipientCatalogQuery,
  type CostAlertRecipient,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

export type CostAlertOidcRole = 'admin' | 'operator' | 'viewer';
export type CostAlertOidcRecipientState = 'ENABLED' | 'DISABLED' | 'REVOKED';

/** Facts are accepted only from the verified OIDC callback after role mapping. */
export interface VerifiedCostAlertOidcLogin {
  issuer: string;
  sub: string;
  role: CostAlertOidcRole;
  tenantId: string | null;
  verifiedAt: string;
}

/** Identity facts loaded from the opaque server-side session, never request JSON. */
export interface TrustedCostAlertOidcSession {
  issuer: string;
  sub: string;
  role: CostAlertOidcRole;
  tenantId: string | null;
  costAlertPrincipalId?: string;
  costAlertAuthorizationVersion?: number;
  createdAt: number;
}

/** Internal snapshot. Do not serialize issuer or sub into any browser response. */
export interface CostAlertOidcPrincipalSnapshot {
  principalId: string;
  displayName: string;
  issuer: string;
  sub: string;
  role: CostAlertOidcRole;
  tenantId: string | null;
  authorizationVersion: number;
  state: CostAlertOidcRecipientState;
  lastVerifiedAt: string;
  eligible: boolean;
}

export interface ObservedCostAlertOidcLogin {
  principal: CostAlertOidcPrincipalSnapshot;
  /** False when this verified token is older than the directory's newest facts. */
  sessionEligible: boolean;
}

export interface CostAlertOidcPrincipalLifecycleResult {
  principalId: string;
  state: CostAlertOidcRecipientState;
  authorizationVersion: number;
  changedAt: string;
}

interface RecipientRow extends QueryResultRow {
  principal_id: string;
  display_code: string;
  issuer: string;
  subject: string;
  observed_role: CostAlertOidcRole;
  observed_tenant_id: string | null;
  state: CostAlertOidcRecipientState;
  authorization_version: number | string;
  last_verified_at: Date | string;
}

interface LifecycleCommandRow extends QueryResultRow {
  request_hash: string;
  result: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE = new Set<CostAlertOidcRole>(['admin', 'operator', 'viewer']);
const STATES = new Set<CostAlertOidcRecipientState>(['ENABLED', 'DISABLED', 'REVOKED']);
const MAX_VERSION = Number.MAX_SAFE_INTEGER;

function badInput(message: string): never {
  throw new HttpError(422, 'INVALID_SCHEMA', message);
}

function unavailable(message = 'cost alert recipient directory is unavailable'): never {
  throw new HttpError(503, 'COST_ALERT_RECIPIENTS_UNAVAILABLE', message);
}

function denied(message = 'the current external Admin recipient is unavailable'): never {
  throw new HttpError(403, 'COST_ALERT_RECIPIENT_UNAVAILABLE', message);
}

function conflict(message: string): never {
  throw new HttpError(409, 'STATE_CONFLICT', message);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function parsedTime(value: unknown): Date {
  if (typeof value !== 'string' || value.length > 64) return badInput('verifiedAt must be a UTC timestamp');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return badInput('verifiedAt must be canonical UTC');
  return date;
}

function rowTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailable('recipient directory contains an invalid verification timestamp');
  return date.toISOString();
}

function rowVersion(value: number | string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) return unavailable('recipient directory contains an invalid authorization version');
  return version;
}

function snapshot(row: RecipientRow): CostAlertOidcPrincipalSnapshot {
  if (!ROLE.has(row.observed_role) || !STATES.has(row.state)) return unavailable('recipient directory contains invalid role or state data');
  const version = rowVersion(row.authorization_version);
  return {
    principalId: row.principal_id,
    displayName: `External OIDC Admin · ${row.display_code}`,
    issuer: row.issuer,
    sub: row.subject,
    role: row.observed_role,
    tenantId: row.observed_tenant_id,
    authorizationVersion: version,
    state: row.state,
    lastVerifiedAt: rowTime(row.last_verified_at),
    eligible: row.observed_role === 'admin' && row.observed_tenant_id === null && row.state === 'ENABLED',
  };
}

function validateIdentity(value: VerifiedCostAlertOidcLogin | TrustedCostAlertOidcSession): void {
  if (!validText(value.issuer, 512) || !validText(value.sub, 512) || !ROLE.has(value.role)) {
    badInput('a verified OIDC issuer, subject, and role are required');
  }
  if (value.issuer === 'du-local') badInput('local Admin identities do not use the OIDC recipient directory');
  if (value.tenantId !== null && !UUID.test(value.tenantId)) badInput('the trusted OIDC tenant scope is invalid');
}

function validateSession(value: TrustedCostAlertOidcSession): void {
  validateIdentity(value);
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) badInput('the trusted OIDC session creation time is invalid');
  const hasId = value.costAlertPrincipalId !== undefined;
  const hasVersion = value.costAlertAuthorizationVersion !== undefined;
  if (hasId !== hasVersion
    || (hasId && (!UUID.test(value.costAlertPrincipalId!) || !Number.isSafeInteger(value.costAlertAuthorizationVersion)
      || Number(value.costAlertAuthorizationVersion) < 1 || Number(value.costAlertAuthorizationVersion) > MAX_VERSION))) {
    badInput('the trusted OIDC alert-recipient version pin is invalid');
  }
}

function identityLockKey(issuer: string, sub: string): string {
  const digest = createHash('sha256').update(issuer, 'utf8').update('\0').update(sub, 'utf8').digest('hex');
  return `cost-alert-oidc:${digest}`;
}

function newDisplayCode(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}

async function lockIdentity(client: PoolClient, issuer: string, sub: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [identityLockKey(issuer, sub)]);
}

async function findByIdentity(client: PoolClient, issuer: string, sub: string): Promise<RecipientRow | null> {
  const result = await client.query<RecipientRow>(
    `SELECT principal_id::text AS principal_id,display_code,issuer,subject,observed_role,observed_tenant_id::text AS observed_tenant_id,
            state,authorization_version,last_verified_at
       FROM cost_alert_oidc_recipients WHERE issuer=$1 AND subject=$2 FOR UPDATE`, [issuer, sub],
  );
  return result.rows[0] ?? null;
}

async function findByPrincipal(client: PoolClient, principalId: string, lock = false): Promise<RecipientRow | null> {
  const result = await client.query<RecipientRow>(
    `SELECT principal_id::text AS principal_id,display_code,issuer,subject,observed_role,observed_tenant_id::text AS observed_tenant_id,
            state,authorization_version,last_verified_at
       FROM cost_alert_oidc_recipients WHERE principal_id=$1${lock ? ' FOR UPDATE' : ''}`, [principalId],
  );
  return result.rows[0] ?? null;
}

function sessionFactsMatch(session: TrustedCostAlertOidcSession, principal: CostAlertOidcPrincipalSnapshot): boolean {
  return session.issuer === principal.issuer && session.sub === principal.sub
    && session.role === principal.role && session.tenantId === principal.tenantId
    && session.costAlertPrincipalId === principal.principalId
    && session.costAlertAuthorizationVersion === principal.authorizationVersion;
}

/**
 * Called by the verified OIDC callback only after issuer/signature/state/nonce
 * validation and the application's role mapping have succeeded. A newer
 * verified role/scope observation advances authorizationVersion. Old
 * observations cannot restore a role, clear a channel-only disable/revoke,
 * or give an older login the current pin.
 */
export async function observeVerifiedLogin(
  db: Db,
  input: VerifiedCostAlertOidcLogin,
): Promise<ObservedCostAlertOidcLogin | null> {
  validateIdentity(input);
  const verifiedAt = parsedTime(input.verifiedAt);
  return db.tx(async (client) => {
    await lockIdentity(client, input.issuer, input.sub);
    const current = await findByIdentity(client, input.issuer, input.sub);
    if (!current) {
      if (input.role !== 'admin' || input.tenantId !== null) return null;
      const inserted = await client.query<RecipientRow>(
        `INSERT INTO cost_alert_oidc_recipients
          (principal_id,display_code,issuer,subject,observed_role,observed_tenant_id,state,authorization_version,last_verified_at)
         VALUES($1,$2,$3,$4,$5,$6,'ENABLED',1,$7)
         RETURNING principal_id::text AS principal_id,display_code,issuer,subject,observed_role,
                   observed_tenant_id::text AS observed_tenant_id,state,authorization_version,last_verified_at`,
        [randomUUID(), newDisplayCode(), input.issuer, input.sub, input.role, input.tenantId, verifiedAt.toISOString()],
      );
      const principal = snapshot(inserted.rows[0]!);
      return { principal, sessionEligible: principal.eligible };
    }

    const existing = snapshot(current);
    const observedAt = new Date(existing.lastVerifiedAt);
    if (verifiedAt.getTime() < observedAt.getTime()) {
      return { principal: existing, sessionEligible: false };
    }
    const changedAuthorization = input.role !== existing.role || input.tenantId !== existing.tenantId;
    let version = existing.authorizationVersion;
    if (changedAuthorization) {
      if (version >= MAX_VERSION) unavailable('recipient authorization version cannot advance safely');
      version += 1;
    }
    const updated = await client.query<RecipientRow>(
      `UPDATE cost_alert_oidc_recipients
          SET observed_role=$2,observed_tenant_id=$3,authorization_version=$4,
              last_verified_at=GREATEST(last_verified_at,$5),updated_at=now()
        WHERE principal_id=$1
        RETURNING principal_id::text AS principal_id,display_code,issuer,subject,observed_role,
                  observed_tenant_id::text AS observed_tenant_id,state,authorization_version,last_verified_at`,
      [existing.principalId, input.role, input.tenantId, version, verifiedAt.toISOString()],
    );
    const principal = snapshot(updated.rows[0]!);
    const factsMatch = input.role === principal.role && input.tenantId === principal.tenantId
      && verifiedAt.getTime() >= observedAt.getTime();
    return { principal, sessionEligible: factsMatch && principal.eligible };
  });
}

/**
 * Resolve a self-recipient from a trusted server session. A session without a
 * pin can create a missing directory row from its original creation time, but
 * cannot attach itself to an existing row or copy a newer version.
 */
export async function ensureSelfRecipient(
  db: Db,
  trustedSession: TrustedCostAlertOidcSession,
): Promise<CostAlertOidcPrincipalSnapshot> {
  validateSession(trustedSession);
  if (trustedSession.role !== 'admin' || trustedSession.tenantId !== null) denied('only a verified platform OIDC Admin can use the external recipient directory');
  return db.tx(async (client) => {
    await lockIdentity(client, trustedSession.issuer, trustedSession.sub);
    const current = await findByIdentity(client, trustedSession.issuer, trustedSession.sub);
    if (!current) {
      if (trustedSession.costAlertPrincipalId !== undefined) denied('the pinned external Admin recipient no longer exists');
      const createdAt = new Date(trustedSession.createdAt);
      if (!Number.isFinite(createdAt.getTime())) badInput('the trusted OIDC session creation time is invalid');
      const inserted = await client.query<RecipientRow>(
        `INSERT INTO cost_alert_oidc_recipients
          (principal_id,display_code,issuer,subject,observed_role,observed_tenant_id,state,authorization_version,last_verified_at)
         VALUES($1,$2,$3,$4,'admin',NULL,'ENABLED',1,$5)
         RETURNING principal_id::text AS principal_id,display_code,issuer,subject,observed_role,
                   observed_tenant_id::text AS observed_tenant_id,state,authorization_version,last_verified_at`,
        [randomUUID(), newDisplayCode(), trustedSession.issuer, trustedSession.sub, createdAt.toISOString()],
      );
      return snapshot(inserted.rows[0]!);
    }

    const principal = snapshot(current);
    if (trustedSession.costAlertPrincipalId === undefined
      || trustedSession.costAlertAuthorizationVersion === undefined
      || !sessionFactsMatch(trustedSession, principal)
      || !principal.eligible) {
      denied('sign in again to refresh the current external Admin recipient pin');
    }
    return principal;
  });
}

/** Read-only current lookup. No browser values can populate this session DTO. */
export async function resolveCurrentPrincipal(
  db: Db,
  trustedSession: TrustedCostAlertOidcSession,
): Promise<CostAlertOidcPrincipalSnapshot | null> {
  validateSession(trustedSession);
  if (!trustedSession.costAlertPrincipalId || !trustedSession.costAlertAuthorizationVersion) return null;
  const result = await db.query<RecipientRow>(
    `SELECT principal_id::text AS principal_id,display_code,issuer,subject,observed_role,observed_tenant_id::text AS observed_tenant_id,
            state,authorization_version,last_verified_at
       FROM cost_alert_oidc_recipients WHERE principal_id=$1`, [trustedSession.costAlertPrincipalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const principal = snapshot(row);
  if (!sessionFactsMatch(trustedSession, principal) || !principal.eligible) return null;
  return principal;
}

interface RecipientCatalogCursor {
  version: 1;
  tenantId: string;
  filterHash: string;
  afterPrincipalId: string;
}

function recipientCatalogFilterHash(query: CostAlertRecipientCatalogQuery): string {
  return createHash('sha256').update(JSON.stringify({ tenantId: query.tenantId, q: query.q, limit: query.limit })).digest('hex');
}

function decodeRecipientCatalogCursor(raw: string, query: CostAlertRecipientCatalogQuery): RecipientCatalogCursor {
  let value: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) throw new Error('noncanonical cursor');
    value = JSON.parse(decoded) as unknown;
  } catch {
    badInput('recipient catalog cursor is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) badInput('recipient catalog cursor is invalid');
  const cursor = value as Record<string, unknown>;
  if (cursor['version'] !== 1 || cursor['tenantId'] !== query.tenantId
    || cursor['filterHash'] !== recipientCatalogFilterHash(query)
    || typeof cursor['afterPrincipalId'] !== 'string' || !UUID.test(cursor['afterPrincipalId'])) {
    badInput('recipient catalog cursor does not match this tenant and search');
  }
  return {
    version: 1,
    tenantId: query.tenantId,
    filterHash: recipientCatalogFilterHash(query),
    afterPrincipalId: cursor['afterPrincipalId'],
  };
}

/** Safe, bounded catalog; issuer/sub never leave this server module. */
export async function listCostAlertOidcRecipients(
  db: Db,
  input: CostAlertRecipientCatalogQuery,
): Promise<CostAlertRecipientCatalog> {
  const query = CostAlertRecipientCatalogQuerySchema.parse(input);
  const cursor = query.cursor ? decodeRecipientCatalogCursor(query.cursor, query) : null;
  const params: unknown[] = [query.q, cursor?.afterPrincipalId ?? null, query.limit + 1];
  const rows = await db.query<RecipientRow>(
    `SELECT principal_id::text AS principal_id,display_code,issuer,subject,observed_role,
            observed_tenant_id::text AS observed_tenant_id,state,authorization_version,last_verified_at
       FROM cost_alert_oidc_recipients
      WHERE observed_role='admin' AND observed_tenant_id IS NULL
        AND ($1='' OR position(lower($1) in lower(display_code))>0 OR position(lower($1) in lower(principal_id::text))>0)
        AND ($2::uuid IS NULL OR principal_id>$2::uuid)
      ORDER BY principal_id LIMIT $3`, params,
  );
  const items = rows.rows.slice(0, query.limit).map((row) => {
    const principal = snapshot(row);
    return {
      kind: 'oidc' as const,
      principalId: principal.principalId,
      displayName: principal.displayName,
      role: 'ADMIN' as const,
      state: principal.state,
      authorizationVersion: principal.authorizationVersion,
      lastVerifiedAt: principal.lastVerifiedAt,
      eligible: principal.eligible,
    };
  });
  const hasMore = rows.rows.length > query.limit;
  const last = items.at(-1);
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({
      version: 1,
      tenantId: query.tenantId,
      filterHash: recipientCatalogFilterHash(query),
      afterPrincipalId: last.principalId,
    })).toString('base64url')
    : null;
  return CostAlertRecipientCatalogSchema.parse({ tenantId: query.tenantId, items, limit: query.limit, hasMore, nextCursor });
}

export function costAlertOidcRecipientDto(principal: CostAlertOidcPrincipalSnapshot): CostAlertRecipient {
  return CostAlertRecipientSchema.parse({
    kind: 'oidc',
    principalId: principal.principalId,
    displayName: principal.displayName,
    role: 'ADMIN',
    state: principal.state,
    authorizationVersion: principal.authorizationVersion,
    lastVerifiedAt: principal.lastVerifiedAt,
    eligible: principal.eligible,
  });
}

/**
 * Explicit channel-directory lifecycle CAS. Disabling/revoking a recipient
 * does not revoke the wider OIDC login; it only fences this notification
 * channel. REVOKED is terminal; a disabled directory row can be explicitly
 * enabled again by a current platform OIDC Admin and exact CAS version.
 */
export async function transitionCostAlertOidcRecipient(
  db: Db,
  input: {
    principalId: string;
    expectedAuthorizationVersion: number;
    action: 'disable' | 'enable' | 'revoke';
    reason: string;
    idempotencyKey: string;
    actor: TrustedCostAlertOidcSession;
  },
): Promise<CostAlertOidcPrincipalLifecycleResult> {
  validateSession(input.actor);
  if (input.actor.role !== 'admin' || input.actor.tenantId !== null
    || !input.actor.costAlertPrincipalId || !input.actor.costAlertAuthorizationVersion) denied('recipient lifecycle requires the current platform OIDC Admin');
  if (!UUID.test(input.principalId) || !Number.isSafeInteger(input.expectedAuthorizationVersion)
    || input.expectedAuthorizationVersion < 1 || input.expectedAuthorizationVersion > MAX_VERSION
    || !['disable', 'enable', 'revoke'].includes(input.action)
    || typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.length > 240
    || /[\u0000-\u001f\u007f]/.test(input.reason)
    || !/^[A-Za-z0-9._:-]{8,256}$/.test(input.idempotencyKey)) {
    badInput('external recipient lifecycle request is invalid');
  }
  const reason = input.reason.trim();
  const requestHash = `sha256:${createHash('sha256').update(JSON.stringify({
    principalId: input.principalId,
    expectedAuthorizationVersion: input.expectedAuthorizationVersion,
    action: input.action,
    reason,
    actorPrincipalId: input.actor.costAlertPrincipalId,
    actorAuthorizationVersion: input.actor.costAlertAuthorizationVersion,
  })).digest('hex')}`;
  const action = input.action.toUpperCase();

  return db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cost-alert-recipient-lifecycle:${input.principalId}`]);
    const actorRow = await findByPrincipal(client, input.actor.costAlertPrincipalId!, true);
    const actorSnapshot = actorRow ? snapshot(actorRow) : null;
    if (!actorSnapshot || !sessionFactsMatch(input.actor, actorSnapshot) || !actorSnapshot.eligible) {
      denied('recipient lifecycle requires the current enabled platform OIDC Admin');
    }
    const replay = await client.query<LifecycleCommandRow>(
      `SELECT request_hash,result FROM cost_alert_oidc_recipient_commands
        WHERE principal_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.principalId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) conflict('Idempotency-Key was reused for a different recipient lifecycle action');
      const value = replay.rows[0].result as Record<string, unknown>;
      if (typeof value['principalId'] !== 'string' || !STATES.has(value['state'] as CostAlertOidcRecipientState)
        || !Number.isSafeInteger(value['authorizationVersion']) || typeof value['changedAt'] !== 'string') {
        unavailable('recipient lifecycle replay data is invalid');
      }
      return {
        principalId: value['principalId'] as string,
        state: value['state'] as CostAlertOidcRecipientState,
        authorizationVersion: value['authorizationVersion'] as number,
        changedAt: value['changedAt'] as string,
      };
    }

    const targetRow = await findByPrincipal(client, input.principalId, true);
    const target = targetRow ? snapshot(targetRow) : null;
    if (!target || target.role !== 'admin' || target.tenantId !== null) denied('only an external platform Admin recipient can be managed');
    if (target.authorizationVersion !== input.expectedAuthorizationVersion) conflict('recipient version changed; reload it before retrying');
    const nextState: CostAlertOidcRecipientState = input.action === 'enable' ? 'ENABLED'
      : input.action === 'disable' ? 'DISABLED' : 'REVOKED';
    if (target.state === 'REVOKED') conflict('a revoked external recipient cannot be re-enabled');
    if (input.action === 'enable' && target.state !== 'DISABLED') conflict('only a disabled external recipient can be enabled');
    if (input.action === 'disable' && target.state !== 'ENABLED') conflict('only an enabled external recipient can be disabled');
    if (input.action === 'revoke' && target.state !== 'ENABLED' && target.state !== 'DISABLED') conflict('recipient state cannot be revoked');
    if (target.authorizationVersion >= MAX_VERSION) unavailable('recipient authorization version cannot advance safely');

    const changedAt = new Date();
    if (!Number.isFinite(changedAt.getTime())) unavailable('recipient lifecycle clock is invalid');
    const nextVersion = target.authorizationVersion + 1;
    const update = await client.query<RecipientRow>(
      `UPDATE cost_alert_oidc_recipients
          SET state=$3,authorization_version=$4,updated_at=$5
        WHERE principal_id=$1 AND authorization_version=$2
        RETURNING principal_id::text AS principal_id,display_code,issuer,subject,observed_role,
                  observed_tenant_id::text AS observed_tenant_id,state,authorization_version,last_verified_at`,
      [input.principalId, input.expectedAuthorizationVersion, nextState, nextVersion, changedAt.toISOString()],
    );
    if (!update.rows[0]) conflict('recipient version changed; reload it before retrying');
    await client.query(
      `INSERT INTO cost_alert_oidc_recipient_audit
        (audit_id,principal_id,actor_principal_id,action,reason,previous_state,next_state,
         previous_authorization_version,next_authorization_version,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), input.principalId, actorSnapshot.principalId, action, reason, target.state, nextState,
        target.authorizationVersion, nextVersion, changedAt.toISOString()],
    );
    const result: CostAlertOidcPrincipalLifecycleResult = {
      principalId: input.principalId,
      state: nextState,
      authorizationVersion: nextVersion,
      changedAt: changedAt.toISOString(),
    };
    await client.query(
      `INSERT INTO cost_alert_oidc_recipient_commands(principal_id,idempotency_key,request_hash,result)
       VALUES($1,$2,$3,$4::jsonb)`, [input.principalId, input.idempotencyKey, requestHash, JSON.stringify(result)],
    );
    return result;
  });
}

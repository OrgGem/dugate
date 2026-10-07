import { timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../http/errors';

export interface WorkerIdentityConfig {
  /** Platform runtime token; it does not identify a business by itself. */
  runtimeToken?: string;
  /** Per-business bearer tokens provisioned to workers. */
  workerIdentityTokensByBusiness?: Record<string, string>;
}

function bearerValue(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length);
}

function tokenMatches(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  if (expectedBytes.length === 0 || expectedBytes.length !== suppliedBytes.length) return false;
  return timingSafeEqual(expectedBytes, suppliedBytes);
}

export function isAuthorizedRuntimeBearer(
  config: WorkerIdentityConfig,
  authorization: string | undefined
): boolean {
  return isAuthorizedPlatformRuntimeBearer(config, authorization) ||
    resolveWorkerBusinessIdentity(config, authorization) !== null;
}

/** Platform runtime credentials may perform platform-level runtime actions. */
export function isAuthorizedPlatformRuntimeBearer(
  config: WorkerIdentityConfig,
  authorization: string | undefined
): boolean {
  const supplied = bearerValue(authorization);
  return Boolean(config.runtimeToken && tokenMatches(config.runtimeToken, supplied));
}

/** Resolve a worker's business exclusively from its registered bearer token. */
export function resolveWorkerBusinessIdentity(
  config: WorkerIdentityConfig,
  authorization: string | undefined
): string | null {
  const supplied = bearerValue(authorization);
  if (!supplied) return null;
  const matches = Object.entries(config.workerIdentityTokensByBusiness ?? {})
    .filter(([, token]) => tokenMatches(token, supplied))
    .map(([businessId]) => businessId);
  return matches.length === 1 ? matches[0]! : null;
}

/** Reject a worker bearer when the target task/artifact belongs to another business. */
export function authorizeWorkerBusiness(
  config: WorkerIdentityConfig,
  authorization: string | undefined,
  resourceBusinessId: string
): string {
  const authenticatedBusinessId = resolveWorkerBusinessIdentity(config, authorization);
  if (!authenticatedBusinessId || authenticatedBusinessId !== resourceBusinessId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker identity is not authorized for this business');
  }
  return authenticatedBusinessId;
}

/**
 * Resolve a worker's business from its authenticated bearer credential and
 * reject any claim body that declares a different business. The generic
 * runtime token is deliberately not an identity token.
 */
export function authorizeWorkerClaim(
  config: WorkerIdentityConfig,
  authorization: string | undefined,
  declaredBusinessId: string
): string {
  return authorizeWorkerBusiness(config, authorization, declaredBusinessId);
}

export function validateWorkerIdentityConfig(config: WorkerIdentityConfig & {
  adminToken?: string;
  tenantAdminTokens?: Record<string, string>;
  usageToken?: string;
}): void {
  const seenTokens = new Set<string>();
  const reservedTokens = new Set([
    config.runtimeToken,
    config.adminToken,
    config.usageToken,
    ...Object.keys(config.tenantAdminTokens ?? {}),
  ].filter((token): token is string => Boolean(token)));

  for (const [businessId, token] of Object.entries(config.workerIdentityTokensByBusiness ?? {})) {
    if (!businessId.trim() || !token.trim()) {
      throw new Error('refusing to boot: worker identity entries require non-empty business IDs and tokens');
    }
    if (seenTokens.has(token) || reservedTokens.has(token)) {
      throw new Error('refusing to boot: worker identity tokens must be unique and separate from platform credentials');
    }
    seenTokens.add(token);
  }
}

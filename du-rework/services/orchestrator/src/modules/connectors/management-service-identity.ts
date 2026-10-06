import { createHmac, randomUUID } from 'node:crypto';

export type ConnectorManagementAuthorizationProvider = () => string;

const IDENTITY_SUBJECT = 'orchestrator-management';
const IDENTITY_AUDIENCE = 'connector';
const MANAGEMENT_SCOPE = 'connector:manage';
const TOKEN_LIFETIME_SECONDS = 60;

/**
 * Create an on-demand JWT issuer for Connector management requests.
 * A new jti and signature are produced for every invocation; no bearer token
 * is kept in process state. `nowMs` is injectable only to make expiry tests
 * deterministic.
 */
export function createConnectorManagementAuthorizationProvider(
  secret: Uint8Array,
  nowMs: () => number = Date.now,
  createTokenId: () => string = randomUUID,
): ConnectorManagementAuthorizationProvider {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new Error('SERVICE_IDENTITY_SECRET must contain at least 32 bytes');
  }
  const signingKey = Buffer.from(secret);

  return () => {
    const issuedAt = Math.floor(nowMs() / 1000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error('service identity clock is invalid');
    }
    const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const encodedClaims = Buffer.from(JSON.stringify({
      sub: IDENTITY_SUBJECT,
      aud: IDENTITY_AUDIENCE,
      scopes: [MANAGEMENT_SCOPE],
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      jti: createTokenId(),
    })).toString('base64url');
    const signingInput = encodedHeader + '.' + encodedClaims;
    const signature = createHmac('sha256', signingKey).update(signingInput).digest('base64url');
    return 'Bearer ' + signingInput + '.' + signature;
  };
}

/** Decode the same base64 32-byte key consumed by Connector's entrypoint. */
export function connectorManagementAuthorizationProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectorManagementAuthorizationProvider | undefined {
  const encodedSecret = env['SERVICE_IDENTITY_SECRET'];
  if (encodedSecret === undefined || encodedSecret.length === 0) return undefined;
  const secret = Buffer.from(encodedSecret, 'base64');
  if (secret.byteLength !== 32) {
    throw new Error('SERVICE_IDENTITY_SECRET must be a base64-encoded 32-byte secret');
  }
  return createConnectorManagementAuthorizationProvider(secret);
}

import { ConnectorError } from './errors';
import type { ServiceIdentity, ServiceIdentityVerifier } from './types';
import { HmacSignedGrantSource } from './contract-grants';

/**
 * HMAC-SHA256 Bearer service identity (CR28-02; fail-closed enforcement
 * CR06-05).
 *
 * Threat model in short: issuer and Connector share a 32-byte secret.
 * A bearer token is `base64url(header).base64url(claims).base64url(HMAC)`.
 * Signature comparison is constant-time, the header must be HS256, `exp`
 * (epoch seconds) is required and enforced, and `requireServiceIdentity`
 * additionally binds `aud=connector` and the per-route scope. Accepted
 * residual risks: replay inside the short token TTL, no revocation list
 * (rotate the shared secret), and any holder of the shared secret can mint
 * arbitrary identities. The verifier never logs token material. Full note:
 * `docs/08-connector-api.md` threat-model section.
 */
export class HmacServiceIdentityVerifier implements ServiceIdentityVerifier {
  private readonly source: HmacSignedGrantSource;

  public constructor(secret: Uint8Array) {
    this.source = new HmacSignedGrantSource(secret);
  }

  public async verify(headers: Readonly<Record<string, string | undefined>>): Promise<ServiceIdentity> {
    const authorization = headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new Error('Authorization is required.');
    const rawClaims = await this.source.verify(authorization.slice('Bearer '.length));
    if (typeof rawClaims !== 'object' || rawClaims === null || Array.isArray(rawClaims)) {
      throw new Error('Service identity claims are invalid.');
    }
    const claims = rawClaims as {
      sub?: unknown; subject?: unknown; aud?: unknown; audience?: unknown; scopes?: unknown; exp?: unknown;
    };
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) || claims.exp <= nowSeconds) {
      throw new Error('Service identity has expired or is missing an expiry.');
    }
    const subject = claims.sub ?? claims.subject;
    const audience = claims.aud ?? claims.audience;
    if (typeof subject !== 'string' || typeof audience !== 'string') {
      throw new Error('Service identity claims are invalid.');
    }
    if (claims.scopes !== undefined && (!Array.isArray(claims.scopes) || claims.scopes.some((scope) => typeof scope !== 'string'))) {
      throw new Error('Service identity scopes are invalid.');
    }
    return {
      subject,
      audience,
      scopes: (claims.scopes ?? []) as string[],
    };
  }
}

export async function requireServiceIdentity(
  headers: Readonly<Record<string, string | undefined>>,
  verifier: ServiceIdentityVerifier,
  requiredScope: string,
  expectedAudience = 'connector',
): Promise<ServiceIdentity> {
  let identity: ServiceIdentity;
  try {
    identity = await verifier.verify(headers);
  } catch {
    throw new ConnectorError('GRANT_INVALID', 'Service identity is invalid.');
  }
  if (identity.audience !== expectedAudience || !identity.subject || !identity.scopes.includes(requiredScope)) {
    throw new ConnectorError('BINDING_DENIED', 'Service identity lacks the required scope.');
  }
  return identity;
}

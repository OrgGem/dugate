import { ConnectorError } from './errors';
import type { ServiceIdentity, ServiceIdentityVerifier } from './types';
import { HmacSignedGrantSource } from './contract-grants';

export class HmacServiceIdentityVerifier implements ServiceIdentityVerifier {
  private readonly source: HmacSignedGrantSource;

  public constructor(secret: Uint8Array) {
    this.source = new HmacSignedGrantSource(secret);
  }

  public async verify(headers: Readonly<Record<string, string | undefined>>): Promise<ServiceIdentity> {
    const authorization = headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new Error('Authorization is required.');
    const claims = await this.source.verify(authorization.slice('Bearer '.length)) as {
      sub?: string; subject?: string; aud?: string; audience?: string; scopes?: string[];
    };
    return {
      subject: claims.sub ?? claims.subject ?? '',
      audience: claims.aud ?? claims.audience ?? '',
      scopes: claims.scopes ?? [],
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

import { createHmac } from 'node:crypto';
import { HmacServiceIdentityVerifier, requireServiceIdentity } from '../src/identity';

const serviceSecret = Buffer.from('offline-service-identity-test-secret');

function signedServiceToken(
  claims: Record<string, unknown>,
  secret: Uint8Array = serviceSecret,
): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function serviceClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'document-core-worker',
    aud: 'connector',
    scopes: ['connector:invoke'],
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

describe('Connector HMAC service identity verification', () => {
  const verifier = new HmacServiceIdentityVerifier(serviceSecret);

  it('accepts an unexpired Bearer token signed for Connector invocation', async () => {
    const token = signedServiceToken(serviceClaims());
    await expect(requireServiceIdentity(
      { authorization: `Bearer ${token}` },
      verifier,
      'connector:invoke',
    )).resolves.toEqual({
      subject: 'document-core-worker',
      audience: 'connector',
      scopes: ['connector:invoke'],
    });
  });

  it.each([
    ['missing bearer token', {}, verifier],
    ['malformed token', { authorization: 'Bearer malformed-token' }, verifier],
    [
      'wrong signing key',
      { authorization: `Bearer ${signedServiceToken(serviceClaims(), Buffer.from('wrong-key'))}` },
      verifier,
    ],
    [
      'expired token',
      { authorization: `Bearer ${signedServiceToken(serviceClaims({ exp: Math.floor(Date.now() / 1000) - 1 }))}` },
      verifier,
    ],
  ] as const)('rejects %s as an invalid service identity', async (_caseName, headers, activeVerifier) => {
    await expect(requireServiceIdentity(headers, activeVerifier, 'connector:invoke'))
      .rejects.toMatchObject({ code: 'GRANT_INVALID' });
  });

  it.each([
    ['wrong audience', { aud: 'another-service' }],
    ['missing invocation scope', { scopes: ['connector:read'] }],
  ])('rejects a valid identity with %s as a binding denial', async (_caseName, overrides) => {
    const token = signedServiceToken(serviceClaims(overrides));
    await expect(requireServiceIdentity(
      { authorization: `Bearer ${token}` },
      verifier,
      'connector:invoke',
    )).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  });
});

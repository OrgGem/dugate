import { createHmac } from 'node:crypto';
import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import { createConnectorManagementAuthorizationProvider } from '../src/modules/connectors/management-service-identity';

interface ServiceIdentity {
  subject: string;
  audience: string;
  scopes: string[];
}

interface ServiceIdentityVerifier {
  verify(headers: Readonly<Record<string, string | undefined>>): Promise<ServiceIdentity>;
}

interface ConnectorIdentityModule {
  HmacServiceIdentityVerifier: new (secret: Uint8Array) => ServiceIdentityVerifier;
  requireServiceIdentity(
    headers: Readonly<Record<string, string | undefined>>,
    verifier: ServiceIdentityVerifier,
    requiredScope: string,
    expectedAudience?: string,
  ): Promise<ServiceIdentity>;
}

// Use the built Connector verifier that backs the real HTTP server; Orchestrator
// deliberately does not carry a second verifier implementation.
const connectorIdentity = require('../../connector/dist/identity.js') as ConnectorIdentityModule;

const KEY = Buffer.alloc(32, 0x31);
const WRONG_KEY = Buffer.alloc(32, 0x32);
const verifier = new connectorIdentity.HmacServiceIdentityVerifier(KEY);

function signClaims(claims: Record<string, unknown>, key = KEY): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = encodedHeader + '.' + encodedClaims;
  const signature = createHmac('sha256', key).update(signingInput).digest('base64url');
  return 'Bearer ' + signingInput + '.' + signature;
}

function decodeClaims(authorization: string): Record<string, unknown> {
  const payload = authorization.slice('Bearer '.length).split('.')[1];
  if (!payload) throw new Error('signed identity token has no claims segment');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    sub: 'orchestrator-management',
    aud: 'connector',
    scopes: ['connector:manage'],
    iat: issuedAt,
    exp: issuedAt + 60,
    ...overrides,
  };
}

describe('Orchestrator Connector management JWT issuer', () => {
  afterEach(() => jest.useRealTimers());

  it('sends a valid JWT per management request and refreshes after its 60-second lifetime', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
    const authorizationForRequest = createConnectorManagementAuthorizationProvider(KEY);
    const accepted: { authorization: string; identity: ServiceIdentity; claims: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (!authorization) throw new Error('management request omitted Authorization header');
      const identity = await connectorIdentity.requireServiceIdentity(
        { authorization }, verifier, 'connector:manage', 'connector',
      );
      accepted.push({ authorization, identity, claims: decodeClaims(authorization) });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'http://connector.test',
      authorizationForRequest,
      fetchImpl,
    });

    await store.list();
    await store.list();
    jest.advanceTimersByTime(61_000);
    await store.list();

    expect(accepted).toHaveLength(3);
    expect(accepted[0]?.identity).toEqual({
      subject: 'orchestrator-management', audience: 'connector', scopes: ['connector:manage'],
    });
    expect(accepted[0]?.claims).toMatchObject({
      sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
      iat: 1_791_158_400, exp: 1_791_158_460,
    });
    expect(accepted[1]?.claims).toMatchObject({
      sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
      iat: 1_791_158_400, exp: 1_791_158_460,
    });
    expect(accepted[2]?.claims).toMatchObject({
      sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
      iat: 1_791_158_461, exp: 1_791_158_521,
    });
    expect(accepted[0]?.authorization).not.toBe(accepted[1]?.authorization);
    expect(accepted[0]?.claims.jti).not.toBe(accepted[1]?.claims.jti);
    expect(accepted[1]?.authorization).not.toBe(accepted[2]?.authorization);
    expect(accepted[1]?.claims.jti).not.toBe(accepted[2]?.claims.jti);
  });

  it.each([
    ['wrong key', () => signClaims(claims(), WRONG_KEY), 'GRANT_INVALID'],
    ['expired token', () => signClaims(claims({ exp: 1 })), 'GRANT_INVALID'],
    ['wrong audience', () => signClaims(claims({ aud: 'orchestrator' })), 'BINDING_DENIED'],
    ['missing manage scope', () => signClaims(claims({ scopes: ['connector:invoke'] })), 'BINDING_DENIED'],
  ])('%s is rejected by Connector requireServiceIdentity', async (_caseName, authorizationForCase, code) => {
    const authorization = authorizationForCase();
    await expect(connectorIdentity.requireServiceIdentity(
      { authorization }, verifier, 'connector:manage', 'connector',
    )).rejects.toMatchObject({ code });
  });
});

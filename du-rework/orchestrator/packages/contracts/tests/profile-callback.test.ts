/**
 * CB-01 — profile callback contracts: schema freeze negatives.
 *
 * Every case here is a configuration the platform must refuse before a
 * credential, a result body or a destination is trusted.
 */
import {
  CALLBACK_MAX_ARTIFACT_DESCRIPTORS,
  CALLBACK_MAX_INLINE_RESULT_BYTES,
  CALLBACK_REDIRECTS_ALLOWED,
  CallbackResultEnvelopeSchema,
  CallbackSecretRefSchema,
  OAuth2ClientCredentialsAuthSchema,
  ProfileCallbackPolicySchema,
  ProfileCallbackPolicySnapshotSchema,
  authorizeCallbackDestination,
  callbackInlineResultWithinBound,
  isReservedCallbackHeader,
  resolveEffectiveCallbackPolicy,
} from '../src/profile-callback';

const secretRef = { kind: 'managed-secret' as const, ref: 'du/callbacks/acme/webhook-token' };

const noneAuth = { method: 'none' as const };
const headersAuth = {
  method: 'configured_headers' as const,
  headers: [{ name: 'x-api-key', secretRef, prefix: 'Token ' }],
};
const oauthAuth = {
  method: 'oauth2_client_credentials' as const,
  grantType: 'client_credentials' as const,
  tokenUrl: 'https://idp.example.com/oauth/token',
  clientId: 'du-callback-client',
  clientSecretRef: secretRef,
  clientAuthMethod: 'client_secret_basic' as const,
  scope: 'callbacks.write',
};

const destination = {
  approvedOrigins: ['https://hooks.example.com'],
  allowedPathPrefixes: ['/du/'],
};

const policy = (overrides: Record<string, unknown> = {}): unknown => ({
  version: 1,
  mode: 'notification_only',
  auth: noneAuth,
  ...overrides,
});

describe('CB-01 callback secret refs and headers', () => {
  it('accepts only opaque managed-secret refs (never values or URLs)', () => {
    expect(CallbackSecretRefSchema.safeParse(secretRef).success).toBe(true);
    expect(CallbackSecretRefSchema.safeParse({ kind: 'managed-secret', ref: 'https://vault/x' }).success).toBe(false);
    expect(CallbackSecretRefSchema.safeParse({ kind: 'managed-secret', ref: '' }).success).toBe(false);
    expect(CallbackSecretRefSchema.safeParse({ kind: 'plaintext', ref: 's3cret' }).success).toBe(false);
  });

  it('flags reserved/signing headers and accepts normal ones', () => {
    for (const name of ['Authorization', 'host', 'Content-Length', 'x-du-signature', 'transfer-encoding']) {
      expect(isReservedCallbackHeader(name)).toBe(true);
    }
    expect(isReservedCallbackHeader('x-api-key')).toBe(false);
  });

  it('rejects reserved, duplicated and CRLF-injected configured headers', () => {
    const parse = (headers: unknown[]): boolean =>
      ProfileCallbackPolicySchema.safeParse(policy({ auth: { method: 'configured_headers', headers }, destination })).success;
    expect(parse([{ name: 'authorization', secretRef }])).toBe(false);
    expect(parse([{ name: 'X-Api-Key', secretRef }, { name: 'x-api-key', secretRef }])).toBe(false);
    expect(parse([{ name: 'x-api-key', secretRef, prefix: 'Bad\r\nHeader' }])).toBe(false);
    expect(parse([{ name: 'x-api-key', secretRef }])).toBe(true);
  });
});

describe('CB-01 OAuth2 client credentials', () => {
  it('accepts the frozen client_credentials shape and rejects grant overrides', () => {
    expect(OAuth2ClientCredentialsAuthSchema.safeParse(oauthAuth).success).toBe(true);
    expect(OAuth2ClientCredentialsAuthSchema.safeParse({ ...oauthAuth, grantType: 'password' }).success).toBe(false);
    expect(OAuth2ClientCredentialsAuthSchema.safeParse({ ...oauthAuth, clientAuthMethod: 'client_secret_jwt' }).success).toBe(false);
  });

  it('requires https and refuses loopback/private/metadata token endpoints', () => {
    for (const tokenUrl of [
      'http://idp.example.com/token',
      'https://127.0.0.1/token',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/token',
    ]) {
      expect(OAuth2ClientCredentialsAuthSchema.safeParse({ ...oauthAuth, tokenUrl }).success).toBe(false);
    }
  });

  it('rejects reserved or unbounded extension form parameters', () => {
    const parse = (extensions: Record<string, string>): boolean =>
      ProfileCallbackPolicySchema.safeParse(policy({ auth: { ...oauthAuth, extensions }, destination })).success;
    expect(parse({ audience: 'x' })).toBe(false);
    expect(parse({ grant_type: 'x' })).toBe(false);
    expect(parse({ 'Bad Name': 'x' })).toBe(false);
    expect(parse({ server_specific: 'ok' })).toBe(true);
    const tooMany: Record<string, string> = {};
    for (let index = 0; index < 9; index += 1) tooMany[`ext_${index}`] = 'v';
    expect(parse(tooMany)).toBe(false);
  });

  it('rejects non-secret additional headers that collide with reserved names', () => {
    const withHeader = { ...oauthAuth, additionalHeaders: [{ name: 'content-type', value: 'application/json' }] };
    expect(OAuth2ClientCredentialsAuthSchema.safeParse(withHeader).success).toBe(true);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ auth: withHeader, destination })).success).toBe(false);
    const withSafeHeader = { ...oauthAuth, additionalHeaders: [{ name: 'x-tenant', value: 'acme' }] };
    expect(ProfileCallbackPolicySchema.safeParse(policy({ auth: withSafeHeader, destination })).success).toBe(true);
  });
});

describe('CB-01 policy mode and destination rules', () => {
  it('freezes both modes and rejects unknown modes', () => {
    expect(ProfileCallbackPolicySchema.safeParse(policy({ mode: 'notification_only' })).success).toBe(true);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ mode: 'notification_with_result' })).success).toBe(true);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ mode: 'notification_and_something' })).success).toBe(false);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ extra: true })).success).toBe(false);
  });

  it('requires approved destinations for every credential-bearing auth', () => {
    expect(ProfileCallbackPolicySchema.safeParse(policy({ auth: headersAuth })).success).toBe(false);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ auth: headersAuth, destination })).success).toBe(true);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ auth: oauthAuth, destination })).success).toBe(true);
    expect(ProfileCallbackPolicySchema.safeParse(policy({ auth: noneAuth, destination: null })).success).toBe(true);
  });

  it('rejects approved origins carrying path/query/userinfo', () => {
    expect(
      ProfileCallbackPolicySchema.safeParse(
        policy({ auth: headersAuth, destination: { approvedOrigins: ['https://hooks.example.com/path'] } }),
      ).success,
    ).toBe(false);
    expect(
      ProfileCallbackPolicySchema.safeParse(
        policy({ auth: headersAuth, destination: { approvedOrigins: ['https://user:pass@hooks.example.com'] } }),
      ).success,
    ).toBe(false);
    expect(
      ProfileCallbackPolicySchema.safeParse(
        policy({ auth: headersAuth, destination: { approvedOrigins: ['http://hooks.example.com'] } }),
      ).success,
    ).toBe(false);
  });

  it('refuses credential exfiltration to unapproved or private destinations', () => {
    expect(authorizeCallbackDestination('https://attacker.example.net/x', headersAuth, destination).kind).toBe('DENIED');
    expect(authorizeCallbackDestination('https://hooks.example.com/other', headersAuth, destination).kind).toBe('DENIED');
    expect(authorizeCallbackDestination('https://hooks.example.com/du/ok', headersAuth, destination).kind).toBe('ALLOWED');
    expect(authorizeCallbackDestination('https://hooks.example.com/x', headersAuth, undefined).kind).toBe('DENIED');
    // Credential-bearing auth never downgrades to http.
    expect(authorizeCallbackDestination('http://hooks.example.com/du/ok', headersAuth, destination).kind).toBe('DENIED');
    // Private/loopback/metadata targets are denied even with auth none.
    for (const url of ['http://127.0.0.1/hook', 'http://169.254.169.254/hook', 'http://[::1]/hook']) {
      expect(authorizeCallbackDestination(url, noneAuth, undefined).kind).toBe('DENIED');
    }
    expect(authorizeCallbackDestination('https://hooks.example.com/x', noneAuth, undefined).kind).toBe('ALLOWED');
    expect(CALLBACK_REDIRECTS_ALLOWED).toBe(false);
  });
});

describe('CB-01 result projection bounds and expiry', () => {
  const descriptor = {
    artifactId: '11111111-1111-4111-8111-111111111111',
    role: 'output',
    sizeBytes: 1234,
    download: { path: '/api/v1/artifacts/11111111-1111-4111-8111-111111111111/download', expiresAt: '2026-10-07T00:00:00.000Z' },
  };
  const envelope = (overrides: Record<string, unknown> = {}): unknown => ({
    projectionVersion: '1',
    eventType: 'operation.succeeded',
    operationId: '22222222-2222-4222-8222-222222222222',
    state: 'SUCCEEDED',
    occurredAt: '2026-10-06T00:00:00.000Z',
    result: { answer: 42 },
    artifacts: [descriptor],
    ...overrides,
  });

  it('accepts a result envelope and enforces the inline size bound', () => {
    expect(CallbackResultEnvelopeSchema.safeParse(envelope()).success).toBe(true);
    expect(callbackInlineResultWithinBound(CALLBACK_MAX_INLINE_RESULT_BYTES)).toBe(true);
    expect(callbackInlineResultWithinBound(CALLBACK_MAX_INLINE_RESULT_BYTES + 1)).toBe(false);
    expect(callbackInlineResultWithinBound(-1)).toBe(false);
  });

  it('requires an explicit omission reason when inline result is withheld', () => {
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ result: null })).success).toBe(false);
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ result: null, resultOmitted: 'OVERSIZED' })).success).toBe(true);
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ result: null, resultOmitted: 'EXPIRED' })).success).toBe(true);
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ result: null, resultOmitted: 'TRUNCATED' })).success).toBe(false);
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ resultOmitted: 'UNAVAILABLE' })).success).toBe(false);
  });

  it('keeps artifacts as authenticated references only: relative path, expiry, no bytes/raw URLs', () => {
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ artifacts: [] })).success).toBe(true);
    expect(
      CallbackResultEnvelopeSchema.safeParse(
        envelope({ artifacts: [{ ...descriptor, download: { ...descriptor.download, path: 'https://s3.example.com/raw' } }] }),
      ).success,
    ).toBe(false);
    expect(
      CallbackResultEnvelopeSchema.safeParse(envelope({ artifacts: [{ ...descriptor, bytes: 'AAAA' }] })).success,
    ).toBe(false);
    expect(
      CallbackResultEnvelopeSchema.safeParse(
        envelope({ artifacts: [{ ...descriptor, download: { path: descriptor.download.path } }] }),
      ).success,
    ).toBe(false);
    const tooMany = Array.from({ length: CALLBACK_MAX_ARTIFACT_DESCRIPTORS + 1 }, () => descriptor);
    expect(CallbackResultEnvelopeSchema.safeParse(envelope({ artifacts: tooMany })).success).toBe(false);
  });
});

describe('CB-01 precedence and admission snapshot', () => {
  const profileDefault = ProfileCallbackPolicySchema.parse(policy({ mode: 'notification_only' }));
  const endpointPolicy = ProfileCallbackPolicySchema.parse(
    policy({ mode: 'notification_with_result', auth: headersAuth, destination }),
  );

  it('endpoint overrides profile default; absent policy keeps legacy behavior', () => {
    expect(resolveEffectiveCallbackPolicy({ endpointPolicy, profileDefault })).toEqual(endpointPolicy);
    expect(resolveEffectiveCallbackPolicy({ profileDefault })).toEqual(profileDefault);
    expect(resolveEffectiveCallbackPolicy({})).toBeNull();
    expect(resolveEffectiveCallbackPolicy({ endpointPolicy: null, profileDefault: null })).toBeNull();
  });

  it('pins tenant/profile/endpoint/revision with the frozen policy', () => {
    const snapshot = {
      tenantId: '33333333-3333-4333-8333-333333333333',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      profileName: 'extraction-default',
      endpointKey: 'extract',
      profileRevision: 7,
      policy: endpointPolicy,
    };
    expect(ProfileCallbackPolicySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(ProfileCallbackPolicySnapshotSchema.safeParse({ ...snapshot, profileRevision: 0 }).success).toBe(false);
    expect(ProfileCallbackPolicySnapshotSchema.safeParse({ ...snapshot, tenantId: 'tenant-a' }).success).toBe(false);
    expect(ProfileCallbackPolicySnapshotSchema.safeParse({ ...snapshot, policy: { version: 1, mode: 'notification_only' } }).success).toBe(false);
  });
});

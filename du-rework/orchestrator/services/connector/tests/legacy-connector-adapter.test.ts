import { AesCredentialCipher } from '../src/services';
import {
  LegacyConnectorAdapterError,
  projectLegacyExternalApiConnection,
  type LegacyExternalApiConnectionRow,
} from '../src/db/legacy-connector-adapter';

function sourceRow(
  overrides: Partial<LegacyExternalApiConnectionRow> = {},
): LegacyExternalApiConnectionRow {
  return {
    id: 'legacy/id:one',
    name: 'Invoice lookup',
    slug: 'invoice-lookup',
    description: null,
    endpointUrl: 'https://provider.example.test/v1/invoice?mode=read',
    httpMethod: 'POST',
    authType: 'API_KEY_HEADER',
    authSecret: 'synthetic-credential-value',
    authKeyHeader: 'x-api-key',
    promptFieldName: 'query',
    fileFieldName: null,
    fileUrlFieldName: 'fileUrl',
    defaultPrompt: 'Read the invoice',
    staticFormFields: JSON.stringify([{ name: 'mode', value: 'safe' }]),
    extraHeaders: JSON.stringify({ ['x-region']: 'test' }),
    responseContentPath: 'result.content',
    sessionIdResponsePath: 'result.session',
    sessionIdFieldName: 'sessionId',
    timeoutSec: 30,
    state: 'ENABLED',
    createdAt: '2026-10-01T10:00:00',
    updatedAt: '2026-10-02T11:00:00',
    ...overrides,
  };
}

function cipher(): AesCredentialCipher {
  return new AesCredentialCipher(new Uint8Array(32).fill(7));
}

function errorFor(run: () => unknown): LegacyConnectorAdapterError {
  try {
    run();
  } catch (error) {
    if (error instanceof LegacyConnectorAdapterError) return error;
    throw error;
  }
  throw new Error('Expected the projection to stop this source row.');
}

describe('LDBA-05 legacy connector projection', () => {
  test('preserves text identity, maps all config fields, and pins revision one', () => {
    const source = sourceRow();
    const projected = projectLegacyExternalApiConnection(source, cipher());
    const config = projected.revision.config;

    expect(projected.revision.connectorId).toBe('legacy/id:one');
    expect(projected.revision.revision).toBe(1);
    expect(projected.revision.adapter).toBe('json-http');
    expect(projected.revision.state).toBe('ACTIVE');
    expect(projected.revision.tenantId).toBe('');
    expect(projected.revision.credentialSource).toEqual({
      kind: 'legacy-db',
      credentialRef: 'legacy-db:connector:legacy/id:one',
    });
    expect(projected.secretVersion.id).toBe('legacy-db:secret:legacy/id:one:1');
    expect(projected.secretVersion.credentialRef).toBe(projected.revision.credentialRef);
    expect(projected.revision.credentialRef).toBe('legacy-db:connector:legacy/id:one');
    expect(config).toMatchObject({
      name: source.name,
      slug: source.slug,
      description: source.description,
      endpointUrl: source.endpointUrl,
      httpMethod: source.httpMethod,
      authType: source.authType,
      authKeyHeader: source.authKeyHeader,
      promptFieldName: source.promptFieldName,
      fileFieldName: source.fileFieldName,
      fileUrlFieldName: source.fileUrlFieldName,
      defaultPrompt: source.defaultPrompt,
      responseContentPath: source.responseContentPath,
      sessionIdResponsePath: source.sessionIdResponsePath,
      sessionIdFieldName: source.sessionIdFieldName,
      timeoutSec: source.timeoutSec,
      baseUrl: 'https://provider.example.test',
      path: '/v1/invoice?mode=read',
      timeoutMs: 30_000,
      credentialSlot: 'header:x-api-key',
      requestMapping: { query: 'input.prompt', sessionId: 'sessionRef' },
      responseMapping: { content: 'result.content', sessionRef: 'result.session' },
    });
    expect(config.staticFormFields).toEqual([{ name: 'mode', value: 'safe' }]);
    expect(config.extraHeaders).toEqual({ ['x-region']: 'test' });
    expect(config.slug).not.toBe(projected.revision.adapter);
    expect(projected.revision.createdAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(projected.sourceUpdatedAt.toISOString()).toBe('2026-10-02T11:00:00.000Z');
  });

  test('selects multipart from a configured file field without changing connector text id', () => {
    const projected = projectLegacyExternalApiConnection(sourceRow({ fileFieldName: 'uploads' }), cipher());

    expect(projected.revision.adapter).toBe('multipart-http');
    expect(projected.revision.connectorId).toBe('legacy/id:one');
    expect(projected.revision.config.fileFieldName).toBe('uploads');
  });

  test('stores AES-GCM bytes and never puts the plaintext secret in the projection', () => {
    const source = sourceRow();
    const activeCipher = cipher();
    const projected = projectLegacyExternalApiConnection(source, activeCipher);
    const encryptedValue = Buffer.from(projected.secretVersion.encryptedValue);

    expect(encryptedValue.byteLength).toBeGreaterThanOrEqual(28);
    expect(encryptedValue).not.toEqual(Buffer.from(source.authSecret as string, 'utf8'));
    expect(activeCipher.decrypt(encryptedValue)).toBe(source.authSecret);
    expect(JSON.stringify(projected.revision.config)).not.toContain(source.authSecret as string);
    expect(projected.revision.config).not.toHaveProperty('authSecret');
  });

  test('stops before projection when the encryption key cipher is absent', () => {
    const error = errorFor(() => projectLegacyExternalApiConnection(sourceRow(), undefined));

    expect(error.code).toBe('ENCRYPTION_KEY_MISSING');
    expect(error.message).not.toContain('synthetic-credential-value');
  });

  test('stops rows with a missing secret rather than writing an empty encrypted value', () => {
    const error = errorFor(() => projectLegacyExternalApiConnection(sourceRow({ authSecret: null }), cipher()));

    expect(error.code).toBe('MISSING_SECRET');
  });

  test('maps enabled to active and reports disabled terminalization explicitly', () => {
    const disabled = projectLegacyExternalApiConnection(sourceRow({ state: 'DISABLED' }), cipher());

    expect(disabled.revision.state).toBe('RETIRED');
    expect(errorFor(() => projectLegacyExternalApiConnection(sourceRow({ state: 'UNKNOWN' }), cipher())).code)
      .toBe('UNMAPPABLE_STATE');
  });

  test('rejects methods and auth types unsupported by the current connector adapters', () => {
    expect(errorFor(() => projectLegacyExternalApiConnection(sourceRow({ httpMethod: 'GET' }), cipher())).code)
      .toBe('UNSUPPORTED_HTTP_METHOD');
    expect(errorFor(() => projectLegacyExternalApiConnection(sourceRow({ authType: 'UNKNOWN' }), cipher())).code)
      .toBe('UNSUPPORTED_AUTH_TYPE');
  });

  test('rejects malformed JSON and unsafe endpoint userinfo', () => {
    expect(errorFor(() => projectLegacyExternalApiConnection(sourceRow({ staticFormFields: '{broken' }), cipher())).code)
      .toBe('INVALID_JSON');
    expect(errorFor(() => projectLegacyExternalApiConnection(
      sourceRow({ endpointUrl: 'https://user:password@provider.example.test/v1' }),
      cipher(),
    )).code).toBe('INVALID_ENDPOINT');
  });
});

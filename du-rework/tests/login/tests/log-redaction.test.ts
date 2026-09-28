import {
  redactValue,
  redactStringScalar,
  isSensitiveField,
  truncateRedactedBody,
  assertSchema,
  findSentMatches,
  REQUIRED_SCHEMA_KEYS,
  MUST_NOT_APPEAR,
  type LogLine,
} from '../src/log-redaction';

describe('LOG-01: redaction (pure, no DB)', () => {
  test('redacts api_key, apiKey, x-api-key, x_api_key fields', () => {
    const input = {
      api_key: 'sk_live_plaintext',
      apiKey: 'ghp_plaintext',
      'x-api-key': 'AKIAIOSFODNN7EXAMPLE',
      x_api_key: 'plaintext_secret',
      label: 'visible',
    };
    const out = redactValue(input) as Record<string, unknown>;
    expect(out.api_key).toBe('[REDACTED:api_key]');
    expect(out.apiKey).toBe('[REDACTED:api_key]');
    expect(out['x-api-key']).toBe('[REDACTED:api_key]');
    expect(out.x_api_key).toBe('[REDACTED:api_key]');
    expect(out.label).toBe('visible');
  });

  test('redacts Authorization Bearer header value', () => {
    const input = { headers: { authorization: 'Bearer eyJabc123.eyJabc.def456', cookie: 'fb_secret=visible' } };
    const out = redactValue(input) as { headers: Record<string, unknown> };
    expect(out.headers.authorization).toBe('[REDACTED:bearer]');
    expect(out.headers.cookie).toBe('fb_secret=visible');
  });

  test('redacts JWT-shaped strings inside scalar values', () => {
    const input = 'received token eyJabcXYZ123.eyJabcXYZ123.eyJabcXYZ123 at line 1';
    const out = redactStringScalar(input);
    expect(out).not.toMatch(/eyJabc/);
    expect(out).toMatch(/received token \[REDACTED:jwt\] at line 1/);
  });

  test('redacts connector_credential fields (all variants)', () => {
    const input = {
      connector_secret: 'topsecret',
      connectorCredential: 'topsecret',
      connector_password: 'topsecret',
      connectorPassword: 'topsecret',
      api_secret: 'topsecret',
      apiSecret: 'topsecret',
      client_secret: 'topsecret',
      clientSecret: 'topsecret',
      webhook_secret: 'topsecret',
      webhookSecret: 'topsecret',
    };
    const out = redactValue(input) as Record<string, unknown>;
    for (const k of Object.keys(input)) {
      expect(out[k]).toBe('[REDACTED:connector_credential]');
    }
  });

  test('redacts webhook signature headers', () => {
    const input = {
      'X-DU-Signature': 'sha256=deadbeef',
      'x-du-signature': 'sha256=deadbeef',
      'X-Hub-Signature-256': 'sha256=deadbeef',
      'x-hub-signature-256': 'sha256=deadbeef',
    };
    const out = redactValue(input) as Record<string, unknown>;
    for (const k of Object.keys(input)) {
      expect(out[k]).toBe('[REDACTED:webhook_signature]');
    }
  });

  test('redacts signed URLs with signature=, sig=, X-Amz-Signature=, X-Amz-Credential=', () => {
    const input = {
      a: 'https://example.com/blob?signature=abc',
      b: 'https://example.com/blob?sig=abc',
      c: 'https://s3.amazonaws.com/x?X-Amz-Signature=abc',
      d: 'https://s3.amazonaws.com/x?X-Amz-Credential=abc',
      plain: 'https://example.com/health',
    };
    const out = redactValue(input) as Record<string, unknown>;
    expect(out.a).toBe('[REDACTED:signed_url]');
    expect(out.b).toBe('[REDACTED:signed_url]');
    expect(out.c).toBe('[REDACTED:signed_url]');
    expect(out.d).toBe('[REDACTED:signed_url]');
    expect(out.plain).toBe('https://example.com/health');
  });

  test('redacts raw artifact bytes (Buffer)', () => {
    const buf = Buffer.from('hello world payload');
    const input = { body: buf, plain: 'visible' };
    const out = redactValue(input) as { body: string; plain: string };
    expect(out.body).toBe(`[REDACTED:bytes:${buf.byteLength}]`);
    expect(out.plain).toBe('visible');
  });

  test('redacts base64-shaped strings >= 256 chars in JSON fields', () => {
    const b64 = 'A'.repeat(512);
    const input = { payload: b64, short: 'A'.repeat(100), nonb64: 'has spaces and {"json":true}' };
    const out = redactValue(input) as Record<string, unknown>;
    expect(out.payload).toBe(`[REDACTED:bytes:${Buffer.byteLength(b64, 'utf8')}]`);
    expect(out.short).toBe('A'.repeat(100));
    expect(out.nonb64).toBe('has spaces and {"json":true}');
  });

  test('handles nested objects up to depth 6', () => {
    const nested: Record<string, unknown> = { api_key: 'sk_live_AAAA', child: null };
    let cur: Record<string, unknown> = nested;
    for (let i = 0; i < 5; i++) {
      const inner: Record<string, unknown> = { api_key: 'sk_live_AAAA', child: null };
      cur.child = inner;
      cur = inner;
    }
    const out = redactValue(nested) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('sk_live_AAAA');
  });

  test('truncates at depth > 6 instead of recursing', () => {
    let cur: unknown = 'leaf';
    for (let i = 0; i < 10; i++) cur = { child: cur };
    const out = redactValue(cur) as unknown;
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('[REDACTED:depth>6]');
  });

  test('handles cycles without infinite recursion', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    const out = redactValue(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(JSON.stringify(out)).not.toContain('cyclic');
  });

  test('handles arrays (recursive)', () => {
    const input = { items: [{ api_key: 'sk_live_AAA' }, { plain: 'ok' }] };
    const out = redactValue(input) as { items: Array<Record<string, unknown>> };
    expect(out.items[0].api_key).toBe('[REDACTED:api_key]');
    expect(out.items[1].plain).toBe('ok');
  });

  test('isSensitiveField covers every sentinel field', () => {
    const all = [
      'api_key', 'apiKey', 'x-api-key', 'x_api_key',
      'authorization', 'Authorization',
      'jwt', 'token',
      'connector_secret', 'connectorCredential', 'connector_password', 'connectorPassword',
      'api_secret', 'apiSecret', 'client_secret', 'clientSecret',
      'webhook_secret', 'webhookSecret',
      'X-DU-Signature', 'x-du-signature', 'X-Hub-Signature-256', 'x-hub-signature-256',
      'vault_path', 'vaultPath',
      'webhook_payload', 'webhookPayload',
    ];
    for (const f of all) expect(isSensitiveField(f)).toBe(true);
    for (const f of ['name', 'id', 'count', 'visible', 'tenant_id_present']) expect(isSensitiveField(f)).toBe(false);
  });

  test('redacts vault_path field', () => {
    const out = redactValue({ vault_path: 'vault:du/api/prod/secret', name: 'visible' }) as Record<string, unknown>;
    expect(out.vault_path).toBe('[REDACTED:vault_path]');
    expect(out.name).toBe('visible');
  });

  test('redacts webhook_payload field', () => {
    const out = redactValue({ webhook_payload: { secret: 'sk_live_AAA', user: 'u' } }) as { webhook_payload: unknown };
    expect(out.webhook_payload).toBe('[REDACTED:webhook_payload]');
  });

  test('truncateRedactedBody caps at maxBytes AFTER redaction', () => {
    // Build a large redacted body — nested array of objects, none sensitive,
    // so redaction passes them through verbatim. Then the serialized form is
    // larger than maxBytes, exercising the truncate path.
    const items = Array.from({ length: 200 }, (_, i) => ({ idx: i, label: 'visible'.repeat(8) }));
    const big = { items, api_key: 'sk_live_AAA' };
    const redacted = redactValue(big);
    const truncated = truncateRedactedBody(redacted, 1024);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(1024);
    expect(truncated).not.toContain('sk_live_AAA');
    const parsed = JSON.parse(truncated) as { __truncated__?: boolean; bytes?: number; prefix?: string };
    expect(parsed.__truncated__).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(1024);
  });
});

describe('LOG-01: schema shape conformance', () => {
  test('every required key is present in the spec list', () => {
    expect(new Set(REQUIRED_SCHEMA_KEYS)).toEqual(
      new Set(['ts', 'level', 'service', 'version', 'environment', 'message'])
    );
  });

  test('assertSchema accepts a valid line', () => {
    const line: LogLine = {
      ts: '2026-09-24T07:14:14.931Z',
      level: 'info',
      service: 'orchestrator',
      version: '0.1.0',
      environment: 'prod',
      message: 'http request',
      correlation_id: '11111111-1111-4111-8111-111111111111',
      request_id: '22222222-2222-4222-8222-222222222222',
      tenant_id: '33333333-3333-4333-8333-333333333333',
      duration_ms: 42,
      exit_code: 200,
    };
    expect(() => assertSchema(line)).not.toThrow();
  });

  test('assertSchema rejects missing required key', () => {
    const bad = { ts: '2026-09-24T07:14:14.931Z', level: 'info', service: 'x', version: '0.0.0', environment: 'prod' };
    expect(() => assertSchema(bad as unknown)).toThrow(/missing required key: message/);
  });

  test('assertSchema rejects non-UTC ts', () => {
    const bad = { ts: '2026-09-24T07:14:14.931+07:00', level: 'info', service: 'x', version: '0.0.0', environment: 'prod', message: 'x' };
    expect(() => assertSchema(bad as unknown)).toThrow(/not ISO 8601 UTC/);
  });

  test('assertSchema rejects unknown level', () => {
    const bad = { ts: '2026-09-24T07:14:14.931Z', level: 'verbose', service: 'x', version: '0.0.0', environment: 'prod', message: 'x' };
    expect(() => assertSchema(bad as unknown)).toThrow(/level invalid/);
  });

  test('assertSchema rejects unknown environment', () => {
    const bad = { ts: '2026-09-24T07:14:14.931Z', level: 'info', service: 'x', version: '0.0.0', environment: 'uat', message: 'x' };
    expect(() => assertSchema(bad as unknown)).toThrow(/environment invalid/);
  });
});

describe('LOG-01: sentinel / must-not-appear list', () => {
  test('MUST_NOT_APPEAR covers every cross-lane sentinel pattern', () => {
    expect(MUST_NOT_APPEAR.length).toBeGreaterThanOrEqual(7);
  });

  test('findSentMatches detects Stripe / Slack / GitHub / AWS / JWT / Vault / PEM', () => {
    const cases = [
      { input: 'leaked ' + 'sk_live_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', expect: 'api_key_prefix' },
      { input: 'leaked xoxb-1234567890-abcdef', expect: 'slack_token' },
      { input: 'leaked ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', expect: 'github_token' },
      { input: 'leaked AKIAIOSFODNN7EXAMPLE', expect: 'aws_access_key' },
      { input: 'leaked eyJabc.eyJxyz.sigSigSig', expect: 'jwt' },
      { input: 'leaked hvs.ABCDEFGHIJKLMNOPQRSTUV', expect: 'vault_token' },
      { input: '-----BEGIN RSA PRIVATE KEY-----', expect: 'private_key_block' },
    ];
    for (const c of cases) {
      const hits = findSentMatches(c.input);
      expect(hits.some((h) => h.startsWith(c.expect + ':'))).toBe(true);
    }
  });

  test('findSentMatches returns empty for benign log content', () => {
    expect(findSentMatches('http request 200 ok in 42ms')).toEqual([]);
  });
});

describe('LOG-01: combined HTTP request redaction (representative)', () => {
  test('admin POST /api-keys with raw payload is fully redacted', () => {
    const req = {
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      headers: {
        authorization: 'Bearer eyJabc.eyJdef.sigGhi',
        'x-api-key': 'plaintext-admin-key',
        cookie: 'session=visible',
      },
      body: {
        label: 'default_key',
        grants: [
          { businessId: 'b1', businessVersion: '1', action: 'ingest' },
        ],
      },
    };
    const out = redactValue(req) as Record<string, unknown>;
    const headers = out.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[REDACTED:bearer]');
    expect(headers['x-api-key']).toBe('[REDACTED:api_key]');
    expect(headers.cookie).toBe('session=visible');
    expect(JSON.stringify(out)).not.toMatch(/plaintext-admin-key/);
    expect(JSON.stringify(out)).not.toMatch(/eyJabc/);
    expect(out.method).toBe('POST');
    expect(out.url).toBe('/api/v1/admin/api-keys');
  });

  test('admin error with raw exception detail is redacted', () => {
    const sk = 'sk_live_' + 'ABCDEFGHIJKLMNOPQRSTUVWX';
    const err = {
      kind: 'HTTP_BAD_BEARER',
      message: 'received token ' + sk + ' at header',
      detail: 'at request line POST /admin/api-keys with api_key=' + sk,
    };
    const out = redactValue(err) as Record<string, unknown>;
    expect(out.kind).toBe('HTTP_BAD_BEARER');
    expect(JSON.stringify(out)).not.toContain(sk);
  });
});
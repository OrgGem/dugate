import { sanitizeProviderTestResult } from '../src/services';

describe('admin provider-test content sanitization', () => {
  test('redacts the resolved credential, config secrets, and every outbound header value before persistence', () => {
    const result = sanitizeProviderTestResult(
      { content: 'ordinary text; answer: bearer-secret-value, header-key-value, static-header-value', providerStatusCode: 200 },
      'bearer-secret-value',
      { request: { authorization: 'header-key-value' }, prompt: 'ordinary text' },
      { authorization: 'Bearer bearer-secret-value', 'x-custom': 'static-header-value' },
    );

    expect(result).toMatchObject({
      content: 'ordinary text; answer: [REDACTED], [REDACTED], [REDACTED]',
      providerTestContentSanitized: true,
      providerTestContentTruncated: false,
    });
    expect(JSON.stringify(result)).not.toContain('bearer-secret-value');
    expect(JSON.stringify(result)).not.toContain('header-key-value');
    expect(JSON.stringify(result)).not.toContain('static-header-value');
    expect(JSON.stringify(result)).toContain('ordinary text');
  });

  test('withholds content when the secret/config redaction set cannot be bounded', () => {
    const result = sanitizeProviderTestResult(
      { content: 'possibly sensitive output' },
      'credential-secret',
      { authorization: 'x' },
    );
    expect(result.content).toBeUndefined();
    expect(result.providerTestContentSanitized).toBe(true);
    expect(result.providerTestContentTruncated).toBe(true);
  });

  test('truncates only after exact-value redaction and records that fact', () => {
    const result = sanitizeProviderTestResult(
      { content: `key=${'x'.repeat(16_500)}; safe` },
      'credential-secret',
      {},
    );
    expect(result.content).toHaveLength(16_384);
    expect(result.providerTestContentTruncated).toBe(true);
  });
});

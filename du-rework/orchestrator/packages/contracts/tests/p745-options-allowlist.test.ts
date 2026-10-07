import { InvocationOptionsSchema } from '../src';

/**
 * P745-CONNECTOR-PASSTHROUGH (T5): InvocationOptionsSchema is an explicit,
 * closed allowlist. The typed keys (temperature/model/maxTokens) plus the two
 * connector passthrough keys the business layer really sends
 * (responseFormat/jsonSchema) parse; anything else is rejected so an unknown
 * key can never reach a provider body or the canonical invocation hash.
 */
describe('connector invocation options allowlist (P745/T5)', () => {
  const allowed = {
    temperature: 0.25,
    model: 'provider-model-1',
    maxTokens: 512,
    responseFormat: 'json',
    jsonSchema: { type: 'object', required: ['total'] },
  };

  test('accepts the full allowed set and returns it verbatim', () => {
    expect(InvocationOptionsSchema.parse(allowed)).toEqual(allowed);
  });

  test.each([
    ['responseFormat json', { responseFormat: 'json' }],
    ['responseFormat text', { responseFormat: 'text' }],
    ['jsonSchema record', { jsonSchema: { type: 'object' } }],
  ])('accepts the living passthrough key %s', (_caseName, options) => {
    expect(InvocationOptionsSchema.safeParse(options).success).toBe(true);
  });

  test('accepts an empty options object', () => {
    expect(InvocationOptionsSchema.safeParse({}).success).toBe(true);
  });

  test.each(['json_object', 'yaml', '', 42])('rejects responseFormat outside json|text (%p)', (responseFormat) => {
    expect(InvocationOptionsSchema.safeParse({ responseFormat }).success).toBe(false);
  });

  test.each([
    ['array value', []],
    ['null value', null],
    ['string value', '{"type":"object"}'],
  ])('rejects a non-record jsonSchema (%s)', (_caseName, jsonSchema) => {
    expect(InvocationOptionsSchema.safeParse({ jsonSchema }).success).toBe(false);
  });

  test.each([
    ['unknown third key', { responseFormat: 'json', unexpectedOption: true }],
    ['systemPrompt (declared in the business options type, never sent on the wire)', { systemPrompt: 'x' }],
    ['smuggled credential', { apiKey: 'sk-live' }],
  ])('rejects %s instead of extending the provider payload', (_caseName, options) => {
    expect(InvocationOptionsSchema.safeParse(options).success).toBe(false);
  });

  test.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the prototype-pollution key %s without polluting Object.prototype',
    (key) => {
      const options = Object.fromEntries([
        ...Object.entries({ responseFormat: 'json' }),
        [key, { polluted: true }],
      ]);

      expect(InvocationOptionsSchema.safeParse(options).success).toBe(false);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    },
  );
});

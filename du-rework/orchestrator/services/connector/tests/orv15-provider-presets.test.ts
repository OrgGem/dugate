import { createTypedRecipeAdapter } from '../src/adapters/recipe';
import type { LocalInvocationRequest } from '../src/types';
import { createProviderRecipePreset, detectProviderPreset } from '../../../apps/admin-web/src/features/connectors/provider-presets';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function invocation(): LocalInvocationRequest {
  return {
    contractVersion: '1',
    invocationId: 'provider-preset-test',
    tenantId: TENANT,
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
    taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
    stepKey: 'generate',
    bindingSlot: 'reasoning',
    input: { prompt: 'Summarize this document.' },
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
  };
}

describe('admin provider presets compile to real typed provider requests', () => {
  test('OpenAI chat preset supplies model, user message, bearer credential and response paths', () => {
    const recipe = createProviderRecipePreset('openai', 'gpt-test');
    expect(detectProviderPreset(recipe)).toBe('openai');
    const request = createTypedRecipeAdapter(recipe, 'openai-secret').adapter.buildRequest(invocation(), {
      baseUrl: 'https://api.openai.com', path: '/v1/chat/completions', timeoutMs: 5_000,
    });
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer openai-secret', 'content-type': 'application/json' });
    expect(JSON.parse(String(request.body))).toEqual({
      messages: [{ content: 'Summarize this document.', role: 'user' }],
      model: 'gpt-test',
    });
    expect(createTypedRecipeAdapter(recipe, 'openai-secret').adapter.normalizeResponse({
      status: 200,
      body: { choices: [{ message: { content: 'Summary.' } }], model: 'gpt-test', usage: { prompt_tokens: 9, completion_tokens: 3 } },
    }, { baseUrl: 'https://api.openai.com', path: '/v1/chat/completions', timeoutMs: 5_000 }))
      .toMatchObject({ content: 'Summary.', usage: { inputTokens: 9, outputTokens: 3, model: 'gpt-test' } });
  });

  test('Anthropic Messages preset injects x-api-key as a credential and sends the required message fields', () => {
    const recipe = createProviderRecipePreset('anthropic', 'claude-test');
    expect(detectProviderPreset(recipe)).toBe('anthropic');
    const request = createTypedRecipeAdapter(recipe, 'anthropic-secret').adapter.buildRequest(invocation(), {
      baseUrl: 'https://api.anthropic.com', path: '/v1/messages', timeoutMs: 5_000,
    });
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers).toMatchObject({ 'x-api-key': 'anthropic-secret', 'anthropic-version': '2023-06-01' });
    expect(JSON.parse(String(request.body))).toEqual({
      messages: [{ content: 'Summarize this document.', role: 'user' }],
      model: 'claude-test',
      max_tokens: 1024,
    });
    expect(createTypedRecipeAdapter(recipe, 'anthropic-secret').adapter.normalizeResponse({
      status: 200,
      body: { content: [{ text: 'Summary.' }], model: 'claude-test', usage: { input_tokens: 9, output_tokens: 3 } },
    }, { baseUrl: 'https://api.anthropic.com', path: '/v1/messages', timeoutMs: 5_000 }))
      .toMatchObject({ content: 'Summary.', usage: { inputTokens: 9, outputTokens: 3, model: 'claude-test' } });
  });

  test('Gemini preset substitutes the model path and sends contents as Content.parts', () => {
    const recipe = createProviderRecipePreset('gemini', 'gemini-test');
    expect(detectProviderPreset(recipe)).toBe('gemini');
    const request = createTypedRecipeAdapter(recipe, 'gemini-secret').adapter.buildRequest(invocation(), {
      baseUrl: 'https://generativelanguage.googleapis.com', path: '/v1beta/models/gemini-test:generateContent', timeoutMs: 5_000,
    });
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(request.headers).toMatchObject({ 'x-goog-api-key': 'gemini-secret', 'content-type': 'application/json' });
    expect(JSON.parse(String(request.body))).toEqual({
      contents: [{ parts: [{ text: 'Summarize this document.' }] }],
    });
    expect(createTypedRecipeAdapter(recipe, 'gemini-secret').adapter.normalizeResponse({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: 'Summary.' }] } }],
        modelVersion: 'gemini-test',
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 },
      },
    }, { baseUrl: 'https://generativelanguage.googleapis.com', path: '/v1beta/models/gemini-test:generateContent', timeoutMs: 5_000 }))
      .toMatchObject({ content: 'Summary.', usage: { inputTokens: 9, outputTokens: 3, model: 'gemini-test' } });
  });
});

import { ConnectorRecipeSchema, type ConnectorRecipe } from '@du/contracts';

export type ProviderPreset = 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'custom';

const BASE = {
  method: 'POST' as const,
  timeoutMs: 30_000,
  responseBytes: 262_144,
  session: { capture: [], inject: [] },
};

/** Build a strict recipe for the provider's standard text-generation API. */
export function createProviderRecipePreset(provider: Exclude<ProviderPreset, 'custom'>, model = ''): ConnectorRecipe {
  const defaultModel = model.trim() || undefined;
  const recipe: ConnectorRecipe = provider === 'openai'
    ? {
      ...BASE,
      adapter: 'openai-compatible',
      endpointUrl: 'https://api.openai.com/v1/chat/completions',
      ...(defaultModel ? { defaultModel } : {}),
      auth: { kind: 'bearer', secretSlot: 'api-key' },
      headers: [],
      request: {
        promptField: 'messages[0].content',
        modelField: 'model',
        fields: [{ name: 'messages.0.role', source: 'static', value: 'user' }],
      },
      response: {
        contentPath: 'choices[0].message.content',
        modelPath: 'model',
        inputTokensPath: 'usage.prompt_tokens',
        outputTokensPath: 'usage.completion_tokens',
      },
    }
    : provider === 'anthropic'
      ? {
        ...BASE,
        adapter: 'json-http',
        endpointUrl: 'https://api.anthropic.com/v1/messages',
        ...(defaultModel ? { defaultModel } : {}),
        auth: { kind: 'api-key-header', headerName: 'x-api-key', secretSlot: 'api-key' },
        headers: [{ name: 'anthropic-version', value: '2023-06-01' }],
        request: {
          promptField: 'messages[0].content',
          modelField: 'model',
          fields: [
            { name: 'messages.0.role', source: 'static', value: 'user' },
            { name: 'max_tokens', source: 'static', value: 1024 },
          ],
        },
        response: {
          contentPath: 'content[0].text',
          modelPath: 'model',
          inputTokensPath: 'usage.input_tokens',
          outputTokensPath: 'usage.output_tokens',
        },
      }
      : provider === 'gemini'
        ? {
          ...BASE,
          adapter: 'gemini',
          endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
          ...(defaultModel ? { defaultModel } : {}),
          auth: { kind: 'api-key-header', headerName: 'x-goog-api-key', secretSlot: 'api-key' },
          headers: [],
          request: {
            promptField: 'contents[0].parts[0].text',
            fields: [],
          },
          response: {
            contentPath: 'candidates[0].content.parts[0].text',
            modelPath: 'modelVersion',
            inputTokensPath: 'usageMetadata.promptTokenCount',
            outputTokensPath: 'usageMetadata.candidatesTokenCount',
          },
        }
        : {
          ...BASE,
          adapter: 'openai-compatible',
          endpointUrl: 'https://api.example.invalid/v1/chat/completions',
          ...(defaultModel ? { defaultModel } : {}),
          auth: { kind: 'bearer', secretSlot: 'api-key' },
          headers: [],
          request: {
            promptField: 'messages[0].content',
            modelField: 'model',
          fields: [{ name: 'messages.0.role', source: 'static', value: 'user' }],
          },
          response: {
            contentPath: 'choices[0].message.content',
            modelPath: 'model',
            inputTokensPath: 'usage.prompt_tokens',
            outputTokensPath: 'usage.completion_tokens',
          },
        };
  return ConnectorRecipeSchema.parse(recipe);
}

export function detectProviderPreset(recipe: ConnectorRecipe): ProviderPreset {
  let hostname = '';
  try { hostname = new URL(recipe.endpointUrl).hostname.toLowerCase(); } catch { /* custom endpoint */ }
  if (recipe.adapter === 'gemini') return 'gemini';
  if (hostname === 'api.anthropic.com') return 'anthropic';
  if (recipe.adapter === 'openai-compatible' && hostname === 'api.openai.com') return 'openai';
  if (recipe.adapter === 'openai-compatible') return 'openai-compatible';
  return 'custom';
}

export function withDefaultProviderModel(recipe: ConnectorRecipe, model: string): ConnectorRecipe {
  const normalized = model.trim();
  const { defaultModel: _previous, ...withoutDefault } = recipe;
  return ConnectorRecipeSchema.parse(normalized ? { ...recipe, defaultModel: normalized } : withoutDefault);
}

import { createHash } from 'node:crypto';
import { canonicalize, type ConnectorRecipe, type ConnectorWorkflowOverrides } from '@du/contracts';
import { ConnectorError } from '../errors';
import { decodeVerifiedArtifact } from '../artifact-content';
import type {
  LocalInvocationRequest,
  NormalizedProviderResult,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ConnectorErrorCode,
} from '../types';

const FORBIDDEN_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
  'keep-alive', 'proxy-connection', 'expect', 'via', 'origin', 'referer', 'idempotency-key',
  'forwarded', 'x-goog-api-key', 'x-auth-token', 'x-tenant-id',
]);
const SAFE_PATH = /^[A-Za-z0-9_$.[\]-]+$/;

export interface TypedRecipeAdapter {
  adapter: ProviderAdapter;
  /** Safe-to-use provider header snapshot; used for test-result redaction. */
  providerHeaders: Readonly<Record<string, string>>;
}

/** Build one adapter for one decrypted immutable recipe revision. */
export function createTypedRecipeAdapter(
  recipe: ConnectorRecipe,
  secret: string | undefined,
  overrides?: ConnectorWorkflowOverrides,
): TypedRecipeAdapter {
  const endpoint = checkedEndpoint(recipe.endpointUrl);
  if (recipe.session.capture.length > 0 || recipe.session.inject.length > 0) {
    throw new ConnectorError('CAPABILITY_UNSUPPORTED', 'Typed recipe session capture/injection is not supported by this runtime.');
  }
  if (recipe.adapter === 'multipart-http' && recipe.headers.some((header) => header.name.toLowerCase() === 'content-type')) {
    throw unsupportedRecipe();
  }
  const headerValues = new Map<string, { name: string; value: string }>();
  for (const header of recipe.headers) {
    const lower = header.name.toLowerCase();
    if (forbiddenHeaderName(lower)) throw unsupportedRecipe();
    headerValues.set(lower, { name: header.name, value: header.value });
  }
  if (overrides) {
    verifyWorkflowOverrides(recipe, overrides);
    for (const header of overrides.extraHeaders) {
      const lower = header.name.toLowerCase();
      if (forbiddenHeaderName(lower) || !headerValues.has(lower)) throw unsupportedRecipe();
      headerValues.set(lower, { name: headerValues.get(lower)!.name, value: header.value });
    }
  }
  addCredentialHeader(recipe, secret, headerValues);
  const providerHeaders = Object.fromEntries([...headerValues.values()].map(({ name, value }) => [name, value]));
  const adapter: ProviderAdapter = {
    id: recipe.adapter,
    mode: recipe.adapter === 'multipart-http' ? 'multipart' : 'json',
    // The generic typed-recipe contract does not assert provider-side
    // idempotency replay support. The shared invoke path therefore rejects
    // 202 unless an explicit legacy config capability also opts in.
    asyncPollingMode: 'idempotency-key-replay',
    buildRequest(request): ProviderRequest {
      const body = buildBody(recipe, request, overrides);
      const headers = { ...providerHeaders };
      const isMultipart = recipe.adapter === 'multipart-http';
      if (!isMultipart) headers['content-type'] = 'application/json';
      if (isMultipart) {
        const form = new FormData();
        const artifacts = request.input.artifacts ?? [];
        for (const artifact of artifacts) {
          const bytes = decodeVerifiedArtifact(artifact);
          form.append(recipe.request.fileField!, new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }), artifact.fileName);
          if (recipe.request.fileNameField) form.append(recipe.request.fileNameField, artifact.fileName);
        }
        for (const [name, value] of Object.entries(body)) {
          if (name === recipe.request.fileField || value === undefined) continue;
          if (value !== null && typeof value === 'object') form.append(name, JSON.stringify(value));
          else form.append(name, String(value));
        }
        return { url: endpoint.toString(), method: recipe.method, headers, body: form };
      }
      if ((request.input.artifacts?.length ?? 0) > 0 && recipe.request.fileField) {
        body[recipe.request.fileField] = request.input.artifacts!.map((artifact) => {
          decodeVerifiedArtifact(artifact);
          return artifact;
        });
      }
      return { url: endpoint.toString(), method: recipe.method, headers, body: JSON.stringify(body) };
    },
    normalizeResponse(response: ProviderResponse): NormalizedProviderResult {
      if (response.status >= 400) {
        throw new ConnectorError(classifyStatus(response.status), 'Provider rejected the Connector recipe request.');
      }
      if (response.body === null || typeof response.body !== 'object' || Array.isArray(response.body)) {
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response did not match the Connector recipe.');
      }
      if (Buffer.byteLength(JSON.stringify(response.body), 'utf8') > recipe.responseBytes) {
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response exceeded the pinned recipe limit.');
      }
      const body = response.body as Record<string, unknown>;
      if (recipe.response.errorPath && readSafePath(body, recipe.response.errorPath) !== undefined) {
        throw new ConnectorError('PROVIDER_REQUEST_REJECTED', 'Provider reported a request error.');
      }
      const content = readSafePath(body, recipe.response.contentPath);
      if (typeof content !== 'string') throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response content is missing.');
      const usage = parsedUsage(body, recipe);
      const model = recipe.response.modelPath ? readSafePath(body, recipe.response.modelPath) : undefined;
      if (model !== undefined && typeof model !== 'string') throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response model is invalid.');
      const measuredUsage = usage === undefined ? undefined : {
        ...usage,
        ...(typeof model === 'string' ? { model } : {}),
        measurement: 'measured' as const,
      };
      return {
        content,
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
        providerStatusCode: response.status,
      };
    },
    classifyFailure(response: ProviderResponse | Error): ConnectorErrorCode {
      if (response instanceof Error) return 'PROVIDER_UNAVAILABLE';
      return classifyStatus(response.status);
    },
  };
  return { adapter, providerHeaders };
}

function checkedEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw unsupportedRecipe(); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw unsupportedRecipe();
  for (const name of endpoint.searchParams.keys()) {
    if (/(?:auth|token|secret|password|key|credential)/i.test(name)) throw unsupportedRecipe();
  }
  return endpoint;
}

function addCredentialHeader(
  recipe: ConnectorRecipe,
  secret: string | undefined,
  headers: Map<string, { name: string; value: string }>,
): void {
  if (recipe.auth.kind === 'none') {
    if (secret !== undefined) throw new ConnectorError('CREDENTIAL_INVALID', 'Credential pin does not match the typed recipe.');
    return;
  }
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > 16_384 || /[\r\n\u0000]/.test(secret)) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Typed recipe credential is missing or invalid.');
  }
  if (recipe.auth.kind === 'bearer') {
    headers.set('authorization', { name: 'Authorization', value: `Bearer ${secret}` });
    return;
  }
  if (recipe.auth.kind === 'api-key-header') {
    const name = recipe.auth.headerName;
    if (forbiddenHeaderName(name.toLowerCase())) throw unsupportedRecipe();
    headers.set(name.toLowerCase(), { name, value: secret });
    return;
  }
  if (recipe.auth.kind === 'basic') {
    const separator = secret.indexOf(':');
    if (separator <= 0 || separator === secret.length - 1) throw new ConnectorError('CREDENTIAL_INVALID', 'Basic credential must contain a username and password.');
    headers.set('authorization', { name: 'Authorization', value: `Basic ${Buffer.from(secret).toString('base64')}` });
    return;
  }
  // OAuth token acquisition has a separate egress/auth/cost lifecycle and is
  // deliberately not inferred from a recipe URL or credential string.
  throw new ConnectorError('CAPABILITY_UNSUPPORTED', 'This typed recipe authentication mode is not supported by the Connector runtime.');
}

function buildBody(recipe: ConnectorRecipe, request: LocalInvocationRequest, overrides?: ConnectorWorkflowOverrides): Record<string, unknown> {
  const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const reservedNames = new Set([
    recipe.request.promptField,
    recipe.request.modelField,
    recipe.request.inputField,
    recipe.request.fileField,
    recipe.request.fileNameField,
  ].filter((name): name is string => Boolean(name)));
  if (recipe.request.fields.some((field) => reservedNames.has(field.name))) throw unsupportedRecipe();
  const staticOverrides = new Map((overrides?.staticFormFields ?? []).map((field) => [field.name, field.value]));
  const prompt = request.input.prompt ?? request.input.text;
  if (prompt !== undefined) setSafePath(body, recipe.request.promptField, prompt);
  if (recipe.request.modelField && request.options?.model !== undefined) {
    setSafePath(body, recipe.request.modelField, request.options.model);
  }
  if (recipe.request.inputField && request.input.parameters !== undefined) {
    setSafePath(body, recipe.request.inputField, request.input.parameters);
  }
  for (const field of recipe.request.fields) {
    let value: unknown;
    switch (field.source) {
      case 'prompt': value = prompt; break;
      case 'input': value = readSafePath(request.input.parameters ?? {}, field.name); break;
      case 'model': value = request.options?.model; break;
      case 'static': value = staticOverrides.get(field.name) ?? field.value; break;
      case 'session': value = readSessionPath(request.sessionRef, field.sessionPath!); break;
    }
    if (value !== undefined) setSafePath(body, field.name, value);
  }
  return body;
}

function verifyWorkflowOverrides(recipe: ConnectorRecipe, value: ConnectorWorkflowOverrides): void {
  const digest = createHash('sha256').update(canonicalize(recipe)).digest('hex');
  if (value.recipeDigest !== digest) throw new ConnectorError('BINDING_DENIED', 'Workflow recipe does not match the signed Connector revision.');
  const staticNames = new Set(recipe.request.fields.filter((field) => field.source === 'static').map((field) => field.name));
  const seenStatic = new Set<string>();
  for (const field of value.staticFormFields) {
    if (!staticNames.has(field.name) || seenStatic.has(field.name)) throw new ConnectorError('BINDING_DENIED', 'Workflow recipe override is outside its signed Connector revision.');
    seenStatic.add(field.name);
  }
  const declaredHeaders = new Map(recipe.headers.map((header) => [header.name.toLowerCase(), header.name]));
  const seenHeaders = new Set<string>();
  for (const header of value.extraHeaders) {
    const lower = header.name.toLowerCase();
    if (!declaredHeaders.has(lower) || forbiddenHeaderName(lower) || seenHeaders.has(lower)) {
      throw new ConnectorError('BINDING_DENIED', 'Workflow recipe override is outside its signed Connector revision.');
    }
    seenHeaders.add(lower);
  }
}

function readSessionPath(sessionRef: string | null | undefined, path: string): unknown {
  if (!sessionRef) return undefined;
  let session: unknown;
  try { session = JSON.parse(sessionRef); } catch { return undefined; }
  return readSafePath(session, path);
}

function readSafePath(value: unknown, path: string): unknown {
  if (!SAFE_PATH.test(path)) return undefined;
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (segments.some((part) => part === '__proto__' || part === 'prototype' || part === 'constructor')) return undefined;
  return segments.reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function setSafePath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!SAFE_PATH.test(path)) throw unsupportedRecipe();
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (segments.length === 0 || segments.some((part) => part === '__proto__' || part === 'prototype' || part === 'constructor')) throw unsupportedRecipe();
  for (const segment of segments) {
    if (/^\d+$/.test(segment) && (!Number.isSafeInteger(Number(segment)) || Number(segment) > 1_024)) throw unsupportedRecipe();
  }
  let current: unknown = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const last = index === segments.length - 1;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) throw unsupportedRecipe();
      const array = current as unknown[];
      const position = Number(segment);
      if (last) { array[position] = value; return; }
      if (array[position] === undefined) array[position] = /^\d+$/.test(segments[index + 1]!) ? [] : Object.create(null);
      current = array[position];
      continue;
    }
    if (current === null || typeof current !== 'object') throw unsupportedRecipe();
    const object = current as Record<string, unknown>;
    if (last) { object[segment] = value; return; }
    if (object[segment] === undefined) object[segment] = /^\d+$/.test(segments[index + 1]!) ? [] : Object.create(null);
    current = object[segment];
  }
}

function parsedUsage(body: Record<string, unknown>, recipe: ConnectorRecipe): NormalizedProviderResult['usage'] | undefined {
  if (!recipe.response.inputTokensPath || !recipe.response.outputTokensPath) return undefined;
  const inputTokens = readSafePath(body, recipe.response.inputTokensPath);
  const outputTokens = readSafePath(body, recipe.response.outputTokensPath);
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
    || (inputTokens as number) < 0 || (outputTokens as number) < 0) {
    throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider token usage did not match the Connector recipe.');
  }
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, measurement: 'measured' };
}

function classifyStatus(status: number): ConnectorErrorCode {
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status >= 400) return 'PROVIDER_REQUEST_REJECTED';
  return 'INVALID_PROVIDER_RESPONSE';
}

function forbiddenHeaderName(name: string): boolean {
  return FORBIDDEN_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('x-forwarded-')
    || name.startsWith('x-original-') || name.startsWith('x-rewrite-')
    || name.startsWith('x-auth-') || name.startsWith('x-provider-');
}

function unsupportedRecipe(): ConnectorError {
  return new ConnectorError('CAPABILITY_UNSUPPORTED', 'Typed Connector recipe is outside the supported request boundary.');
}

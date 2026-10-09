/**
 * Narrow OpenAPI 3.0 shapes for the generated artifact `docs/21-openapi.json`.
 *
 * The Portal bundles the generated spec at build time (`?raw`) and parses it
 * once with `parseOpenApiDocument`; this module deliberately models only the
 * fields the viewer renders, so a spec change cannot silently widen behaviour
 * without a type/build review. No network fetch, no second spec source.
 */
export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

export interface OpenApiMediaType {
  schema?: unknown;
  example?: unknown;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
  headers?: Record<string, { description?: string; schema?: unknown }>;
  schema?: unknown;
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
  security?: Array<Record<string, string[]>>;
  servers?: OpenApiServer[];
  deprecated?: boolean;
  'x-api-family'?: string;
  'x-required-service-scope'?: string;
  'x-source'?: string;
}

export interface OpenApiSecurityScheme {
  type?: string;
  scheme?: string;
  in?: string;
  name?: string;
  bearerFormat?: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title?: string; version?: string; description?: string };
  servers?: OpenApiServer[];
  tags?: OpenApiTag[];
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  'x-absent'?: string[];
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OperationEntry {
  path: string;
  method: HttpMethod;
  operation: OpenApiOperation;
  family: string;
}

export type ParseResult =
  | { ok: true; doc: OpenApiDocument; entries: OperationEntry[] }
  | { ok: false; error: string };

export function familyOf(operation: OpenApiOperation): string {
  return operation['x-api-family'] ?? operation.tags?.[0] ?? 'other';
}

/**
 * Parse and minimally validate the bundled artifact. Failure is reported, not
 * thrown: the route renders an honest "spec unreadable" panel instead of a
 * partially guessed UI.
 */
export function parseOpenApiDocument(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'spec is not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'spec root is not an object' };
  }
  const doc = value as OpenApiDocument;
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    return { ok: false, error: `unsupported openapi version: ${String(doc.openapi)}` };
  }
  if (typeof doc.paths !== 'object' || doc.paths === null || Array.isArray(doc.paths)) {
    return { ok: false, error: 'spec has no paths object' };
  }
  const entries: OperationEntry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const methods = item as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const candidate = methods[method];
      if (typeof candidate !== 'object' || candidate === null) continue;
      const operation = candidate as OpenApiOperation;
      entries.push({ path, method, operation, family: familyOf(operation) });
    }
  }
  if (entries.length === 0) {
    return { ok: false, error: 'spec exposes zero operations' };
  }
  return { ok: true, doc, entries };
}

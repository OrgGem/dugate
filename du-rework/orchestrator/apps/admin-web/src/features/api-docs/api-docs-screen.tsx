import { useMemo, useState } from 'react';
import specRaw from '../../../../../../docs/21-openapi.json?raw';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  parseOpenApiDocument,
  type OpenApiDocument,
  type OpenApiMediaType,
  type OpenApiServer,
  type OperationEntry,
} from './openapi-types';

/**
 * API Reference (Swagger-style viewer) for the Orchestrator Portal.
 *
 * Source of truth: the generated `docs/21-openapi.json` artifact, imported as
 * a raw string at build time so the spec ships inside the Portal bundle and
 * loads offline from the image. There is no CDN download and no runtime
 * BFF proxy; the page performs zero requests. Try-it-out is intentionally not
 * implemented: nothing here sends a request or a credential.
 *
 * Route: /api-docs behind the Orchestrator shell mount (admin/api-docs),
 * so the server-side session gate already protects it exactly like the other
 * Portal screens. See apps/admin-web/README.md for the DU_ADMIN_WEB_ROUTES note.
 */
const SPEC_SOURCE = 'docs/21-openapi.json';
const SPEC_RAW_BYTES = new TextEncoder().encode(specRaw).length;

/**
 * Non-cryptographic FNV-1a fingerprint of the bundled spec text. It lets an
 * operator compare the spec a running build actually shipped against a locally
 * generated artifact; it is not a security primitive.
 */
function apiDocsSpecFingerprint(raw: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const SPEC_FINGERPRINT = apiDocsSpecFingerprint(specRaw);
const PARSED = parseOpenApiDocument(specRaw);

type ApiDocsBuildState = 'ok' | 'parse-error' | 'missing-artifact';

/**
 * OPU-REF-1: an empty page must say WHY it is empty. `missing-artifact` means
 * the `?raw` import produced zero bytes (bad path or empty generated file);
 * `parse-error` means bytes were there but not a usable OpenAPI document; `ok`
 * means the artifact loaded and any emptiness is a filter result.
 */
const BUILD_STATE: ApiDocsBuildState =
  specRaw.trim().length === 0 ? 'missing-artifact' : PARSED.ok ? 'ok' : 'parse-error';

/** AP-03: what the bundle actually declares about itself, read from the
 * artifact itself. `x-absent` is the generator's own list of surfaces it does
 * NOT cover, so counting it is evidence shipped with the spec, not a guess. */
const SPEC_VERSION = PARSED.ok ? (PARSED.doc.info.version ?? null) : null;
const SPEC_ABSENT_COUNT = PARSED.ok ? PARSED.doc['x-absent']?.length ?? 0 : 0;

/**
 * Freshness states. The bundle carries no generation timestamp and this page
 * performs zero runtime requests, so age is NOT measurable here and no build
 * date is guessed: every state below names what is known and what is not.
 */
type ApiDocsFreshness =
  | 'artifact-missing'
  | 'unreadable'
  | 'version-unknown'
  | 'snapshot-age-unknown';

const FRESHNESS_BY_BUILD_STATE: Record<ApiDocsBuildState, ApiDocsFreshness> = {
  'missing-artifact': 'artifact-missing',
  'parse-error': 'unreadable',
  ok: SPEC_VERSION === null ? 'version-unknown' : 'snapshot-age-unknown',
};

const FRESHNESS_LABEL: Record<ApiDocsFreshness, string> = {
  'artifact-missing': 'no spec artifact',
  unreadable: 'spec unreadable',
  'version-unknown': 'spec version unknown',
  'snapshot-age-unknown': 'snapshot \u00b7 age unknown',
};

const FRESHNESS_VARIANT: Record<ApiDocsFreshness, BadgeProps['variant']> = {
  'artifact-missing': 'danger',
  unreadable: 'danger',
  'version-unknown': 'warning',
  'snapshot-age-unknown': 'warning',
};

const FRESHNESS_ADVICE: Record<ApiDocsFreshness, string> = {
  'artifact-missing':
    'The ?raw import produced no bytes, so there is nothing to compare against a local artifact.',
  unreadable:
    'Bytes were bundled but the document did not parse, so no freshness signal can be derived from it.',
  'version-unknown':
    'The bundle declares no info.version, so the shipped revision cannot be named.',
  'snapshot-age-unknown':
    'The bundle records no generation timestamp, so age cannot be measured on this page \u2014 compare the fingerprint against a locally regenerated artifact.',
};

/** Evaluated once per document load. This SPA renders client-side only
 * (createRoot in main.tsx, no SSR pass), so a module-scope instant cannot
 * disagree with what the operator sees. */
const BUNDLE_LOADED_AT = new Date();

/** One line telling the operator what the bundle DOES declare, then what it
 * cannot tell them. Assembled here rather than in JSX so the separators are
 * explicit and no empty JSX text node is relied on. */
function freshnessSentence(freshness: ApiDocsFreshness, state: ApiDocsBuildState): string {
  const version = SPEC_VERSION === null ? 'spec version unknown' : `bundled spec v${SPEC_VERSION}`;
  const gaps =
    state === 'ok' ? ` · ${SPEC_ABSENT_COUNT} surface(s) declared absent in this bundle` : '';
  const loaded = ` · bundle loaded in this browser at ${BUNDLE_LOADED_AT.toLocaleString()}`;
  return `${version}${gaps}${loaded} · ${FRESHNESS_ADVICE[freshness]}`;
}

function SpecBuildLabel({ state }: { state: ApiDocsBuildState }) {
  const freshness = FRESHNESS_BY_BUILD_STATE[state];
  return (
    <div
      className="space-y-1"
      data-api-docs-build-label="true"
      data-api-docs-build-state={state}
      data-api-docs-freshness={freshness}
      data-spec-source={SPEC_SOURCE}
      data-spec-bytes={String(SPEC_RAW_BYTES)}
      data-spec-fingerprint={SPEC_FINGERPRINT}
      data-spec-version={SPEC_VERSION ?? 'unknown'}
      data-spec-absent-count={String(SPEC_ABSENT_COUNT)}
      data-bundle-loaded-at={BUNDLE_LOADED_AT.toISOString()}
    >
      <p className="text-xs text-[var(--text-sub)]">
        Spec build: <code>{SPEC_SOURCE}</code> · {SPEC_RAW_BYTES} bytes · fingerprint{' '}
        <code>{SPEC_FINGERPRINT}</code> · bundled at build time with zero runtime requests.
      </p>
      <p
        className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-sub)]"
        data-api-docs-freshness-note="true"
      >
        <Badge variant={FRESHNESS_VARIANT[freshness]}>{FRESHNESS_LABEL[freshness]}</Badge>
        <span>{freshnessSentence(freshness, state)}</span>
      </p>
    </div>
  );
}

const METHOD_VARIANT: Record<string, BadgeProps['variant']> = {
  get: 'info',
  post: 'success',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
  head: 'neutral',
  options: 'neutral',
};

const FAMILY_LABEL: Record<string, string> = {
  public: 'Public API',
  admin: 'Admin / Management',
  runtime: 'Runtime',
  connector: 'Connector',
};

function entryKey(entry: OperationEntry): string {
  return `${entry.method.toUpperCase()} ${entry.path}`;
}

function familyLabel(family: string): string {
  return FAMILY_LABEL[family] ?? family;
}

export function ApiDocsScreen() {
  if (BUILD_STATE === 'missing-artifact') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Reference</CardTitle>
          <CardDescription>
            The build imported <code>{SPEC_SOURCE}</code> but the artifact contains no bytes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <SpecBuildLabel state="missing-artifact" />
          <p className="text-sm text-[var(--badge-danger-text)]" role="alert">
            Empty spec import: the <code>?raw</code> import path or the generated artifact is wrong. Rebuild after
            regenerating <code>{SPEC_SOURCE}</code>; nothing can be rendered from an empty import.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (!PARSED.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Reference</CardTitle>
          <CardDescription>The generated OpenAPI artifact could not be read.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <SpecBuildLabel state="parse-error" />
          <p className="text-sm text-[var(--badge-danger-text)]" role="alert">
            docs/21-openapi.json did not parse: {PARSED.error}
          </p>
        </CardContent>
      </Card>
    );
  }
  return <ApiDocsView doc={PARSED.doc} entries={PARSED.entries} />;
}

function ApiDocsView({ doc, entries }: { doc: OpenApiDocument; entries: OperationEntry[] }) {
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const families = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  const familyOrigins = useMemo(() => {
    const origins = new Map<string, OpenApiServer>();
    for (const entry of entries) {
      const server = entry.operation.servers?.[0];
      if (server !== undefined && !origins.has(entry.family)) origins.set(entry.family, server);
    }
    return origins;
  }, [entries]);

  const familyDescriptions = useMemo(() => {
    const descriptions = new Map<string, string>();
    for (const tag of doc.tags ?? []) descriptions.set(tag.name, tag.description ?? '');
    return descriptions;
  }, [doc.tags]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (family !== 'all' && entry.family !== family) return false;
      if (needle === '') return true;
      const haystack = [
        entry.method,
        entry.path,
        entry.operation.summary ?? '',
        entry.operation.operationId ?? '',
        entry.family,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [entries, family, search]);

  const selected = useMemo(() => {
    if (filtered.length === 0) return undefined;
    return filtered.find((entry) => entryKey(entry) === selectedKey) ?? filtered[0];
  }, [filtered, selectedKey]);

  const schemaEntries = Object.entries(doc.components?.schemas ?? {});
  const securitySchemes = Object.entries(doc.components?.securitySchemes ?? {});
  const absent = doc['x-absent'] ?? [];

  return (
    <section aria-labelledby="api-docs-title" className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id="api-docs-title">API Reference</CardTitle>
            <Badge variant="info">
              OpenAPI {doc.openapi} · v{doc.info.version ?? 'unknown'}
            </Badge>
            <Badge variant="neutral">{entries.length} operations</Badge>
            <Badge variant="neutral">{schemaEntries.length} schemas</Badge>
          </div>
          <CardDescription>
            Rendered from the generated <code>docs/21-openapi.json</code> bundled into this build (offline, no CDN,
            no second spec source). Origins follow the PM-M02 ingress: public API on 3000, admin/management and
            runtime on the internal 3002 listener, Connector on 8080. <strong>Try-it-out is intentionally
            disabled</strong> — this page never sends a request or a credential.
          </CardDescription>
          <SpecBuildLabel state="ok" />
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {families.map(([name, count]) => {
            const server = familyOrigins.get(name);
            const description = familyDescriptions.get(name);
            return (
              <div
                key={name}
                className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/40 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{familyLabel(name)}</span>
                  <Badge variant="neutral">{count}</Badge>
                </div>
                <code className="mt-1 block truncate text-xs text-[var(--text-muted)]">
                  {server?.url ?? 'origin not declared'}
                </code>
                {description !== undefined && description !== '' ? (
                  <p className="mt-1 text-xs text-[var(--text-sub)]">{description}</p>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Operations</CardTitle>
              <CardDescription>
                Filter by API family or search path/summary. Selecting an operation renders its contract.
              </CardDescription>
            </div>
            <div className="w-full max-w-xs">
              <Input
                aria-label="Search operations"
                placeholder="Search path, summary, operationId…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by API family">
            <Button
              size="sm"
              variant={family === 'all' ? 'secondary' : 'ghost'}
              aria-pressed={family === 'all'}
              onClick={() => setFamily('all')}
            >
              All ({entries.length})
            </Button>
            {families.map(([name, count]) => (
              <Button
                key={name}
                size="sm"
                variant={family === name ? 'secondary' : 'ghost'}
                aria-pressed={family === name}
                onClick={() => setFamily(name)}
              >
                {familyLabel(name)} ({count})
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]" data-api-docs-empty-filter="true">
              No operation matches the current filter ({filtered.length} of {entries.length} operations shown
              {search.trim() === '' ? '' : `; search "${search.trim()}"`}
              {family === 'all' ? '' : `; family ${familyLabel(family)}`}). The spec loaded from{' '}
              <code>{SPEC_SOURCE}</code> ({SPEC_RAW_BYTES} bytes); clear the filter to see all {entries.length}{' '}
              operations.
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:h-[calc(100vh-14rem)] lg:min-h-[580px] lg:max-h-[850px]">
              <ul
                tabIndex={0}
                className="h-full overflow-y-auto divide-y divide-[var(--border-subtle)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-base)]"
                aria-label="OpenAPI operations"
              >
                {filtered.map((entry) => {
                  const active = selected !== undefined && entryKey(selected) === entryKey(entry);
                  return (
                    <li key={entryKey(entry)}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(entryKey(entry))}
                        aria-current={active ? 'true' : undefined}
                        className={
                          'flex w-full items-start gap-2 px-3 py-2 text-left ' +
                          (active ? 'bg-[var(--cf-blue-light)]' : 'hover:bg-[var(--bg-hover)]')
                        }
                      >
                        <Badge variant={METHOD_VARIANT[entry.method] ?? 'neutral'}>
                          {entry.method.toUpperCase()}
                        </Badge>
                        <span className="min-w-0 flex-1">
                          <code className="block truncate text-xs">{entry.path}</code>
                          <span className="block truncate text-xs text-[var(--text-sub)]">
                            {entry.operation.summary ?? ''}
                          </span>
                        </span>
                        <Badge variant="neutral">{entry.family}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div
                className="h-full overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3"
                role="region"
                aria-label="Operation detail"
              >
                {selected !== undefined ? (
                  <OperationDetail entry={selected} />
                ) : (
                  <div className="flex h-full items-center justify-center p-8 text-center text-xs text-[var(--text-sub)]">
                    Chọn một API operation từ danh sách bên trái để xem tài liệu chi tiết.
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>Security schemes declared by the generated spec.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {securitySchemes.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No security scheme declared.</p>
            ) : (
              securitySchemes.map(([name, scheme]) => (
                <div key={name} className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-semibold">{name}</code>
                    <Badge variant="neutral">{scheme.type ?? 'unknown'}</Badge>
                    {scheme.scheme !== undefined ? <Badge variant="neutral">{scheme.scheme}</Badge> : null}
                  </div>
                  {scheme.description !== undefined ? (
                    <p className="mt-1 text-xs text-[var(--text-sub)]">{scheme.description}</p>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Known-absent surfaces</CardTitle>
            <CardDescription>Published gaps from <code>x-absent</code>; not implemented routes.</CardDescription>
          </CardHeader>
          <CardContent>
            {absent.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">None declared.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--text-sub)]">
                {absent.map((entry) => (
                  <li key={entry}>
                    <code>{entry}</code>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Schemas ({schemaEntries.length})</CardTitle>
          <CardDescription>components.schemas from the generated artifact, rendered verbatim.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {schemaEntries.map(([name, schema]) => (
            <details key={name} className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-2">
              <summary className="cursor-pointer text-sm font-medium">
                <code>{name}</code>
              </summary>
              <JsonBlock value={schema} />
            </details>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

function responseBadgeVariant(code: string): BadgeProps['variant'] {
  const num = Number(code);
  if (num >= 200 && num < 300) return 'success';
  if (num >= 300 && num < 400) return 'info';
  if (num >= 400 && num < 500) return 'warning';
  if (num >= 500) return 'danger';
  return 'neutral';
}

function responseStatusText(code: string): string {
  const map: Record<string, string> = {
    '200': 'OK',
    '201': 'Created',
    '202': 'Accepted',
    '204': 'No Content',
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '403': 'Forbidden',
    '404': 'Not Found',
    '409': 'Conflict',
    '422': 'Unprocessable Entity',
    '500': 'Internal Server Error',
    '502': 'Bad Gateway',
    '503': 'Service Unavailable',
  };
  return map[code] ?? '';
}

function OperationDetail({ entry }: { entry: OperationEntry }) {
  const operation = entry.operation;
  const parameters = operation.parameters ?? [];
  const responses = Object.entries(operation.responses ?? {});
  const servers = operation.servers ?? [];
  const security = operation.security ?? [];
  const requestBody = operation.requestBody;

  return (
    <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={METHOD_VARIANT[entry.method] ?? 'neutral'}>{entry.method.toUpperCase()}</Badge>
        <code className="break-all text-sm font-semibold">{entry.path}</code>
        <Badge variant="neutral">{entry.family}</Badge>
      </div>
      {operation.summary !== undefined ? <p className="text-sm font-medium">{operation.summary}</p> : null}
      {operation.description !== undefined ? (
        <p className="whitespace-pre-wrap text-xs text-[var(--text-sub)]">{operation.description}</p>
      ) : null}
      <DefinitionRow label="Required scope" value={operation['x-required-service-scope'] ?? '—'} />
      <DefinitionRow label="Source" value={operation['x-source'] ?? '—'} />

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]">Security</h4>
        {security.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">none declared</p>
        ) : (
          <JsonBlock value={security} />
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]">Servers</h4>
        {servers.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">none declared</p>
        ) : (
          servers.map((server) => (
            <div key={server.url}>
              <code className="text-xs">{server.url}</code>
              {server.description !== undefined ? (
                <p className="text-xs text-[var(--text-sub)]">{server.description}</p>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]">
          Parameters ({parameters.length})
        </h4>
        {parameters.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">none declared</p>
        ) : (
          <div className="space-y-2">
            {parameters.map((parameter) => (
              <div
                key={`${parameter.in}:${parameter.name}`}
                className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-2 text-xs"
              >
                <span>
                  <code className="font-semibold">{parameter.name}</code> · {parameter.in} ·{' '}
                  {parameter.required === true ? 'required' : 'optional'}
                </span>
                {parameter.description !== undefined ? (
                  <p className="mt-1 text-[var(--text-sub)]">{parameter.description}</p>
                ) : null}
                {parameter.schema !== undefined ? <JsonBlock value={parameter.schema} /> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]">Request body</h4>
        {requestBody?.content === undefined ? (
          <p className="text-xs text-[var(--text-muted)]">none declared</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-sub)]">
              {requestBody.required === true ? 'required' : 'optional'}
              {requestBody.description !== undefined ? ` · ${requestBody.description}` : ''}
            </p>
            <ContentBlocks content={requestBody.content} />
          </div>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-sub)]">
          Responses ({responses.length})
        </h4>
        <div className="space-y-2.5">
          {responses.map(([code, response]) => (
            <details
              key={code}
              className="group rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 transition-colors hover:border-[var(--border-dark)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs select-none">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant={responseBadgeVariant(code)} className="font-mono text-xs font-bold shrink-0">
                    {code}
                  </Badge>
                  {responseStatusText(code) ? (
                    <span className="font-semibold text-[var(--text-main)] shrink-0">
                      {responseStatusText(code)}
                    </span>
                  ) : null}
                  <span className="truncate text-[var(--text-sub)]">
                    {response.description ? `— ${response.description}` : ''}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--text-sub)] shrink-0 group-open:rotate-180 transition-transform">
                  ▼
                </span>
              </summary>

              <div className="mt-3 space-y-3 border-t border-[var(--border-subtle)] pt-3 text-xs">
                {/* Description */}
                <div>
                  <span className="font-semibold text-[var(--text-sub)] uppercase tracking-wider text-[10px]">
                    Mô tả / Description
                  </span>
                  <p className="mt-1 text-[var(--text-main)] bg-[var(--surface-muted)] p-2.5 rounded border border-[var(--border-subtle)] leading-relaxed">
                    {response.description || 'Không có mô tả chi tiết.'}
                  </p>
                </div>

                {/* Headers if any */}
                {response.headers && Object.keys(response.headers).length > 0 && (
                  <div>
                    <span className="font-semibold text-[var(--text-sub)] uppercase tracking-wider text-[10px]">
                      Response Headers
                    </span>
                    <div className="mt-1 space-y-1.5">
                      {Object.entries(response.headers).map(([hdrName, hdr]) => (
                        <div
                          key={hdrName}
                          className="rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <code className="font-semibold text-[var(--text-main)]">{hdrName}</code>
                            {hdr.schema && typeof hdr.schema === 'object' && 'type' in hdr.schema ? (
                              <span className="text-[var(--text-sub)] font-mono text-[11px]">
                                ({String((hdr.schema as Record<string, unknown>).type)})
                              </span>
                            ) : null}
                          </div>
                          {hdr.description && <p className="mt-1 text-[var(--text-sub)]">{hdr.description}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Response Body / Content */}
                {response.content !== undefined ? (
                  <div>
                    <span className="font-semibold text-[var(--text-sub)] uppercase tracking-wider text-[10px]">
                      Payload Body & Schema
                    </span>
                    <div className="mt-1">
                      <ContentBlocks content={response.content} />
                    </div>
                  </div>
                ) : response.schema !== undefined ? (
                  <div>
                    <span className="font-semibold text-[var(--text-sub)] uppercase tracking-wider text-[10px]">
                      Response Schema
                    </span>
                    <div className="mt-1">
                      <JsonBlock value={response.schema} />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-[var(--radius-sm)] border border-dashed border-[var(--border-subtle)] bg-[var(--surface-muted)] p-2.5 text-xs text-[var(--text-sub)]">
                    <span className="font-semibold text-[var(--text-main)]">Response Body: </span>
                    {Number(code) >= 400 ? (
                      <span>
                        Tiêu chuẩn RFC 7807 (<code>application/problem+json</code>). Phản hồi mang cấu trúc mã lỗi gồm <code>status: {code}</code>, <code>code</code>, <code>title</code>, <code>correlationId</code>.
                      </span>
                    ) : Number(code) === 204 ? (
                      <span>204 No Content (Phản hồi không mang nội dung thân body).</span>
                    ) : (
                      <span>Trạng thái phản hồi không yêu cầu nội dung payload body bổ sung.</span>
                    )}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContentBlocks({ content }: { content: Record<string, OpenApiMediaType> }) {
  return (
    <div className="space-y-2">
      {Object.entries(content).map(([mediaType, media]) => (
        <div
          key={mediaType}
          className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/40 p-2"
        >
          <code className="text-xs font-semibold">{mediaType}</code>
          {media.schema !== undefined ? <JsonBlock value={media.schema} /> : null}
          {media.example !== undefined ? (
            <div className="mt-1">
              <p className="text-xs text-[var(--text-sub)]">example</p>
              <JsonBlock value={media.example} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre
      tabIndex={0}
      className="mt-1 max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-2 text-xs leading-relaxed"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs">
      <span className="font-semibold uppercase tracking-wide text-[var(--text-sub)]">{label}</span>
      <code className="break-all">{value}</code>
    </div>
  );
}

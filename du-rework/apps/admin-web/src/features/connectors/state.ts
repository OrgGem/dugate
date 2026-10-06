/** Runtime parsing for connector revision reads + the in-memory import draft. */
import type {
  ConnectorCapabilities,
  ConnectorCreateParams,
  ConnectorListPage,
  ConnectorManagementRevision,
  ConnectorRevision,
  ConnectorRevisionRead,
  ConnectorRevisionState,
  ConnectorTestResult,
} from '@/lib/api';
import { isSecretTokenName, type CurlImportDraft } from './curl-import';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseConnectorRevision(value: unknown): ConnectorRevision | null {
  if (!isRecord(value)) return null;
  const connectorId = value['connectorId'];
  const revision = value['revision'];
  const adapter = value['adapter'];
  const state = value['state'];
  if (typeof connectorId !== 'string' || typeof revision !== 'number') return null;
  if (typeof adapter !== 'string' || typeof state !== 'string') return null;
  const endpoint = isRecord(value['endpoint']) ? value['endpoint'] : {};
  const capabilities = Array.isArray(value['capabilities'])
    ? value['capabilities'].filter((item): item is string => typeof item === 'string')
    : [];
  return {
    connectorId,
    revision,
    adapter,
    endpoint: {
      kind: typeof endpoint['kind'] === 'string' ? endpoint['kind'] : 'unknown',
      maskedHost: typeof endpoint['maskedHost'] === 'string' ? endpoint['maskedHost'] : '',
    },
    capabilities,
    state,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
    secretSlots: Array.isArray(value['secretSlots']) ? value['secretSlots'] : [],
    testResult: value['testResult'] ?? null,
  };
}

export function connectorStateVariant(state: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = state.toLowerCase();
  if (value === 'enabled' || value === 'ready' || value === 'active') return 'success';
  if (value === 'degraded' || value === 'pending') return 'warning';
  if (value === 'error' || value === 'failed') return 'danger';
  return 'neutral';
}

/**
 * In-memory import draft (P730-UI-INTEGRATE phase 1).
 *
 * A draft exists only in screen state: there is no connector save/test/activate
 * wire on this deployment (PAR-03/14), so accepting a draft deliberately has no
 * network effect and there is nothing to persist. The secret value is kept in
 * memory only; every projection used for rendering goes through summarizeCurlImport.
 */
export interface ConnectorImportDraft extends CurlImportDraft {
  /** Free-form name the operator gave the pasted command (in-memory only, editable). */
  name: string;
}

/** Extends the parser draft so every render path can reuse summarizeCurlImport. */
export function draftFromCurlImport(draft: CurlImportDraft, name = ''): ConnectorImportDraft {
  return { ...draft, name };
}

// ---------------------------------------------------------------------------
// CONNECTOR-WIRE-B — management wire readers, capability gating, save mapping
//
// Everything here is a pure function over an already-fetched body: nothing
// guesses, nothing widens a shape, and nothing re-derives a secret. A body
// that does not match its contract reads as `null` (the screen renders an
// honest 502-style "unreadable response" instead of a plausible-looking lie).
// ---------------------------------------------------------------------------

const CONNECTOR_REVISION_STATES: readonly ConnectorRevisionState[] = ['PENDING', 'ACTIVE', 'RETIRED'];

/** Exactly the keys `@du/contracts` ConnectorManagementRevisionSchema declares. */
const MANAGEMENT_REVISION_KEYS: ReadonlySet<string> = new Set([
  'connectorId',
  'revision',
  'adapter',
  'state',
  'config',
  'credentialRef',
  'credentialSource',
  'tenantId',
  'accountId',
]);

/** Exactly the keys ConnectorCapabilitiesSchema declares (`.strict()` upstream). */
const CAPABILITIES_KEYS: ReadonlySet<string> = new Set(['management', 'credentialWorkflow', 'test']);

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isConnectorRevisionState(value: string): value is ConnectorRevisionState {
  return (CONNECTOR_REVISION_STATES as readonly string[]).includes(value);
}

/**
 * Strict mirror of the platform DTO: an unknown top-level field means the
 * browser cannot trust the body (the platform itself answers 502 there), so
 * this returns `null` rather than dropping the field silently.
 */
export function parseConnectorManagementRevision(value: unknown): ConnectorManagementRevision | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, MANAGEMENT_REVISION_KEYS)) return null;

  const connectorId = value['connectorId'];
  const revision = value['revision'];
  const adapter = value['adapter'];
  const state = value['state'];
  const config = value['config'];
  if (typeof connectorId !== 'string' || connectorId.length === 0) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof adapter !== 'string' || adapter.length === 0) return null;
  if (typeof state !== 'string' || !isConnectorRevisionState(state)) return null;
  if (!isRecord(config)) return null;

  const credentialRef = value['credentialRef'];
  if (credentialRef !== undefined && (typeof credentialRef !== 'string' || credentialRef.length === 0)) {
    return null;
  }
  const credentialSource = value['credentialSource'];
  if (credentialSource !== undefined && !isRecord(credentialSource)) return null;
  const tenantId = value['tenantId'];
  if (tenantId !== undefined && typeof tenantId !== 'string') return null;
  const accountId = value['accountId'];
  if (accountId !== undefined && typeof accountId !== 'string') return null;

  return {
    connectorId,
    revision,
    adapter,
    state,
    config,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(credentialSource === undefined ? {} : { credentialSource }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/** Composition advertisement. All three booleans must be real or the read fails. */
export function parseConnectorCapabilities(value: unknown): ConnectorCapabilities | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, CAPABILITIES_KEYS)) return null;
  const management = value['management'];
  const credentialWorkflow = value['credentialWorkflow'];
  const test = value['test'];
  if (typeof management !== 'boolean') return null;
  if (typeof credentialWorkflow !== 'boolean') return null;
  if (typeof test !== 'boolean') return null;
  return { management, credentialWorkflow, test };
}

/**
 * `{ items }` list read. Rows that fail the strict revision reader are counted
 * in `skipped` — never dropped silently, never repaired into looking valid.
 */
export function parseConnectorList(value: unknown): ConnectorListPage | null {
  if (!isRecord(value)) return null;
  const items = value['items'];
  if (!Array.isArray(items)) return null;
  const parsed: ConnectorManagementRevision[] = [];
  let skipped = 0;
  for (const item of items) {
    const revision = parseConnectorManagementRevision(item);
    if (revision === null) skipped += 1;
    else parsed.push(revision);
  }
  return { items: parsed, skipped };
}

/**
 * The revision read has two honest shapes. Discriminate on the KEY SET — a
 * management body always carries `config`, the placeholder always carries
 * `endpoint` — so a malformed management body can never be mistaken for the
 * degraded projection (or the other way around).
 */
export function parseConnectorRevisionRead(value: unknown): ConnectorRevisionRead | null {
  if (!isRecord(value)) return null;
  if ('config' in value) {
    const revision = parseConnectorManagementRevision(value);
    return revision === null ? null : { kind: 'management', revision };
  }
  if ('endpoint' in value) {
    const revision = parseConnectorRevision(value);
    return revision === null ? null : { kind: 'legacy', revision };
  }
  return null;
}

/** Narrow probe result: `ok` is required, `errorCode` optional, nothing else. */
export function parseConnectorTestResult(value: unknown): ConnectorTestResult | null {
  if (!isRecord(value)) return null;
  const ok = value['ok'];
  if (typeof ok !== 'boolean') return null;
  const errorCode = value['errorCode'];
  if (errorCode !== undefined && typeof errorCode !== 'string') return null;
  return { ok, ...(errorCode === undefined ? {} : { errorCode }) };
}

export interface ConnectorActionGating {
  upsert: boolean;
  activate: boolean;
  disable: boolean;
  retire: boolean;
  test: boolean;
  rotate: boolean;
  /** Non-empty whenever a control is gated off; rendered as the disabled title. */
  reason: string;
}

/**
 * Capability gating. `null` capabilities (unreadable advertisement) gates every
 * write off — fail-closed, exactly like the platform's own 503 path. A button
 * is enabled only when the composed deployment advertised that capability.
 */
export function connectorActionGating(capabilities: ConnectorCapabilities | null): ConnectorActionGating {
  const management = capabilities?.management === true;
  return {
    upsert: management,
    activate: management,
    disable: management,
    retire: management,
    test: capabilities?.test === true,
    rotate: capabilities?.credentialWorkflow === true,
    reason:
      capabilities === null
        ? 'Capability advertisement is unavailable on this build; writes stay disabled.'
        : management
          ? ''
          : 'Connector management is not composed on this deployment (management:false).',
  };
}

export interface ConnectorConfigSummary {
  /** Top-level config keys only — values are never rendered. */
  keys: string[];
  /** Header names whose value may be shown as imported. */
  headerNames: string[];
  /** Header names the connector masks (`[REDACTED]` / secret-named). */
  redactedHeaderNames: string[];
}

/** Projection for rendering: keys and names only, never a config value. */
export function summarizeConnectorConfig(config: Record<string, unknown>): ConnectorConfigSummary {
  const headers = Array.isArray(config['headers']) ? config['headers'] : [];
  const headerNames: string[] = [];
  const redactedHeaderNames: string[] = [];
  for (const header of headers) {
    if (!isRecord(header)) continue;
    const name = header['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const value = header['value'];
    if (value === '[REDACTED]' || isSecretTokenName(name)) redactedHeaderNames.push(name);
    else headerNames.push(name);
  }
  return { keys: Object.keys(config).sort(), headerNames, redactedHeaderNames };
}

/**
 * The ACTIVE head of a connector, read from the list — the CAS value
 * `connector.activate` needs. Returns `null` when this page does not show it;
 * the caller disables Activate instead of guessing a revision.
 */
export function connectorActiveRevision(
  items: ConnectorManagementRevision[],
  connectorId: string,
): number | null {
  for (const item of items) {
    if (item.connectorId === connectorId && item.state === 'ACTIVE') return item.revision;
  }
  return null;
}

export interface ConnectorDraftTarget {
  connectorId: string;
  adapter: string;
  /** Opaque slot label the operator supplies; NOT the secret. */
  credentialRef: string;
}

export type ConnectorUpsertPlan =
  | { ok: true; params: ConnectorCreateParams }
  | { ok: false; missing: 'connectorId' | 'adapter' | 'credentialRef' };

/**
 * Draft → `connector.upsert` (mode 'create'). The secret is deliberately NOT
 * part of this payload: the write-only value path is
 * `connectors.rotate_credential`. A missing required coordinate returns the
 * exact missing field so the screen can keep Save disabled with a real reason
 * instead of sending a body the dispatcher would 422.
 */
export function buildConnectorUpsertParams(
  draft: CurlImportDraft,
  target: ConnectorDraftTarget,
): ConnectorUpsertPlan {
  const connectorId = target.connectorId.trim();
  if (connectorId.length === 0) return { ok: false, missing: 'connectorId' };
  const adapter = target.adapter.trim();
  if (adapter.length === 0) return { ok: false, missing: 'adapter' };
  const credentialRef = target.credentialRef.trim();
  if (credentialRef.length === 0) return { ok: false, missing: 'credentialRef' };
  return {
    ok: true,
    params: {
      mode: 'create',
      connectorId,
      adapter,
      config: connectorConfigFromDraft(draft),
      credentialRef,
    },
  };
}

/**
 * Draft → connector `config`. Secret material is structural, never a value:
 * secret-named headers and secret form fields are reduced to their NAME, and
 * file fields keep no value at all (the parser's raw file token is a local
 * path — it must never reach the platform). Safe, non-secret fields are kept
 * so the operator's paste is actually represented.
 */
export function connectorConfigFromDraft(draft: CurlImportDraft): Record<string, unknown> {
  const headers: { name: string; value: string }[] = [];
  const redactedHeaderNames: string[] = [];
  for (const header of draft.headers) {
    if (isSecretTokenName(header.name)) redactedHeaderNames.push(header.name);
    else headers.push({ name: header.name, value: header.value });
  }

  const formFields: { name: string; value: string }[] = [];
  const secretFormFieldNames: string[] = [];
  const fileFormFieldNames: string[] = [];
  for (const field of draft.formFields) {
    if (field.secret) secretFormFieldNames.push(field.name);
    else if (field.isFile) fileFormFieldNames.push(field.name);
    else formFields.push({ name: field.name, value: field.value });
  }

  return {
    endpointUrl: draft.endpointUrl,
    httpMethod: draft.httpMethod,
    auth: {
      type: draft.auth.type,
      headerName: draft.auth.headerName,
      secretPresent: draft.auth.secretValue !== null && draft.auth.secretValue.length > 0,
    },
    headers,
    redactedHeaderNames,
    formFields,
    secretFormFieldNames,
    fileFormFieldNames,
  };
}

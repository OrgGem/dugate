/**
 * Runtime parsing for the Profile read wire — conformant with the FROZEN
 * Phase-1 contract (coordination/reports/profile-parity-phase1-2026-10-04.md
 * §5/§7): `policy` is ONE object, `parameters` is a map, `capabilities` is an
 * array of `{connectorId, capability}` objects, `fileUrlAuthConfig` never
 * appears on reads (only `fileUrlAuthConfigured: boolean`).
 *
 * Fields dropped from the read wire per coordinator decision: `schemaVersion`,
 * `endpoints[]`, `effective` — none are parsed or expected any more.
 */
import type {
  ConnectionStep,
  ProfileCallbackPolicy,
  ProfileCapability,
  ProfileDetail,
  ProfileListPage,
  ProfileListRow,
  ProfileParameterValue,
  ProfilePolicyRead,
  ProfileWorkflowItem,
  ProfileWorkflowPage,
  RequestRedactionRule,
} from '@/lib/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseParameterValue(value: unknown): ProfileParameterValue {
  // Contract shape is `{value, isLocked?}`; a bare scalar is tolerated as an
  // already-flattened legacy value.
  if (!isRecord(value)) return { value: value ?? null, isLocked: false };
  return { value: value['value'] ?? null, isLocked: value['isLocked'] === true };
}

function parseConnStep(value: unknown): ConnectionStep | null {
  if (!isRecord(value)) return null;
  const slug = str(value['slug'] ?? value['connectionId']);
  if (slug === null) return null;
  return {
    slug,
    ...(str(value['stepId']) !== null ? { stepId: str(value['stepId']) as string } : {}),
    ...(value['captureSession'] === true ? { captureSession: true } : {}),
    ...(value['injectSession'] === true ? { injectSession: true } : {}),
  };
}

export function parsePolicyRead(value: unknown): ProfilePolicyRead | null {
  if (!isRecord(value)) return null;
  const parameters: Record<string, ProfileParameterValue> = {};
  if (isRecord(value['parameters'])) {
    for (const [key, raw] of Object.entries(value['parameters'])) {
      if (key.length === 0) continue;
      parameters[key] = parseParameterValue(raw);
    }
  }
  const priority = str(value['jobPriority']);
  const steps = Array.isArray(value['connectionsOverride'])
    ? value['connectionsOverride'].map(parseConnStep).filter((step): step is ConnectionStep => step !== null)
    : [];
  const callbackPolicy = parseCallbackPolicy(value['callbackPolicy']);
  return {
    enabled: value['enabled'] !== false,
    parameters,
    jobPriority: priority === 'LOW' || priority === 'HIGH' ? priority : 'MEDIUM',
    allowedFileExtensions: str(value['allowedFileExtensions']) ?? '',
    fileUrlAuthConfigured: value['fileUrlAuthConfigured'] === true,
    connectionsOverride: steps,
    requestRedaction: Array.isArray(value['requestRedaction']) ? value['requestRedaction']
      .filter((rule): rule is Record<string, unknown> => isRecord(rule) && typeof rule['pattern'] === 'string')
      .map((rule): RequestRedactionRule => ({ pattern: rule['pattern'] as string,
        ...(typeof rule['flags'] === 'string' ? { flags: rule['flags'] } : {}),
        ...(typeof rule['replacement'] === 'string' ? { replacement: rule['replacement'] } : {}),
      })) : [],
    ...(value['callbackPolicy'] === null ? { callbackPolicy: null } : callbackPolicy !== null ? { callbackPolicy } : {}),
    ...(value['callbackPolicyInvalid'] === true ? { callbackPolicyInvalid: true as const } : {}),
  };
}

/**
 * CB-04: minimal shape gate for the read wire. The editor re-validates the
 * whole policy from the draft; this only keeps a garbage payload from entering
 * typed state as if it were a policy.
 */
function parseCallbackPolicy(value: unknown): ProfileCallbackPolicy | null {
  if (!isRecord(value)) return null;
  if (value['version'] !== 1 || typeof value['mode'] !== 'string' || !isRecord(value['auth'])) return null;
  const auth = value['auth'];
  if (typeof auth['method'] !== 'string') return null;
  return value as unknown as ProfileCallbackPolicy;
}

function parseCapability(value: unknown): ProfileCapability | null {
  if (!isRecord(value)) return null;
  const connectorId = str(value['connectorId']);
  const capability = str(value['capability']);
  if (connectorId === null || capability === null) return null;
  return { connectorId, capability };
}

export function parseProfileDetail(value: unknown): ProfileDetail | null {
  if (!isRecord(value)) return null;
  const businessId = str(value['businessId']);
  const businessVersion = str(value['businessVersion']);
  const profileName = str(value['profileName']);
  const revision = value['revision'];
  if (businessId === null || businessVersion === null || profileName === null) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  const policy = parsePolicyRead(value['policy']);
  if (policy === null) return null;

  const manifest = isRecord(value['manifest']) ? value['manifest'] : {};
  const actions = Array.isArray(manifest['actions'])
    ? (manifest['actions'] as unknown[]).filter(isRecord).map((action) => ({
        ...(str(action['name']) !== null ? { name: str(action['name']) as string } : {}),
        ...(str(action['action']) !== null ? { action: str(action['action']) as string } : {}),
      }))
    : [];
  const capabilities = Array.isArray(value['capabilities'])
    ? value['capabilities']
        .map(parseCapability)
        .filter((capability): capability is ProfileCapability => capability !== null)
    : [];
  // T-API-01 closure: the write identity rides the read wire; carry it through
  // (absent on `/new` and unstored profiles — never synthesize one).
  const apiKeyId = str(value['apiKeyId']);
  return {
    businessId,
    businessVersion,
    profileName,
    revision,
    currentValues: isRecord(value['currentValues']) ? value['currentValues'] : {},
    policy,
    manifest: { actions },
    capabilities,
    ...(apiKeyId !== null && apiKeyId.length > 0 ? { apiKeyId } : {}),
  };
}

export function parseProfileWorkflowPage(
  value: unknown,
  businessId: string,
  businessVersion: string,
): ProfileWorkflowPage | null {
  if (!isRecord(value) || value['businessId'] !== businessId || value['businessVersion'] !== businessVersion
      || !Array.isArray(value['items'])) return null;
  const items: ProfileWorkflowItem[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) return null;
    const slug = str(raw['slug']);
    const revision = raw['revision'];
    const status = raw['status'];
    const createdAt = str(raw['createdAt']);
    if (slug === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)
        || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
        || (status !== 'active' && status !== 'retired') || typeof raw['enabled'] !== 'boolean'
        || createdAt === null || !Number.isFinite(Date.parse(createdAt))) return null;
    items.push({ slug, revision, status, enabled: raw['enabled'], createdAt });
  }
  if (typeof value['total'] !== 'number' || value['total'] !== items.length) return null;
  return { businessId, businessVersion, items, total: items.length };
}

function parseProfileListRow(value: unknown): ProfileListRow | null {
  if (!isRecord(value)) return null;
  const tenantId = str(value['tenantId']);
  const businessId = str(value['businessId']);
  const businessVersion = str(value['businessVersion']);
  const profileName = str(value['profileName']);
  const status = str(value['status']);
  const revision = value['revision'];
  const keyCount = value['keyCount'];
  const boundActions = value['boundActions'];
  const createdAt = str(value['createdAt']);
  const updatedAt = str(value['updatedAt']);
  if (
    tenantId === null || tenantId.length === 0 ||
    businessId === null || businessId.length === 0 ||
    businessVersion === null || businessVersion.length === 0 ||
    profileName === null || profileName.length === 0 ||
    (status !== 'ACTIVE' && status !== 'DISABLED' && status !== 'UNKNOWN') ||
    typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1 ||
    typeof keyCount !== 'number' || !Number.isInteger(keyCount) || keyCount < 0 ||
    !Array.isArray(boundActions) || !boundActions.every((action) => typeof action === 'string' && action.length > 0) ||
    createdAt === null || updatedAt === null
  ) return null;
  return {
    tenantId,
    businessId,
    businessVersion,
    profileName,
    revision,
    status,
    keyCount,
    boundActions,
    createdAt,
    updatedAt,
  };
}

/** Strict page gate: malformed catalog rows must be shown as an unreadable response, not silently hidden. */
export function parseProfileListPage(
  value: unknown,
  expectedTenantId?: string,
  expectedBusinessId?: string | null,
): ProfileListPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: ProfileListRow[] = [];
  for (const raw of value['items']) {
    const parsed = parseProfileListRow(raw);
    if (parsed === null) return null;
    if (expectedTenantId !== undefined && parsed.tenantId !== expectedTenantId) return null;
    if (expectedBusinessId && parsed.businessId !== expectedBusinessId) return null;
    items.push(parsed);
  }
  const total = value['total'];
  const limit = value['limit'];
  const nextCursor = value['nextCursor'];
  const prevCursor = value['prevCursor'];
  if (
    typeof total !== 'number' || !Number.isInteger(total) || total < items.length ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || items.length > limit ||
    (nextCursor !== null && typeof nextCursor !== 'string') ||
    (prevCursor !== null && typeof prevCursor !== 'string')
  ) return null;
  return { items, total, limit, nextCursor, prevCursor };
}

// ---------------------------------------------------------------------------
// F2 — unique identity for the profile table view
// ---------------------------------------------------------------------------

/**
 * Canonical identity of a catalog row: the FULL four-tuple, JSON-encoded.
 *
 * JSON rather than a joined string because a separator inside a value must not
 * be confusable with a separator between values (`a:b`+`c` vs `a`+`b:c`),
 * and because `tenantId` participates: the backend has no row `id`, so this
 * tuple IS the identity, and a page scoped to more than one tenant can repeat a
 * triple that differs only in the tenant.
 */
export function profileRowIdentity(row: ProfileListRow): string {
  return JSON.stringify([row.tenantId, row.businessId, row.businessVersion, row.profileName]);
}

export interface KeyedProfileListRow {
  row: ProfileListRow;
  /** Unique within one keyProfileListRows() result; stable for a given input order. */
  key: string;
  /** Canonical identity — repeats when the wire repeats a row. */
  identity: string;
  /** 0-based occurrence, so a wire duplicate stays VISIBLE instead of silently shadowing a row. */
  duplicateIndex: number;
}

/**
 * Assign React keys that stay unique even when the wire repeats a row.
 *
 * The page parser gates row SHAPE but not duplicates: a cursor bug or a
 * cross-tenant projection can return the same four-tuple twice, and a key
 * built from the visible columns would then collide — a dev warning today,
 * and mismatched row state on reconcile tomorrow. Disambiguating by
 * occurrence order keeps the key deterministic for a given input order, so
 * re-rendering the same data never remounts rows (no focus/state churn).
 */
export function keyProfileListRows(rows: readonly ProfileListRow[]): KeyedProfileListRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const identity = profileRowIdentity(row);
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    return { row, identity, key: identity + '#' + occurrence, duplicateIndex: occurrence };
  });
}

export interface ProfileListGroup {
  businessId: string;
  items: KeyedProfileListRow[];
}

/**
 * Group for the table body: businessId groups keep first-seen order and their
 * keys are unique because map keys are; the row keys come from
 * keyProfileListRows() so uniqueness holds across the WHOLE page, not only
 * inside one group.
 */
export function groupProfileListRows(rows: readonly ProfileListRow[]): ProfileListGroup[] {
  const groups = new Map<string, KeyedProfileListRow[]>();
  for (const keyed of keyProfileListRows(rows)) {
    const group = groups.get(keyed.row.businessId);
    if (group) group.push(keyed);
    else groups.set(keyed.row.businessId, [keyed]);
  }
  return [...groups].map(([businessId, items]) => ({ businessId, items }));
}

/** Honest hint per contract error code (shown next to the problem title). */
export function profileErrorHint(code: string | undefined): string | null {
  switch (code) {
    case 'PROFILE_LOCKED_FIELD':
      return 'A locked field was sent — locked slots must be omitted entirely, even when the value is unchanged.';
    case 'REVISION_CONFLICT':
      return 'The stored revision moved (CAS). The draft was kept; reload to compare and re-apply.';
    case 'PROFILE_SCOPE_GATE':
      return 'This session needs the assignment model (T-AUTH-03, gated on VFY-LOCAL).';
    case 'PROFILE_SCOPED_GATE':
      return 'Scoped-user mutations wait for T-AUTH-03 (VFY-LOCAL); only platform admins can write today.';
    case 'UPSTREAM_UNAVAILABLE':
      return 'The Profile API is not composed on this deployment yet (T-API-01..03).';
    case 'NOT_FOUND':
      return 'The backend answered 404 — the profile API is not shipped yet (T-API-01).';
    default:
      return null;
  }
}

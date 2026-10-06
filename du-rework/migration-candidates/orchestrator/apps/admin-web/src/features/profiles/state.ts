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
  ProfileCapability,
  ProfileDetail,
  ProfileParameterValue,
  ProfilePolicyRead,
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
  };
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

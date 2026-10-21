/**
 * PC-08 — Profile Group V2 draft model.
 *
 * Two server-owned counters are deliberately kept apart:
 *  - `revision`      the configuration revision (a save/rollback moves it);
 *  - `accessVersion` the root-grant access version (issue/revoke moves it).
 * A draft never derives one from the other, and no key id lives in the draft:
 * the V2 save body carries no `apiKey` at all (the root-grant ledger is a
 * separate, idempotent mutation).
 *
 * Pure module: no React, no DOM, no alias imports, so the orchestrator jest
 * suites can test it directly.
 */
import {
  ProfileGroupFunctionCatalogSchema,
  ProfileGroupV2ListSchema,
  ProfileGroupV2Schema,
  type ProfileEndpointPolicy,
  type ProfileEndpointPolicyRead,
  type ParameterResolution,
  type ParameterSource,
  type ProfileGroupFunction,
  type ProfileGroupFunctionCatalog,
  type ProfileGroupV2,
  type ProfileGroupV2Function,
  type ProfileGroupV2Save,
  type ProfileParameterValue,
} from '@du/contracts';

export interface ProfileGroupFunctionDraft {
  enabled: boolean;
  parameters: Record<string, ProfileParameterValue>;
  /** V2: request-time defaults, a sibling of `policy` — never inside it. */
  requestDefaults: Record<string, ProfileParameterValue>;
  jobPriority: 'LOW' | 'MEDIUM' | 'HIGH';
  allowedFileExtensions: string;
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
  /** Preserve safe, already-stored policy fields without exposing credentials. */
  readPolicy: ProfileEndpointPolicyRead | null;
  /** Server-owned child pin, display only. */
  childPin: { childProfileId: string; childRevision: number } | null;
  /** Server-owned manifest digest, display only. */
  manifestDigest: string;
  /**
   * Wave3-F4: the pinned workflow revision for a workflow function.
   *
   * Preserved from the read binding so editing another field never drops the
   * pin; falls back to the catalog's active revision at save time. `null` for
   * endpoint functions and for a workflow whose revision is not yet known.
   */
  workflowRevision: number | null;
}

export interface ProfileGroupMemberDraft {
  businessId: string;
  businessVersion: string;
  versions: string[];
  enabled: boolean | null;
  lifecycleRevision: number | null;
  catalog: ProfileGroupFunctionCatalog | null;
  catalogLoading: boolean;
  catalogProblem: string | null;
}

export interface ProfileGroupEditorDraft {
  groupId: string | null;
  tenantId: string;
  name: string;
  /** Only legal value in the frozen contract; kept explicit so a save is typed. */
  authMode: 'API_KEY';
  revision: number;
  accessVersion: number;
  authAuthority: 'CHILD_PROJECTION' | 'GROUP_GRANT';
  members: ProfileGroupMemberDraft[];
  selectedFunctionsByVersion: Record<string, string[]>;
  functionDrafts: Record<string, ProfileGroupFunctionDraft>;
}

export interface ProfileGroupErrorCopy {
  kind:
    | 'v2_required'
    | 'changed'
    | 'unauthorized'
    | 'revision_conflict'
    | 'precondition'
    | 'precondition_stale'
    | 'state'
    | 'invalid'
    | 'denied'
    | 'unknown';
  title: string;
  recovery: 'conversion_required' | 'reload' | 'select_granted_key' | 'review' | 'fix_input' | 'retry';
}

const SECRET_LIKE_KEY_RE = /(^|[_.-])(api[_-]?key|secret|token|password|passwd|credential|authorization|bearer|private[_-]?key)($|[_.-])/i;

export function secretLikeParameterKey(key: string): boolean {
  return SECRET_LIKE_KEY_RE.test(key);
}

/* ------------------------------------------------------------------ */
/* PC-R06 — lock metadata is part of the value, never a side effect    */
/* ------------------------------------------------------------------ */

function schemaPropertyDefinition(schema: Record<string, unknown>, parameter: string): Record<string, unknown> | null {
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return null;
  const definition = (properties as Record<string, unknown>)[parameter];
  return typeof definition === 'object' && definition !== null && !Array.isArray(definition)
    ? (definition as Record<string, unknown>)
    : null;
}

/**
 * The `defaultLocked` annotation a manifest may declare on a property
 * (`inputSchema.properties.<name>.defaultLocked`), mirroring the server's
 * `declaredDefaultLocked` helper. Returns `undefined` when the annotation is
 * absent or not a boolean, so the server's `??` chain falls through unchanged.
 */
export function schemaDeclaredLock(schema: Record<string, unknown>, parameter: string): boolean | undefined {
  const value = schemaPropertyDefinition(schema, parameter)?.['defaultLocked'];
  return value === true ? true : value === false ? false : undefined;
}

/**
 * The server's documented chain: `explicit isLocked ?? schema.defaultLocked ?? false`.
 * `false` is a real value and only `undefined` falls through.
 */
export function effectiveParameterLock(
  entry: ProfileParameterValue | undefined,
  schemaDefaultLocked: boolean | undefined,
): boolean {
  return entry?.isLocked ?? schemaDefaultLocked ?? false;
}

export type ParameterLockDisplay = 'locked' | 'unlocked-explicitly' | 'locked-by-schema' | 'unlocked';

export function parameterLockDisplay(
  entry: ProfileParameterValue | undefined,
  schemaDefaultLocked: boolean | undefined,
): ParameterLockDisplay {
  if (entry?.isLocked === true) return 'locked';
  if (entry?.isLocked === false) return 'unlocked-explicitly';
  if (schemaDefaultLocked === true) return 'locked-by-schema';
  return 'unlocked';
}

/**
 * PC-R06 — merge a new value into an existing parameter entry.
 *
 * Only `value` is replaced. Lock metadata is carried through verbatim:
 *  - `isLocked: true`  stays locked (never silently unlocks the field);
 *  - `isLocked: false` stays an explicit unlock (never silently re-locks a
 *    schema `defaultLocked: true` field);
 *  - an absent `isLocked` stays ABSENT, so `schema.defaultLocked` keeps
 *    applying. Writing `false` here would be a deliberate unlock, and a value
 *    edit is not one.
 *
 * The spread also preserves any per-field metadata the frozen contract carries,
 * and `null`, `false`, `0` or `''` is stored as-is (never coerced by truthiness).
 */
export function withParameterValue(
  existing: ProfileParameterValue | undefined,
  value: unknown,
): ProfileParameterValue {
  const next: ProfileParameterValue = { ...(existing ?? {}), value };
  // Drop an explicitly-undefined lock so the JSON body never carries the key.
  if (next.isLocked === undefined) delete next.isLocked;
  return next;
}

/** Immutable map update built on {@link withParameterValue}. */
export function setParameterValue(
  entries: Record<string, ProfileParameterValue>,
  parameter: string,
  value: unknown,
): Record<string, ProfileParameterValue> {
  return { ...entries, [parameter]: withParameterValue(entries[parameter], value) };
}

export function profileGroupFunctionDraftKey(businessId: string, businessVersion: string, functionId: string): string {
  return JSON.stringify([businessId, businessVersion, functionId]);
}

export function profileGroupMemberDraftKey(businessId: string, businessVersion: string): string {
  return JSON.stringify([businessId, businessVersion]);
}

export function parseProfileGroupList(value: unknown): { groups: ProfileGroupV2[] } | null {
  const result = ProfileGroupV2ListSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProfileGroup(value: unknown): ProfileGroupV2 | null {
  const result = ProfileGroupV2Schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProfileGroupFunctionCatalog(value: unknown): ProfileGroupFunctionCatalog | null {
  const result = ProfileGroupFunctionCatalogSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function emptyProfileGroupFunctionDraft(): ProfileGroupFunctionDraft {
  return {
    enabled: true,
    parameters: {},
    requestDefaults: {},
    jobPriority: 'MEDIUM',
    allowedFileExtensions: '',
    connectorBindings: {},
    readPolicy: null,
    childPin: null,
    manifestDigest: '',
    workflowRevision: null,
  };
}

/* ------------------------------------------------------------------ */
/* PC-R07 — one declared source per parameter, never inferred          */
/* ------------------------------------------------------------------ */

export interface ParameterResolutionDescriptor {
  /** The manifest's declared map; absent = capability not declared (v1). */
  parameterResolution?: ParameterResolution | undefined;
  profileSchema: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

export interface ParameterSourcePartition {
  /** True only when the manifest declares the `parameterResolution` capability. */
  declared: boolean;
  /** `profileSchema` filtered to properties NOT declared as requestDefaults. */
  profileSettingsSchema: Record<string, unknown>;
  /** `inputSchema` filtered to declared requestDefaults; null when undeclared. */
  requestDefaultsSchema: Record<string, unknown> | null;
  profileSettingNames: string[];
  requestDefaultNames: string[];
}

/** A property with no declared mapping stays a profile setting (v1 semantics). */
export function parameterSourceOf(
  resolution: ParameterResolution | undefined,
  parameter: string,
): ParameterSource {
  return resolution?.[parameter] === 'requestDefaults' ? 'requestDefaults' : 'profileSettings';
}

function filterSchemaProperties(
  schema: Record<string, unknown>,
  keep: (parameter: string) => boolean,
): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(schemaProperties(schema)).filter(([parameter]) => keep(parameter)),
  );
  const next: Record<string, unknown> = { ...schema, properties: kept };
  if (Array.isArray(schema['required'])) {
    next['required'] = schema['required'].filter(
      (parameter): parameter is string => typeof parameter === 'string' && keep(parameter),
    );
  }
  return next;
}

/**
 * Splits the descriptor's two schemas by the manifest's DECLARED source.
 *
 * - opt-in manifest: profile settings keeps every profileSchema property that is
 *   not declared `requestDefaults` (an undeclared property is a profile setting
 *   by the contract's default), request defaults keeps only declared ones.
 *   `inputSchema` properties that are client input are therefore not rendered
 *   anywhere, and the `profileSchema`/`inputSchema` overlap resolves to one side.
 * - capability-free v1 manifest: profile settings keeps the whole schema and
 *   request defaults stay `null` (the caller must disable/omit them — they are
 *   inert under v1 merge semantics).
 */
export function partitionParameterSchemas(descriptor: ParameterResolutionDescriptor): ParameterSourcePartition {
  const resolution = descriptor.parameterResolution;
  const declared = resolution !== undefined;
  const profileSettingsSchema = declared
    ? filterSchemaProperties(descriptor.profileSchema, (parameter) => parameterSourceOf(resolution, parameter) !== 'requestDefaults')
    : descriptor.profileSchema;
  const requestDefaultsSchema = declared
    ? filterSchemaProperties(descriptor.inputSchema, (parameter) => parameterSourceOf(resolution, parameter) === 'requestDefaults')
    : null;
  return {
    declared,
    profileSettingsSchema,
    requestDefaultsSchema,
    profileSettingNames: Object.keys(schemaProperties(profileSettingsSchema)),
    requestDefaultNames: requestDefaultsSchema === null ? [] : Object.keys(schemaProperties(requestDefaultsSchema)),
  };
}

/** Copy for a capability-free manifest; null when the capability is declared. */
export function requestDefaultsCapabilityNotice(partition: ParameterSourcePartition): string | null {
  if (partition.declared) return null;
  return 'Request defaults require an opt-in manifest capability (parameterResolution). This registered manifest does not declare it, so request defaults are inert and are not editable here.';
}

/** Copy for an opt-in manifest that declares no requestDefaults properties. */
export function requestDefaultsEmptyMessage(partition: ParameterSourcePartition): string | null {
  if (!partition.declared || partition.requestDefaultNames.length > 0) return null;
  return 'This function declares no request defaults.';
}

/**
 * Partitions stored entries by declared source. With no capability the entries
 * are returned untouched: a v1 manifest ignores request defaults, but destroying
 * stored inert values on save would be data loss, not a fix.
 */
export function filterParameterEntriesForSource(
  entries: Record<string, ProfileParameterValue>,
  resolution: ParameterResolution | undefined,
  keep: ParameterSource,
): { kept: Record<string, ProfileParameterValue>; dropped: string[] } {
  if (resolution === undefined) return { kept: entries, dropped: [] };
  const kept: Record<string, ProfileParameterValue> = {};
  const dropped: string[] = [];
  for (const [parameter, entry] of Object.entries(entries)) {
    if (parameterSourceOf(resolution, parameter) === keep) kept[parameter] = entry;
    else dropped.push(parameter);
  }
  dropped.sort();
  return { kept, dropped };
}

/**
 * Stored values that sit in the wrong source. The editor surfaces these instead
 * of silently migrating or hiding them; the save body keeps only the declared
 * source (see `filterParameterEntriesForSource`).
 */
export function misplacedParameterEntries(
  resolution: ParameterResolution | undefined,
  parameters: Record<string, ProfileParameterValue>,
  requestDefaults: Record<string, ProfileParameterValue>,
): { profileSettings: string[]; requestDefaults: string[] } {
  if (resolution === undefined) return { profileSettings: [], requestDefaults: [] };
  const misplacedProfileSettings = Object.keys(parameters)
    .filter((parameter) => parameterSourceOf(resolution, parameter) === 'requestDefaults')
    .sort();
  const misplacedRequestDefaults = Object.keys(requestDefaults)
    .filter((parameter) => parameterSourceOf(resolution, parameter) !== 'requestDefaults')
    .sort();
  return { profileSettings: misplacedProfileSettings, requestDefaults: misplacedRequestDefaults };
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties'];
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

/**
 * Fill manifest profile-schema defaults so a required-but-defaulted setting is
 * saved explicitly (v1 parity). Request defaults are NOT auto-filled: a request
 * default is an explicit operator decision, and injecting schema defaults would
 * make `appliedRequestDefaults` claim a decision nobody made.
 */
function profileParametersWithDefaults(
  parameters: Record<string, ProfileParameterValue>,
  profileSchema: Record<string, unknown>,
): Record<string, ProfileParameterValue> {
  const result = { ...parameters };
  for (const [parameter, rawDefinition] of Object.entries(schemaProperties(profileSchema))) {
    if (Object.prototype.hasOwnProperty.call(result, parameter)) continue;
    if (typeof rawDefinition !== 'object' || rawDefinition === null || Array.isArray(rawDefinition)) continue;
    const definition = rawDefinition as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(definition, 'default')) {
      result[parameter] = { value: definition['default'] };
    }
  }
  return result;
}

export function profileGroupFunctionDraftFromBinding(binding: ProfileGroupV2Function): ProfileGroupFunctionDraft {
  const parameters: Record<string, ProfileParameterValue> = {};
  for (const [key, parameter] of Object.entries(binding.policy.parameters)) {
    parameters[key] = {
      value: parameter.value,
      ...(parameter.isLocked !== undefined ? { isLocked: parameter.isLocked } : {}),
    };
  }
  const requestDefaults: Record<string, ProfileParameterValue> = {};
  for (const [key, parameter] of Object.entries(binding.requestDefaults)) {
    requestDefaults[key] = {
      value: parameter.value,
      ...(parameter.isLocked !== undefined ? { isLocked: parameter.isLocked } : {}),
    };
  }
  return {
    enabled: binding.policy.enabled,
    parameters,
    requestDefaults,
    jobPriority: binding.policy.jobPriority,
    allowedFileExtensions: binding.policy.allowedFileExtensions,
    connectorBindings: { ...binding.connectorBindings },
    readPolicy: binding.policy,
    childPin: { childProfileId: binding.childProfileId, childRevision: binding.childRevision },
    manifestDigest: binding.manifestDigest,
    // Wave3-F4: keep the stored pin. An endpoint binding never carries one.
    workflowRevision: binding.kind === 'workflow' && binding.workflowRevision !== undefined
      ? binding.workflowRevision
      : null,
  };
}

/**
 * Wave3-F4: the ONE resolution rule for a workflow function's saved revision.
 *
 * A pin already carried by the draft (stored binding or explicit selection) wins
 * over the catalog's tenant-active default — exactly the precedence the save body
 * uses. Endpoint functions never carry a revision, and a value the frozen
 * contract would reject (non-integer or non-positive) resolves to `null`, so the
 * editor displays precisely the revision the body will carry.
 */
export function resolveEffectiveWorkflowRevision(
  config: { workflowRevision?: number | null },
  descriptor: { kind: 'endpoint' | 'workflow'; workflowRevision?: number },
): number | null {
  if (descriptor.kind !== 'workflow') return null;
  const revision = config.workflowRevision ?? descriptor.workflowRevision;
  return revision !== undefined && Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function profileGroupDraftFromRead(group: ProfileGroupV2): ProfileGroupEditorDraft {
  const functionDrafts: Record<string, ProfileGroupFunctionDraft> = {};
  const selectedFunctionsByVersion: Record<string, string[]> = {};
  const members = group.businesses.map((business): ProfileGroupMemberDraft => {
    for (const binding of business.functions) {
      functionDrafts[profileGroupFunctionDraftKey(business.businessId, business.businessVersion, binding.functionId)] =
        profileGroupFunctionDraftFromBinding(binding);
    }
    selectedFunctionsByVersion[profileGroupMemberDraftKey(business.businessId, business.businessVersion)] =
      business.functions.map((binding) => binding.functionId);
    return {
      businessId: business.businessId,
      businessVersion: business.businessVersion,
      versions: [business.businessVersion],
      enabled: null,
      lifecycleRevision: null,
      catalog: null,
      catalogLoading: false,
      catalogProblem: null,
    };
  });
  return {
    groupId: group.groupId,
    tenantId: group.tenantId,
    name: group.name,
    authMode: group.authMode,
    revision: group.revision,
    accessVersion: group.accessVersion,
    authAuthority: group.authAuthority,
    members,
    selectedFunctionsByVersion,
    functionDrafts,
  };
}

/** Only a converted (root-grant) group accepts V2 writes. */
export function profileGroupWritesAllowed(draft: Pick<ProfileGroupEditorDraft, 'authAuthority'> | null): boolean {
  return draft !== null && draft.authAuthority === 'GROUP_GRANT';
}

export function validateProfileGroupDraft(draft: ProfileGroupEditorDraft): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0 || draft.name.trim().length > 120) errors.push('Enter a profile group name up to 120 characters.');
  if (draft.members.length === 0) errors.push('Select at least one enabled registered business.');
  for (const member of draft.members) {
    const label = `${member.businessId}@${member.businessVersion || 'no version selected'}`;
    if (member.enabled !== true) errors.push(`${label} is not currently enabled. Refresh the business catalog before saving.`);
    if (!member.businessVersion) errors.push(`${member.businessId} needs a registered version.`);
    if (member.catalogLoading) errors.push(`${label} function catalog is still loading.`);
    if (member.catalogProblem) errors.push(`${label} function catalog could not be read.`);
    if (!member.catalog) errors.push(`${label} has no selected-version function catalog.`);
    if (member.catalog && (member.catalog.businessId !== member.businessId
        || member.catalog.businessVersion !== member.businessVersion)) {
      errors.push(`${label} function catalog does not match the selected business version.`);
    }
    if (member.catalog && !member.catalog.businessEnabled) errors.push(`${label} was disabled while this editor was open.`);
    const selectedFunctionIds = draft.selectedFunctionsByVersion[profileGroupMemberDraftKey(member.businessId, member.businessVersion)] ?? [];
    if (selectedFunctionIds.length === 0) errors.push(`${label} needs at least one selected function.`);
    for (const functionId of selectedFunctionIds) {
      const descriptor = member.catalog?.functions.find((item) => item.functionId === functionId);
      if (!descriptor) {
        errors.push(`${label} function ${functionId} is not present in the selected manifest.`);
        continue;
      }
      if (descriptor.available === false) {
        errors.push(`${label} function ${functionId} is unavailable: ${descriptor.unavailableReason ?? 'the selected manifest does not support it'}.`);
      }
      const key = profileGroupFunctionDraftKey(member.businessId, member.businessVersion, functionId);
      const config = draft.functionDrafts[key] ?? emptyProfileGroupFunctionDraft();
      // PC-R07: a declared requestDefaults property is never a profile setting,
      // so it must not be demanded here even when the manifest's profileSchema
      // shares the property name (example-review v3's `enableReasoning` overlap).
      const partition = partitionParameterSchemas(descriptor);
      const properties = schemaProperties(partition.profileSettingsSchema);
      const requiredProfileFields = Array.isArray(partition.profileSettingsSchema['required'])
        ? partition.profileSettingsSchema['required'].filter((field): field is string => typeof field === 'string')
        : [];
      for (const parameter of requiredProfileFields) {
        const value = profileParametersWithDefaults(config.parameters, descriptor.profileSchema)[parameter]?.value;
        if (value === undefined || value === '') errors.push(`${label} function ${functionId} needs profile setting ${parameter}.`);
        if (!(parameter in properties)) errors.push(`${label} function ${functionId} schema requires unknown profile setting ${parameter}.`);
      }
      for (const slot of descriptor.connectorSlots) {
        if (slot.required && !config.connectorBindings[slot.name]) {
          errors.push(`${label} function ${functionId} needs connector slot ${slot.name}.`);
        }
      }
      for (const requestDefault of Object.keys(config.requestDefaults)) {
        if (secretLikeParameterKey(requestDefault)) {
          errors.push(`${label} function ${functionId} request default ${requestDefault} looks like a credential; provider credentials belong to the connector.`);
        }
      }
    }
  }
  return errors;
}

function writePolicy(
  config: ProfileGroupFunctionDraft,
  profileSchema: Record<string, unknown>,
  parameters: Record<string, ProfileParameterValue>,
): ProfileEndpointPolicy {
  const base = config.readPolicy;
  return {
    enabled: config.enabled,
    parameters: profileParametersWithDefaults(parameters, profileSchema),
    jobPriority: config.jobPriority,
    allowedFileExtensions: config.allowedFileExtensions,
    ...(base?.allowedOrigins !== undefined ? { allowedOrigins: base.allowedOrigins } : {}),
    ...(base?.connectionsOverride !== undefined ? { connectionsOverride: base.connectionsOverride } : {}),
    ...(base?.requestRedaction !== undefined ? { requestRedaction: base.requestRedaction } : {}),
    ...(base?.callbackPolicy !== undefined ? { callbackPolicy: base.callbackPolicy } : {}),
  };
}

/**
 * Builds the V2 save body. `apiKey` is intentionally absent: a group has no
 * singular key, and the contract rejects one if a caller reintroduces it.
 */
export function buildProfileGroupSaveBody(
  draft: ProfileGroupEditorDraft,
  tenantId: string,
  expectedRevision = draft.revision,
): ProfileGroupV2Save {
  const businesses = draft.members.map((member) => {
    const catalog = member.catalog;
    if (!catalog || catalog.businessId !== member.businessId || catalog.businessVersion !== member.businessVersion) {
      throw new Error(`Selected function catalog is missing for ${member.businessId}@${member.businessVersion}.`);
    }
    const selectedFunctionIds = draft.selectedFunctionsByVersion[profileGroupMemberDraftKey(member.businessId, member.businessVersion)] ?? [];
    const functions = selectedFunctionIds.map((functionId) => {
      const descriptor: ProfileGroupFunction | undefined = catalog.functions.find((item) => item.functionId === functionId);
      if (!descriptor || descriptor.available === false) throw new Error(`Selected function ${functionId} is unavailable in the current catalog.`);
      const config = draft.functionDrafts[profileGroupFunctionDraftKey(member.businessId, member.businessVersion, functionId)]
        ?? emptyProfileGroupFunctionDraft();
      // PC-R07: each parameter is saved only to its DECLARED source. With no
      // capability the entries pass through untouched (v1 ignores request
      // defaults; deleting inert legacy values would be data loss).
      const partition = partitionParameterSchemas(descriptor);
      const profileParameters = filterParameterEntriesForSource(
        config.parameters,
        descriptor.parameterResolution,
        'profileSettings',
      ).kept;
      const requestDefaultParameters = filterParameterEntriesForSource(
        config.requestDefaults,
        descriptor.parameterResolution,
        'requestDefaults',
      ).kept;
      // Wave3-F4: display and save share `resolveEffectiveWorkflowRevision`, so
      // the editor can never show a revision the body does not carry. A workflow
      // with no resolvable pin omits it rather than fabricating one; the frozen
      // contract then refuses the body exactly as it did before.
      const workflowRevision = resolveEffectiveWorkflowRevision(config, descriptor);
      return {
        kind: descriptor.kind,
        functionId: descriptor.functionId,
        action: descriptor.action,
        ...(descriptor.endpointSlug ? { endpointSlug: descriptor.endpointSlug } : {}),
        ...(workflowRevision !== null ? { workflowRevision } : {}),
        policy: writePolicy(config, partition.profileSettingsSchema, profileParameters),
        requestDefaults: { ...requestDefaultParameters },
        connectorBindings: { ...config.connectorBindings },
      };
    });
    return {
      businessId: member.businessId,
      businessVersion: member.businessVersion,
      manifestDigest: catalog.manifestDigest,
      functions,
    };
  });
  return {
    name: draft.name.trim(),
    ...(tenantId ? { tenantId } : {}),
    authMode: 'API_KEY',
    expectedRevision,
    businesses,
  };
}

export function isProfileGroupRevisionConflict(status: number, code: string | undefined): boolean {
  return status === 409 && code === 'REVISION_CONFLICT';
}

/**
 * One copy source for every V2 failure. The BFF replaces the upstream problem
 * title with a generic sentence (`bff/envelope.ts`), so the UI must branch on
 * `code` — never on `title`.
 */
export function resolveProfileGroupV2Error(problem: { status: number; code?: string }): ProfileGroupErrorCopy {
  switch (problem.code) {
    case 'PROFILE_GROUP_V2_REQUIRED':
      return {
        kind: 'v2_required',
        title: 'This profile group still uses the legacy child projection. Configuration and root grants become editable only after the group is converted.',
        recovery: 'conversion_required',
      };
    case 'PROFILE_CHANGED':
      return {
        kind: 'changed',
        title: 'The pinned resolution changed since this page was loaded. Reload before saving or testing again.',
        recovery: 'reload',
      };
    case 'PROFILE_GROUP_UNAUTHORIZED':
      return {
        kind: 'unauthorized',
        title: 'The selected API key holds no current root grant for this profile group. Select a granted key or issue a grant first.',
        recovery: 'select_granted_key',
      };
    case 'REVISION_CONFLICT':
      return {
        kind: 'revision_conflict',
        title: 'This profile group changed while you were editing. Your draft is preserved; reload the current configuration before saving again.',
        recovery: 'reload',
      };
    case 'PRECONDITION_REQUIRED':
      return {
        kind: 'precondition',
        title: 'The access version was missing from the request. Reload the group and retry the grant action.',
        recovery: 'reload',
      };
    case 'PRECONDITION_FAILED':
      return {
        kind: 'precondition_stale',
        title: 'The access version is stale: a root grant was issued or revoked in the meantime. Reload the grants before trying again.',
        recovery: 'reload',
      };
    case 'STATE_CONFLICT':
      return {
        kind: 'state',
        title: 'The profile group rejected this change. Review the highlighted field and the current registry state.',
        recovery: 'review',
      };
    case 'INVALID_SCHEMA':
      return {
        kind: 'invalid',
        title: 'The request did not match the profile-group contract. Review the highlighted fields.',
        recovery: 'fix_input',
      };
    case 'PERMISSION_DENIED':
    case 'PROFILE_SCOPED_GATE':
    case 'PROFILE_GROUP_ASSIGNMENT_REQUIRED':
    case 'ADMIN_CREDENTIAL_REQUIRED':
      return {
        kind: 'denied',
        title: 'This session cannot change profile groups. Profile-group configuration is platform-admin only.',
        recovery: 'review',
      };
    default:
      return {
        kind: 'unknown',
        title: `The profile-group request failed (${problem.status}). Refresh before retrying.`,
        recovery: 'retry',
      };
  }
}

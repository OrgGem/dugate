import {
  ProfileGroupFunctionCatalogSchema,
  ProfileGroupListSchema,
  ProfileGroupSchema,
  type ProfileEndpointPolicy,
  type ProfileGroup,
  type ProfileGroupBusinessInput,
  type ProfileGroupFunction,
  type ProfileGroupFunctionBinding,
  type ProfileGroupFunctionCatalog,
  type ProfileGroupList,
  type ProfileGroupSave,
} from '@du/contracts';
import type { ProfileParameterValue } from '@/lib/api';

export interface ProfileGroupFunctionDraft {
  enabled: boolean;
  parameters: Record<string, ProfileParameterValue>;
  jobPriority: 'LOW' | 'MEDIUM' | 'HIGH';
  allowedFileExtensions: string;
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
  /** Preserve safe, already-stored policy fields without exposing credential values. */
  readPolicy: ProfileGroupFunctionBinding['policy'] | null;
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
  apiKeyId: string;
  revision: number;
  members: ProfileGroupMemberDraft[];
  selectedFunctionsByVersion: Record<string, string[]>;
  functionDrafts: Record<string, ProfileGroupFunctionDraft>;
}

export function profileGroupFunctionDraftKey(businessId: string, businessVersion: string, functionId: string): string {
  return JSON.stringify([businessId, businessVersion, functionId]);
}

export function profileGroupMemberDraftKey(businessId: string, businessVersion: string): string {
  return JSON.stringify([businessId, businessVersion]);
}

export function parseProfileGroupList(value: unknown): ProfileGroupList | null {
  const result = ProfileGroupListSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProfileGroup(value: unknown): ProfileGroup | null {
  const result = ProfileGroupSchema.safeParse(value);
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
    jobPriority: 'MEDIUM',
    allowedFileExtensions: '',
    connectorBindings: {},
    readPolicy: null,
  };
}

function profileParametersWithDefaults(
  parameters: Record<string, ProfileParameterValue>,
  profileSchema: Record<string, unknown>,
): Record<string, ProfileParameterValue> {
  const properties = typeof profileSchema['properties'] === 'object'
    && profileSchema['properties'] !== null
    && !Array.isArray(profileSchema['properties'])
    ? profileSchema['properties'] as Record<string, unknown>
    : {};
  const result = { ...parameters };
  for (const [parameter, rawDefinition] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(result, parameter)
        || typeof rawDefinition !== 'object' || rawDefinition === null || Array.isArray(rawDefinition)) continue;
    const definition = rawDefinition as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(definition, 'default')) {
      result[parameter] = { value: definition['default'] };
    }
  }
  return result;
}

export function profileGroupFunctionDraftFromBinding(binding: ProfileGroupFunctionBinding): ProfileGroupFunctionDraft {
  const parameters: Record<string, ProfileParameterValue> = {};
  for (const [key, parameter] of Object.entries(binding.policy.parameters)) {
    parameters[key] = {
      value: parameter.value,
      ...(parameter.isLocked !== undefined ? { isLocked: parameter.isLocked } : {}),
    };
  }
  return {
    enabled: binding.policy.enabled,
    parameters,
    jobPriority: binding.policy.jobPriority,
    allowedFileExtensions: binding.policy.allowedFileExtensions,
    connectorBindings: { ...binding.connectorBindings },
    readPolicy: binding.policy,
  };
}

export function profileGroupDraftFromRead(group: ProfileGroup): ProfileGroupEditorDraft {
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
    apiKeyId: group.apiKey.apiKeyId,
    revision: group.revision,
    members,
    selectedFunctionsByVersion,
    functionDrafts,
  };
}

export function validateProfileGroupDraft(draft: ProfileGroupEditorDraft): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0 || draft.name.trim().length > 120) errors.push('Enter a profile group name up to 120 characters.');
  if (!draft.apiKeyId) errors.push('Select an existing active API key for this tenant.');
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
      const profileProperties = typeof descriptor.profileSchema.properties === 'object' && descriptor.profileSchema.properties !== null
        && !Array.isArray(descriptor.profileSchema.properties)
        ? descriptor.profileSchema.properties as Record<string, unknown>
        : {};
      const requiredProfileFields = Array.isArray(descriptor.profileSchema.required)
        ? descriptor.profileSchema.required.filter((field): field is string => typeof field === 'string')
        : [];
      for (const parameter of requiredProfileFields) {
        const value = profileParametersWithDefaults(config.parameters, descriptor.profileSchema)[parameter]?.value;
        if (value === undefined || value === '') errors.push(`${label} function ${functionId} needs profile setting ${parameter}.`);
        if (!(parameter in profileProperties)) errors.push(`${label} function ${functionId} schema requires unknown profile setting ${parameter}.`);
      }
      for (const slot of descriptor.connectorSlots) {
        if (slot.required && !config.connectorBindings[slot.name]) {
          errors.push(`${label} function ${functionId} needs connector slot ${slot.name}.`);
        }
      }
    }
  }
  return errors;
}

function writePolicy(config: ProfileGroupFunctionDraft, profileSchema: Record<string, unknown>): ProfileEndpointPolicy {
  const base = config.readPolicy;
  return {
    enabled: config.enabled,
    parameters: profileParametersWithDefaults(config.parameters, profileSchema),
    jobPriority: config.jobPriority,
    allowedFileExtensions: config.allowedFileExtensions,
    ...(base?.allowedOrigins !== undefined ? { allowedOrigins: base.allowedOrigins } : {}),
    ...(base?.connectionsOverride !== undefined ? { connectionsOverride: base.connectionsOverride } : {}),
    ...(base?.requestRedaction !== undefined ? { requestRedaction: base.requestRedaction } : {}),
    ...(base?.callbackPolicy !== undefined ? { callbackPolicy: base.callbackPolicy } : {}),
  };
}

export function buildProfileGroupSaveBody(
  draft: ProfileGroupEditorDraft,
  tenantId: string,
  expectedRevision = draft.revision,
): ProfileGroupSave {
  const businesses: ProfileGroupBusinessInput[] = draft.members.map((member) => {
    const catalog = member.catalog;
    if (!catalog || catalog.businessId !== member.businessId || catalog.businessVersion !== member.businessVersion) {
      throw new Error(`Selected function catalog is missing for ${member.businessId}@${member.businessVersion}.`);
    }
    const selectedFunctionIds = draft.selectedFunctionsByVersion[profileGroupMemberDraftKey(member.businessId, member.businessVersion)] ?? [];
    const functions: ProfileGroupBusinessInput['functions'] = selectedFunctionIds.map((functionId) => {
      const descriptor: ProfileGroupFunction | undefined = catalog.functions.find((item) => item.functionId === functionId);
      if (!descriptor || descriptor.available === false) throw new Error(`Selected function ${functionId} is unavailable in the current catalog.`);
      const config = draft.functionDrafts[profileGroupFunctionDraftKey(member.businessId, member.businessVersion, functionId)]
        ?? emptyProfileGroupFunctionDraft();
      return {
        kind: descriptor.kind,
        functionId: descriptor.functionId,
        action: descriptor.action,
        ...(descriptor.endpointSlug ? { endpointSlug: descriptor.endpointSlug } : {}),
        ...(descriptor.workflowRevision ? { workflowRevision: descriptor.workflowRevision } : {}),
        policy: writePolicy(config, descriptor.profileSchema),
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
    apiKey: { apiKeyId: draft.apiKeyId },
    expectedRevision,
    businesses,
  };
}

export function isProfileGroupRevisionConflict(status: number, code: string | undefined): boolean {
  return status === 409 && code === 'REVISION_CONFLICT';
}


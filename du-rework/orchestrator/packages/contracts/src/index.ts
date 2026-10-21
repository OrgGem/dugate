/**
 * @du/contracts — wire contracts v1 for the DU rework platform.
 *
 * Public entrypoint. Everything peers import from '@du/contracts' is
 * re-exported here; module paths are stable per gates/contracts-v1.md.
 */

export * from './version';
export * from './errors';
export * from './manifest';
export * from './manifest-validator';
export * from './json-schema-guard';
export * from './operations';
export * from './profile-policy';
export * from './profile-commands';
export * from './runtime';
export * from './registry';
export * from './queue';
export * from './connector';
export * from './sdk';
export * from './public-api';
export * from './hashing';
export * from './ip-policy';
export * from './vault';
export * from './vault-policies';
export * from './oidc-claim-shapes';
export * from './usage-metrics';
export * from './pricing';
export * from './usage-reconciliation';
export * from './usage-budget';
export * from './encryption';
export * from './connector-management';
export * from './encryption';
export * from './encryption';
export * from './encryption';
export * from './encryption-persistence';
export * from './settings';
export * from './identity';
export * from './request-redaction';
export * from './profile-callback';
export * from './secret-catalog';
export * from './legacy-workflow';
// ORV14 centrally integrated admin feature contracts. Leaf owners author the
// schema files; this public barrel remains single-writer for all additions.
export * from './global-settings';
export * from './maintenance';
export * from './incidents';
export * from './workflow-import';
export * from './admin-workbench';
export * from './parity';
// Keep this value export explicit for browser bundlers that statically scan
// the CommonJS barrel (runtime `__exportStar` is not discoverable by Rollup).
import { ConnectorRecipeSchema as ParityConnectorRecipeSchema } from './parity';
export const ConnectorRecipeSchema = ParityConnectorRecipeSchema;
export * from './profile-self-service';
export * from './cost-control';
export * from './connector-signals';
export * from './connector-runtime-control';
export * from './service-runtime';
export * from './cost-alerts';
export * from './cost-adjustments';
export * from './tenant-connectors';
export * from './profile-groups';
// Keep this value export explicit for browser bundlers that statically scan
// the CommonJS barrel (runtime `__exportStar` is not discoverable by Rollup).
import { isTenantUuid as tenantUuidPredicate } from './tenant-identity';
export const isTenantUuid = tenantUuidPredicate;

// PC-01 profile-group control-plane V2 surface. The `export *` lines above
// already re-export these modules; this explicit value list repeats the reason
// given at ConnectorRecipeSchema/isTenantUuid — browser bundlers that
// statically scan the CommonJS barrel cannot see through `__exportStar`.
export {
  API_KEY_MODES,
  ApiKeyModeSchema,
  ProfileGroupAccessVersionSchema,
  ProfileGroupAuthAuthoritySchema,
  ProfileGroupAuthModeSchema,
  ProfileGroupDigestPinSchema,
  ProfileGroupDigestReadSchema,
  ProfileGroupEffectiveParametersV2Schema,
  ProfileGroupFunctionSelectorV2Schema,
  ProfileGroupKeyGrantSchema,
  ProfileGroupKeyIssueInputSchema,
  ProfileGroupKeyIssueResultSchema,
  ProfileGroupKeyRevokeInputSchema,
  ProfileGroupKeyRevokeResultSchema,
  ProfileGroupPreviewV2RequestSchema,
  ProfileGroupPreviewV2ResponseSchema,
  ProfileGroupRequestDefaultsReadSchema,
  ProfileGroupRequestDefaultsSchema,
  ProfileGroupResolutionRefsV2Schema,
  ProfileGroupRevokedKeyGrantSchema,
  ProfileGroupSubmitV2RequestSchema,
  ProfileGroupV2BusinessInputSchema,
  ProfileGroupV2BusinessSchema,
  ProfileGroupV2FunctionInputSchema,
  ProfileGroupV2FunctionSchema,
  ProfileGroupV2ListSchema,
  ProfileGroupV2RollbackSchema,
  ProfileGroupV2SaveSchema,
  ProfileGroupV2Schema,
  PROFILE_GROUP_PROBLEM_CODES,
  ResolutionFingerprintSchema,
  computeResolutionFingerprint,
} from './profile-groups';
export {
  ParameterResolutionCapabilitySchema,
  ParameterResolutionSourceSchema,
} from './manifest';
export {
  AdminWorkbenchProfilePreviewV2RequestSchema,
  AdminWorkbenchProfilePreviewV2ResponseSchema,
  AdminWorkbenchProfileSubmitV2RequestSchema,
  AdminWorkbenchProfileSubmitV2ResponseSchema,
  AdminWorkbenchProfileSelectorV2Schema,
} from './admin-workbench';

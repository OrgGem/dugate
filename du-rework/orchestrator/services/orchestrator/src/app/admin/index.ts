/**
 * Admin UI headless foundation (P6-01).
 *
 * Pure view-model layer + rendered shell (P6-01). The shell's mount
 * helper (`attachAdminShell`) is exported here so the platform
 * `createApp` can wire it in with a single one-line call — no edits
 * inside the `src/app/**` module itself beyond this file.
 */
export * from './types';
export * from './view-models';
export * from './profile-view-models';
export * from './operation-view-models';
export * from './business-view-models';
export * from './api-key-view-models';
export * from './connector-view-models';
export * from './p6-01-shell-fixtures';
export * from './overview-view-models';
export { fetchOverview, resolveOverviewPresetWindow } from './overview-section-data';
export type {
  OverviewFetchResult,
  OverviewFetcherInput,
  OverviewOkResult,
  OverviewCatalog,
  OverviewBundle,
  OverviewTriageMetric,
  OverviewTriageSnapshot,
  OverviewTimePreset,
  UsageSummaryWireEnvelope,
  AuditListWireEnvelope,
} from './overview-section-data';
export { renderOverviewSection } from './overview-section-renderer';
export type {
  OverviewSectionRenderInput,
  OverviewSectionRenderOutput,
} from './overview-section-renderer';
export { maskConnectorHost } from './view-models';
export type { AdminShellRequest, AdminShellResponse, AdminShellRoute, AdminCookieClaims } from './shell-types';
export type { SectionFetchers, BusinessSectionFetcher, ProfileSectionFetcher, ConnectorSectionFetcher, ApiKeySectionFetcher, OperationSectionFetcher, OverviewSectionFetcher, OperationListQuery } from './shell-router';
export { parseOperationListQuery } from './shell-router';
export type { ShellRuntimeConfig } from './shell-router';
export { createAdminShellServer, attachAdminShell } from './shell-server';
export type { AdminShellHandle, CreateAdminShellServerOptions, AdminShellAttachInput, AdminShellAttachResult } from './shell-server';
export { fetchProfileForm } from './profile-section-data';
export type { ProfileFetchResult, ProfileFetcherInput, ProfileManifestWireRow } from './profile-section-data';
export { renderProfileSection, countUnknownFallbacks } from './profile-section-renderer';
export type { ProfileSectionRenderInput, ProfileSectionRenderOutput } from './profile-section-renderer';
export { fetchConnectorConfig } from './connector-section-data';
export type {
  ConnectorFetchResult,
  ConnectorFetcherInput,
  ConnectorRevisionCatalogEntry,
  ConnectorRevisionWireEnvelope,
} from './connector-section-data';
export { renderConnectorSection } from './connector-section-renderer';
export type {
  ConnectorSectionRenderInput,
  ConnectorSectionRenderOutput,
} from './connector-section-renderer';
export { fetchApiKeys, isApiKeyOkResult } from './api-key-section-data';
export type {
  ApiKeyFetchResult,
  ApiKeyFetcherInput,
  ApiKeyListOkResult,
  ApiKeyCatalog,
  ApiKeyCatalogEntry,
  ApiKeyWireRow,
  ApiKeyGrantWireRow,
  ApiKeyCopyOnceWireRow,
  ApiKeyListWireEnvelope,
} from './api-key-section-data';
export { renderApiKeySection } from './api-key-section-renderer';
export type {
  ApiKeySectionRenderInput,
  ApiKeySectionRenderOutput,
} from './api-key-section-renderer';
export {
  fetchOperationDetail,
  isOperationOkResult,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_DEFAULT_SORT,
  OPERATION_LIST_MAX_LIMIT,
  OPERATION_LIST_CURSOR_MAX_LEN,
  OPERATION_LIST_SORT_OPTIONS,
  clampListLimit,
  sanitizeSortFilter,
} from './operation-section-data';
export type {
  OperationListSort,
  OperationListSortOption,
} from './operation-section-data';
export type {
  OperationListOkResult,
  OperationListRow,
  OperationFetchResult,
  OperationFetcherInput,
  OperationDetailOkResult,
  OperationDetailWireEnvelope,
  OperationListWireEnvelope,
  OperationDetailCatalog,
  OperationDetailCatalogEntry,
  OperationResultDisplay,
  OperationArtifactDisplay,
} from './operation-section-data';
export { renderOperationSection } from './operation-section-renderer';
export type {
  OperationSectionRenderInput,
  OperationSectionRenderOutput,
} from './operation-section-renderer';

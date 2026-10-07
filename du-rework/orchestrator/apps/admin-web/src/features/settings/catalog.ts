/**
 * CFGADM-UI-PORT-P1 - the 17 legacy settings keys and their rework replacement.
 *
 * Source of truth: tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md section 3
 * ("Mapping toan bo 17 legacy settings"). The replacement ids are LOGICAL ids: the parity
 * task states the service owner freezes DTO/schema/path before code, so none of them is
 * asserted to exist as a route or a column today.
 *
 * There is NO frozen settings wire in this tree - packages/contracts has no Settings schema
 * at all. So every row is deployment-mechanism until a wire lands, and the screen renders
 * the honest disabled state instead of a fake write. Secrets are never rendered and never
 * echoed: a read wire does not exist, and a write path needs a Vault secret-ref adapter.
 */

export type SettingsGroup = 'ai' | 'prompt' | 'storage';

export interface SettingsCatalogRow {
  /** Legacy key as the operator typed it in the old Admin. */
  legacyKey: string;
  /** Business label the operator sees - no ids, no Vault refs. */
  label: string;
  /** Logical replacement id from the parity mapping. */
  replacement: string;
  /** Where the value lives once a wire exists. */
  scope: string;
  /** True when the value is a credential: never rendered, never echoed. */
  secret: boolean;
  /** Who owns the write path once it exists. */
  owner: string;
  group: SettingsGroup;
  /** retire = the parity task says retire pending a consumer inventory. */
  disposition: 'port' | 'retire';
}

export const SETTINGS_CATALOG: SettingsCatalogRow[] = [
  // CFGADM-01 - AI defaults: provider / model / base URL.
  { legacyKey: 'ai_provider', label: 'AI provider', replacement: 'aiDefaults.provider', scope: 'tenant policy + Connector binding revision', secret: false, owner: 'Policy + Connector', group: 'ai', disposition: 'port' },
  { legacyKey: 'ai_api_key', label: 'AI account credential', replacement: 'Gemini account credential (Vault secret-ref)', scope: 'tenant/account Vault', secret: true, owner: 'Connector/Vault', group: 'ai', disposition: 'port' },
  { legacyKey: 'ai_model', label: 'AI model', replacement: 'aiDefaults.model', scope: 'tenant default + Profile permitted override', secret: false, owner: 'Policy + business/Connector', group: 'ai', disposition: 'port' },
  { legacyKey: 'openai_api_key', label: 'OpenAI-compatible account credential', replacement: 'OpenAI-compatible account credential (Vault secret-ref)', scope: 'tenant/account', secret: true, owner: 'Connector/Vault', group: 'ai', disposition: 'port' },
  { legacyKey: 'openai_base_url', label: 'OpenAI-compatible base URL', replacement: 'OpenAI-compatible Connector config revision', scope: 'tenant/account', secret: false, owner: 'Connector', group: 'ai', disposition: 'port' },

  // CFGADM-02 - prompt defaults, five slots.
  { legacyKey: 'ai_image_prompt', label: 'Image prompt default', replacement: 'promptDefaults.image', scope: 'versioned business/tenant defaults', secret: false, owner: 'Policy + document-core', group: 'prompt', disposition: 'port' },
  { legacyKey: 'ai_pdf_prompt', label: 'PDF prompt default', replacement: 'promptDefaults.pdf', scope: 'versioned business/tenant defaults', secret: false, owner: 'Policy + document-core', group: 'prompt', disposition: 'port' },
  { legacyKey: 'ai_docx_prompt', label: 'DOCX prompt default', replacement: 'promptDefaults.docx', scope: 'versioned business/tenant defaults', secret: false, owner: 'Policy + document-core', group: 'prompt', disposition: 'port' },
  { legacyKey: 'ai_compare_prompt', label: 'Compare prompt default', replacement: 'promptDefaults.compare', scope: 'versioned business/tenant defaults', secret: false, owner: 'Policy + business', group: 'prompt', disposition: 'port' },
  { legacyKey: 'ai_generate_prompt', label: 'Generate prompt default', replacement: 'promptDefaults.generate', scope: 'versioned business/tenant defaults', secret: false, owner: 'Policy + business', group: 'prompt', disposition: 'port' },

  // CFGADM-03/04 - S3 endpoint/bucket/secret/region/TTL + cache/retention.
  { legacyKey: 's3_endpoint', label: 'S3 endpoint', replacement: 'storageConfig.endpoint', scope: 'platform storage generation', secret: false, owner: 'Platform/deployment + Artifact', group: 'storage', disposition: 'port' },
  { legacyKey: 's3_bucket', label: 'S3 bucket', replacement: 'storageConfig.bucket', scope: 'platform storage generation', secret: false, owner: 'Platform + Artifact', group: 'storage', disposition: 'port' },
  { legacyKey: 's3_access_key', label: 'S3 access key ID', replacement: 'storage identity/access ID (secret-ref metadata)', scope: 'platform secret owner', secret: true, owner: 'Platform secret owner', group: 'storage', disposition: 'port' },
  { legacyKey: 's3_secret_key', label: 'S3 secret key', replacement: 'storage credential (deployment secret manager/Vault ref)', scope: 'platform secret owner', secret: true, owner: 'Platform secret owner', group: 'storage', disposition: 'port' },
  { legacyKey: 's3_region', label: 'S3 region', replacement: 'storageConfig.region', scope: 'platform storage generation', secret: false, owner: 'Platform + Artifact', group: 'storage', disposition: 'port' },
  { legacyKey: 's3_cache_ttl_hours', label: 'Cache TTL (hours)', replacement: 'retentionPolicy.cacheTtlHours', scope: 'platform/tenant per storage ownership', secret: false, owner: 'Artifact/retention', group: 'storage', disposition: 'port' },

  // The parity task marks this one a retire decision, not a write target.
  { legacyKey: 'api_secret_key', label: 'Legacy API secret key', replacement: 'retire pending consumer inventory', scope: 'not managed here', secret: true, owner: 'LOCAL/COMP/CONT architect', group: 'ai', disposition: 'retire' },
];

export function settingsRowsByGroup(group: SettingsGroup): SettingsCatalogRow[] {
  return SETTINGS_CATALOG.filter((row) => row.group === group);
}

/** The honest reason a write control is disabled. Never a fake success. */
export function settingsWriteReason(row: SettingsCatalogRow): string {
  if (row.disposition === 'retire') {
    return 'Retire decision is owned by the CONT architect; this row is not a write target on this surface.';
  }
  if (row.secret) {
    return 'Secret values are never read into the browser and no read wire exists; a write path needs a Vault secret-ref adapter that is not shipped.';
  }
  return 'No settings wire and no writer action are shipped for this key yet; the value is boot-time deployment config.';
}

export const SETTINGS_GROUPS: Array<{ id: SettingsGroup; title: string; blurb: string }> = [
  { id: 'ai', title: 'AI defaults (CFGADM-01)', blurb: 'Provider, model and base URL. Credentials live in Vault as secret-refs; the browser never holds them.' },
  { id: 'prompt', title: 'Prompt defaults (CFGADM-02)', blurb: 'Five versioned prompt slots (image, PDF, DOCX, compare, generate) with per-business override.' },
  { id: 'storage', title: 'Storage and retention (CFGADM-03/04)', blurb: 'S3 endpoint/bucket/region, credentials as secret-refs, and cache TTL under retention policy.' },
];

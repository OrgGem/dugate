/**
 * CFGADM-UI-PORT-P1 - the 17 legacy settings keys and their rework replacement.
 *
 * Source of truth: tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md section 3
 * ("Mapping toan bo 17 legacy settings"). The replacement ids are LOGICAL ids: the parity
 * task records the logical mapping. The scoped native revision editor is
 * separate from tenant AI/prompt defaults, platform retention and storage
 * generation. Secrets are never rendered or echoed from this catalog.
 */

export type SettingsGroup = 'ai' | 'prompt' | 'storage';

export interface SettingsCatalogRow {
  /** Legacy key as the operator typed it in the old Admin. */
  legacyKey: string;
  /** Business label the operator sees - no ids, no Vault refs. */
  label: string;
  /** Logical replacement id from the parity mapping. */
  replacement: string;
  /** Scope of the owning versioned writer. */
  scope: string;
  /** True when the value is a credential: never rendered, never echoed. */
  secret: boolean;
  /** UI section that owns the write path. */
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

/** Why the legacy key is represented by its owning typed form. */
export function settingsWriteReason(row: SettingsCatalogRow): string {
  if (row.disposition === 'retire') {
    return 'Retire decision is owned by the CONT architect; this row is not a write target on this surface.';
  }
  if (row.secret) return 'The owning typed form writes secret material once and reads back only masked metadata and an opaque immutable revision reference.';
  return 'The owning typed form writes a versioned draft with review, effective state and rollback.';
}

export const SETTINGS_GROUPS: Array<{ id: SettingsGroup; title: string; blurb: string }> = [
  { id: 'ai', title: 'Legacy AI settings map (CFGADM-01)', blurb: 'Use Tenant AI defaults above to choose an active tenant Connector revision and model. Manage endpoint recipes and write-only credentials in Connectors; scoped Profile and key settings remain separate.' },
  { id: 'prompt', title: 'Legacy prompt settings map (CFGADM-02)', blurb: 'Use Tenant AI defaults above for five versioned prompt slots, EN/VI presets, placeholder checks and rollback. Per-key, per-endpoint overrides remain in the scoped editor.' },
  { id: 'storage', title: 'Legacy storage and retention map (CFGADM-03/04)', blurb: 'Use Storage generation for platform endpoint, bucket, region, exact managed credential revision and lifecycle; use Platform retention for cache TTL, output retention and cleanup. Presign URL lifetime is separate.' },
];

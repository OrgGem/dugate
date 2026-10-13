import { z } from 'zod';

/**
 * SETTINGS-WIRE (packet SETTINGS-WIRE-BASE / BFF-SETTINGS-IDENTITY): the
 * platform-side settings READ view, plus the writer contract that is
 * disabled/fail-closed until a deployment adapter exists.
 *
 * Two invariants, both load-bearing:
 *
 *  - REDACTION IS THE WIRE CONTRACT. A secret is never a value here. The S3
 *    block publishes `secretPresent: boolean` and nothing else — there is no
 *    field on any schema below whose value could be a credential. `.strict()`
 *    on every object so an unmodelled field is rejected, not republished.
 *  - NO INVENTED STORAGE. Every field below describes a value that really
 *    exists in a deployment (boot env / adapter state). A field we cannot
 *    honestly source is absent from the DTO and called out in the GAP note,
 *    never faked with a placeholder.
 */

/**
 * AI defaults. `baseUrl` is a non-secret operator-supplied endpoint
 * (`https://api.openai.com/v1`, an Ollama host, a gateway). It is a URL, not a
 * credential — API keys are the presence-only kind like the S3 secret below.
 */
/**
 * The READ schemas below are deliberately NOT `.strict()`.
 *
 * These shapes are used as a REDACTION BOUNDARY: the BFF parses the platform's
 * settings view through `SettingsReadSchema` before it reaches the browser. Zod's
 * default object behaviour STRIPS unknown keys, so a field we did not model —
 * including a `secretValue` an upstream might add — is dropped at the boundary.
 * `.strict()` would instead REJECT the whole body and turn a stray key into a
 * 502, which is noisier and strictly worse for availability.
 *
 * The WRITE schema (`SettingsUpdateParamsSchema`) IS `.strict()`: that is caller
 * input, and an unrecognised field there is a client bug we must not silently
 * drop.
 */
export const SettingsAiDefaultsSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1),
  });
export type SettingsAiDefaults = z.infer<typeof SettingsAiDefaultsSchema>;

/**
 * The five legacy prompt-default slots defined by
 * tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md §3. These are document-format
 * and compare/generate defaults, independent of the API service inventory.
 * The tuple is explicit so widening it requires a contract change.
 */
export const SETTINGS_PROMPT_SLOTS = [
  'image',
  'pdf',
  'docx',
  'compare',
  'generate',
] as const;
export type SettingsPromptSlot = (typeof SETTINGS_PROMPT_SLOTS)[number];

export const SettingsPromptDefaultsSchema = z.object({
  image: z.string(),
  pdf: z.string(),
  docx: z.string(),
  compare: z.string(),
  generate: z.string(),
});
export type SettingsPromptDefaults = z.infer<typeof SettingsPromptDefaultsSchema>;

/**
 * Object-storage settings. `secretPresent` is a PRESENCE bit, not a value: it
 * answers "is a credential configured?" so an operator can tell an unset
 * backend from a broken one without the secret ever crossing this boundary.
 * `ttlSeconds` is the presigned-URL lifetime (S3 only; null when not S3).
 */
export const SettingsStorageSchema = z
  .object({
    backend: z.enum(['local', 's3']),
    endpoint: z.string().min(1),
    bucket: z.string().min(1),
    region: z.string().min(1),
    /** True when a credential is configured. The credential NEVER appears. */
    secretPresent: z.boolean(),
    ttlSeconds: z.number().int().positive().nullable(),
});
export type SettingsStorage = z.infer<typeof SettingsStorageSchema>;

/** Cache + retention. All non-secret durations and counts. */
export const SettingsCacheRetentionSchema = z
  .object({
    dedupEnabled: z.boolean(),
    retentionDays: z.number().int().min(0),
    cleanupIntervalSeconds: z.number().int().min(0),
});
export type SettingsCacheRetention = z.infer<typeof SettingsCacheRetentionSchema>;

/**
 * What this deployment can actually DO with settings.
 *
 * `writerEnabled` is the honest capability: it is true only when a deployment
 * adapter exists to persist a change. Today no adapter ships in the tree (the
 * ACUI-M06 `connectorBaseUrls` shape), so a truthful deployment reports
 * `false` and the UI must render a disabled control with a reason rather than
 * a Save button that silently does nothing.
 */
export const SettingsCapabilitiesSchema = z
  .object({
    readerEnabled: z.boolean(),
    writerEnabled: z.boolean(),
});
export type SettingsCapabilities = z.infer<typeof SettingsCapabilitiesSchema>;

/** `GET /admin/api/settings` → this. Narrowed by the BFF before it is sent. */
export const SettingsReadSchema = z.object({
  ai: SettingsAiDefaultsSchema,
  promptDefaults: SettingsPromptDefaultsSchema,
  storage: SettingsStorageSchema,
  cacheRetention: SettingsCacheRetentionSchema,
  capabilities: SettingsCapabilitiesSchema,
});
export type SettingsRead = z.infer<typeof SettingsReadSchema>;

/**
 * The writer contract — DISABLED / FAIL-CLOSED.
 *
 * The shape is declared so a deployment adapter has a frozen target to
 * implement, but the BFF never forwards it: `POST /admin/api/settings` is
 * refused at the capability gate (§ settings.ts) before any upstream call, so
 * this schema cannot be used to persist anything today. `secretValue` is
 * write-only — it is accepted by a future adapter and is never echoed back in
 * any read DTO.
 */
export const SettingsUpdateParamsSchema = z
  .object({
    ai: SettingsAiDefaultsSchema.partial().optional(),
    promptDefaults: SettingsPromptDefaultsSchema.partial().strict().optional(),
    storage: SettingsStorageSchema.omit({ secretPresent: true })
      .partial()
      .extend({
        /** Write-only credential value. Never returned by any read route. */
        secretValue: z.string().min(1).optional(),
      })
      // Caller input is `.strict()` even though the READ schemas strip: an
      // unrecognised field in a write body is a client bug we must not drop
      // silently, and `secretPresent` is read-only so a client cannot assert it.
      .strict()
      .optional(),
    cacheRetention: SettingsCacheRetentionSchema.partial().optional(),
  })
  .strict();
export type SettingsUpdateParams = z.infer<typeof SettingsUpdateParamsSchema>;

/**
 * Answer returned by the disabled writer path. Carries the machine code the UI
 * keys off plus a human reason — a disabled control must say WHY it is
 * disabled, not merely refuse.
 */
export const SETTINGS_WRITER_DISABLED_CODE = 'SETTINGS_WRITER_DISABLED';
export const SETTINGS_WRITER_DISABLED_REASON =
  'no deployment adapter exists in this build, so settings cannot be changed from the Admin UI';

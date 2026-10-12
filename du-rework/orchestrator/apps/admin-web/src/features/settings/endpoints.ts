/**
 * Settings editor allowlist. Keep this in lockstep with the backend
 * `modules/settings/endpoints.ts`; the focused UI contract test compares the
 * two sets so an endpoint cannot silently disappear from this selector.
 */
export const CORE_ENDPOINT_GROUPS = {
  ingest: ['parse', 'ocr', 'digitize', 'split'],
  extract: ['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'],
  analyze: ['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval'],
  transform: ['convert', 'translate', 'rewrite', 'redact', 'template'],
  generate: ['summary', 'outline', 'report', 'email', 'minutes', 'qa'],
  compare: ['diff', 'semantic', 'version'],
} as const;

export const CORE_ENDPOINT_OPTIONS = Object.entries(CORE_ENDPOINT_GROUPS).flatMap(([action, variants]) =>
  variants.map((variant) => `${action}:${variant}`),
);

const coreEndpointSet: ReadonlySet<string> = new Set(CORE_ENDPOINT_OPTIONS);

export function isCoreEndpointSlug(value: string): boolean {
  return coreEndpointSet.has(value);
}

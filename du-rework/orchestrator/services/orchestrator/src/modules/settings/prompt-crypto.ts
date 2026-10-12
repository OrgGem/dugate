import type { MetadataCrypto } from '../runtime/metadata-crypto';
import { compatibilityMetadataReader, type MetadataReader } from '../encryption/metadata-read-policy';
export type PromptIdentity = { tenantId: string; connectionId: string; apiKeyId: string; endpointSlug: string; stepId: string };
export function promptContext(p: PromptIdentity) {
  return { tenantId:p.tenantId, slot:'connector_prompt_overrides.prompt_override' as const,
    refId:JSON.stringify([p.connectionId,p.apiKeyId,p.endpointSlug,p.stepId]) };
}
export async function sealPrompt(value: string | null, p: PromptIdentity, crypto?: MetadataCrypto): Promise<string | null> {
  return value === null ? null : crypto ? JSON.stringify(await crypto.seal(value,promptContext(p))) : value;
}
export async function openPrompt(value: string | null, p: PromptIdentity, crypto?: MetadataCrypto, reader?: MetadataReader): Promise<string | null> {
  return value === null ? null : (await (reader ?? compatibilityMetadataReader(crypto)).readStoredText(value,promptContext(p))) ?? null;
}

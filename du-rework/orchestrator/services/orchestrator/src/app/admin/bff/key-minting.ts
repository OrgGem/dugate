/**
 * Server-side raw-key minting for the Admin BFF (shared by the generic
 * `/admin/api/actions` passthrough and the profile key routes).
 *
 * `apikey.issue` and `apikey.rotate` carry the RAW value on the platform
 * wire: only the platform hashes it, so somebody has to mint it. admin-web
 * has no key material to contribute and must never generate a credential in
 * the browser, so the BFF mints `du_<32 random bytes>` here - the same shape
 * and the same server-side source as the legacy admin shell (shell-server.ts
 * `adminAction`).
 *
 * Generated ONLY when the caller sent nothing. A present-but-malformed value
 * stays the platform's 422 instead of being silently repaired here: quietly
 * fixing a broken call hides the bug from whoever wrote the caller.
 */
import { randomBytes } from 'node:crypto';

export const KEY_MINTING_ACTIONS: ReadonlySet<string> = new Set(['apikey.issue', 'apikey.rotate']);

/** `du_` + 32 random bytes, base64url — the legacy shell's own shape. */
export function mintRawApiKey(): string {
  return `du_${randomBytes(32).toString('base64url')}`;
}

export function withMintedRawKey(
  action: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (!KEY_MINTING_ACTIONS.has(action) || params.apiKey !== undefined) return params;
  return { ...params, apiKey: mintRawApiKey() };
}

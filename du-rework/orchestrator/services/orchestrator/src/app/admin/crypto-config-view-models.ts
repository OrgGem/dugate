/**
 * ENC-08 (tasks/APP-ENCRYPTION-2026-09-27.md): view models for the Admin crypto
 * configuration pane.
 *
 * The pane is the operator's view of three things per tenant: which ALLOWED Vault
 * storage key ref encrypts that tenant's artifacts at rest, whether delivery to the
 * external app is recipient-encrypted, and WHICH registered recipient public key
 * version is pinned for delivery.
 *
 * Two rules shape everything here:
 *
 *   1. NO SECRET REACHES THIS LAYER. The model carries key REFS, version numbers
 *      and SHA-256 FINGERPRINTS. There is no field that could hold a Vault token, a
 *      DEK, a private key or a plaintext artifact byte, so the renderer cannot leak
 *      one even by accident - a preview that has nothing to leak.
 *   2. THE PIN IS NEVER SILENTLY IGNORED. A pinned version that has since been
 *      revoked is NOT quietly dropped: it is surfaced as `pinInvalid`, because a
 *      config screen that shows a revoked key as active is how a tenant ends up
 *      believing its deliveries are decryptable when ENC-07 would fail them closed.
 *
 * Pure: no DB, no HTTP, no clock beyond what the caller passes in.
 */

/** A registered recipient public key as the pane may show it. */
export interface RecipientKeyOption {
  readonly version: number;
  /** SHA-256 fingerprint of the public key. Public, not a secret. */
  readonly fingerprint: string;
  /** NULL while the key is usable. */
  readonly revokedAt: string | null;
  readonly effectiveAt: string;
}

/** The stored configuration for one tenant. */
export interface CryptoConfigState {
  /** Allowlisted Vault key ref, or null when the tenant has no at-rest key. */
  readonly storageKeyRef: string | null;
  /** Whether deliveries to this tenant are recipient-encrypted (ENC-07). */
  readonly deliveryEncryption: boolean;
  /** Pinned recipient key version, or null = follow the current active key. */
  readonly pinnedRecipientKeyVersion: number | null;
}

export const EMPTY_CRYPTO_CONFIG: CryptoConfigState = {
  storageKeyRef: null,
  deliveryEncryption: false,
  pinnedRecipientKeyVersion: null,
};

/** Why a stored pin can no longer be honoured. Surfaced, never swallowed. */
export type PinInvalidReason = 'version_missing' | 'version_revoked';

export interface CryptoConfigViewModel {
  readonly tenantId: string;
  readonly state: CryptoConfigState;
  /** Every ref the platform allows, sorted. Never the Transit key name. */
  readonly allowedKeyRefs: readonly string[];
  /** Registered recipient keys, newest version first. */
  readonly recipientKeys: readonly RecipientKeyOption[];
  /** Version the pane should mark as selected. */
  readonly effectiveRecipientKeyVersion: number | null;
  /** Present when the stored pin cannot be honoured. */
  readonly pinInvalid: { readonly reason: PinInvalidReason; readonly version: number } | null;
  /** True when the tenant can actually receive encrypted deliveries. */
  readonly deliveryReady: boolean;
  /** Why delivery is not ready, for the pane's status line. */
  readonly deliveryBlockedReason: 'no_recipient_key' | 'pin_invalid' | null;
}

export interface CryptoConfigViewInput {
  readonly tenantId: string;
  readonly state: CryptoConfigState;
  /** Refs the platform allowlisted for Vault Transit. */
  readonly allowedKeyRefs: readonly string[];
  readonly recipientKeys: readonly RecipientKeyOption[];
}

/**
 * Which version delivery will actually use right now: the pin when it is
 * honourable, otherwise the highest non-revoked version (what ENC-07's
 * `getCurrentKey` resolves to), otherwise null.
 */
export function effectiveRecipientKeyVersion(input: CryptoConfigViewInput): number | null {
  // Sorted here, not only in the view builder: the answer is "the HIGHEST
  // non-revoked version", and a caller that passes keys in registry order
  // would otherwise get whichever row happened to arrive first.
  const usable = input.recipientKeys
    .filter((key) => key.revokedAt === null)
    .sort((left, right) => right.version - left.version);
  if (usable.length === 0) return null;
  const pinned = input.state.pinnedRecipientKeyVersion;
  if (pinned === null) return usable[0]!.version;
  const match = usable.find((key) => key.version === pinned);
  return match ? match.version : null;
}

/**
 * Why a stored pin is unusable, or null when it is fine. A pin naming a version
 * that was never registered is `version_missing`; one that exists but was revoked
 * is `version_revoked` - different causes, different operator actions.
 */
export function pinInvalidReason(
  state: CryptoConfigState,
  recipientKeys: readonly RecipientKeyOption[],
): { reason: PinInvalidReason; version: number } | null {
  const pinned = state.pinnedRecipientKeyVersion;
  if (pinned === null) return null;
  const match = recipientKeys.find((key) => key.version === pinned);
  if (!match) return { reason: 'version_missing', version: pinned };
  if (match.revokedAt !== null) return { reason: 'version_revoked', version: pinned };
  return null;
}

/**
 * Short fingerprint preview for the pane: the first 12 base64url characters of the
 * `SHA256:` form plus an ellipsis. Enough for an operator to recognise a key in a
 * list, not enough to be mistaken for the key itself.
 */
export function fingerprintPreview(fingerprint: string): string {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return '(unknown)';
  const body = fingerprint.startsWith('SHA256:') ? fingerprint.slice(7) : fingerprint;
  if (body.length <= 12) return body + '...';
  return body.slice(0, 12) + '...';
}

export function buildCryptoConfigView(input: CryptoConfigViewInput): CryptoConfigViewModel {
  if (!input || typeof input.tenantId !== 'string' || input.tenantId.length === 0) {
    throw new Error('tenantId is required');
  }
  const recipientKeys = [...input.recipientKeys].sort((left, right) => right.version - left.version);
  const invalid = pinInvalidReason(input.state, recipientKeys);
  const effective = effectiveRecipientKeyVersion(input);
  const hasUsableKey = recipientKeys.some((key) => key.revokedAt === null);
  return {
    tenantId: input.tenantId,
    state: input.state,
    allowedKeyRefs: [...new Set(input.allowedKeyRefs)].sort(),
    recipientKeys,
    effectiveRecipientKeyVersion: effective,
    pinInvalid: invalid,
    deliveryReady: input.state.deliveryEncryption && hasUsableKey && invalid === null,
    deliveryBlockedReason:
      input.state.deliveryEncryption && !hasUsableKey
        ? 'no_recipient_key'
        : input.state.deliveryEncryption && invalid !== null
          ? 'pin_invalid'
          : null,
  };
}

// ---------------------------------------------------------------------------
// Pane states (mirrors the other sections' discriminated fetch results)
// ---------------------------------------------------------------------------

export type CryptoConfigPane =
  | { status: 'ready'; view: CryptoConfigViewModel }
  | { status: 'unauthorized' }
  | { status: 'not-found' }
  | { status: 'error'; code: string }

export function cryptoConfigEmptyPane(tenantId: string): CryptoConfigPane {
  return {
    status: 'ready',
    view: buildCryptoConfigView({
      tenantId,
      state: EMPTY_CRYPTO_CONFIG,
      allowedKeyRefs: [],
      recipientKeys: [],
    }),
  };
}

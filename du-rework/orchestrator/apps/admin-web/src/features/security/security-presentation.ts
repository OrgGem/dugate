export interface CryptoRecipientKeyView {
  version: number;
  fingerprint: string;
  revokedAt: string | null;
  effectiveAt: string;
}

export interface CryptoConfigPresentationView {
  tenantId: string;
  state: {
    storageKeyRef: string | null;
    deliveryEncryption: boolean;
    pinnedRecipientKeyVersion: number | null;
  };
  allowedKeyRefs: string[];
  recipientKeys: CryptoRecipientKeyView[];
  effectiveRecipientKeyVersion: number | null;
  pinInvalid: { reason: 'version_missing' | 'version_revoked'; version: number } | null;
  deliveryReady: boolean;
  deliveryBlockedReason: 'no_recipient_key' | 'pin_invalid' | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveIntegerOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseCryptoConfigPresentationView(response: Record<string, unknown>): CryptoConfigPresentationView | null {
  const view = record(response['crypto']) ?? response;
  const state = record(view['state']);
  const tenantId = view['tenantId'];
  const storageKeyRef = state?.['storageKeyRef'];
  const deliveryEncryption = state?.['deliveryEncryption'];
  const pinnedRecipientKeyVersion = positiveIntegerOrNull(state?.['pinnedRecipientKeyVersion']);
  const effectiveRecipientKeyVersion = positiveIntegerOrNull(view['effectiveRecipientKeyVersion']);
  const rawPinInvalid = view['pinInvalid'];
  const rawBlockedReason = view['deliveryBlockedReason'];
  const rawAllowedKeyRefs = view['allowedKeyRefs'];
  const rawRecipientKeys = view['recipientKeys'];

  if (
    typeof tenantId !== 'string'
    || !state
    || (storageKeyRef !== null && typeof storageKeyRef !== 'string')
    || typeof deliveryEncryption !== 'boolean'
    || pinnedRecipientKeyVersion === undefined
    || effectiveRecipientKeyVersion === undefined
    || typeof view['deliveryReady'] !== 'boolean'
    || !Array.isArray(rawAllowedKeyRefs)
    || !rawAllowedKeyRefs.every((value) => typeof value === 'string')
    || !Array.isArray(rawRecipientKeys)
    || (rawBlockedReason !== null && rawBlockedReason !== 'no_recipient_key' && rawBlockedReason !== 'pin_invalid')
  ) return null;

  let pinInvalid: CryptoConfigPresentationView['pinInvalid'];
  if (rawPinInvalid === null) {
    pinInvalid = null;
  } else {
    const parsedPinInvalid = record(rawPinInvalid);
    const version = positiveIntegerOrNull(parsedPinInvalid?.['version']);
    const reason = parsedPinInvalid?.['reason'];
    if (
      !parsedPinInvalid
      || version === undefined
      || version === null
      || (reason !== 'version_missing' && reason !== 'version_revoked')
    ) return null;
    pinInvalid = { reason, version };
  }

  const recipientKeys: CryptoRecipientKeyView[] = [];
  for (const rawKey of rawRecipientKeys) {
    const key = record(rawKey);
    const version = positiveIntegerOrNull(key?.['version']);
    const fingerprint = key?.['fingerprint'];
    const revokedAt = key?.['revokedAt'];
    const effectiveAt = key?.['effectiveAt'];
    if (
      !key
      || version === undefined
      || version === null
      || typeof fingerprint !== 'string'
      || (revokedAt !== null && typeof revokedAt !== 'string')
      || typeof effectiveAt !== 'string'
    ) return null;
    recipientKeys.push({ version, fingerprint, revokedAt, effectiveAt });
  }

  return {
    tenantId,
    state: {
      storageKeyRef: storageKeyRef as string | null,
      deliveryEncryption,
      pinnedRecipientKeyVersion,
    },
    allowedKeyRefs: rawAllowedKeyRefs as string[],
    recipientKeys,
    effectiveRecipientKeyVersion,
    pinInvalid,
    deliveryReady: view['deliveryReady'],
    deliveryBlockedReason: rawBlockedReason,
  };
}

/** Mirrors the Admin server's public-key fingerprint preview length. */
export function cryptoFingerprintPreview(fingerprint: string): string {
  if (fingerprint.length === 0) return '(unknown)';
  const body = fingerprint.startsWith('SHA256:') ? fingerprint.slice(7) : fingerprint;
  return body.slice(0, 12) + '...';
}

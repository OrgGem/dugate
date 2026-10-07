/**
 * ENC-08: pure HTML renderer for the crypto configuration pane.
 *
 * Renders exactly what the view model holds: an allowlisted Vault key-ref picker, a
 * delivery-encryption toggle, a recipient key-version picker that shows a fingerprint
 * PREVIEW and status, and the save control.
 *
 * Three properties the renderer is built to keep:
 *
 *   - Every value goes through esc(). Key refs and tenant ids are operator-supplied
 *     strings, so they are untrusted by construction.
 *   - No secret material is even available to render: the view model carries refs,
 *     versions and fingerprints only.
 *   - A broken pin is rendered as a WARNING, never hidden: a pane that looks healthy
 *     while delivery is failing closed is how this setting gets ignored.
 */

import { esc } from './shell-render';
import { fingerprintPreview, type CryptoConfigPane } from './crypto-config-view-models';

/**
 * The refs the operator MAY pick. The handler re-validates the submitted value against
 * the platform allowlist, so this list is presentation only - a hand-typed POST of a
 * ref that is not here is rejected server-side, not merely absent from the form.
 */
const STORAGE_KEY_REF_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '(none - no app-managed storage key)' },
  { value: 'primary', label: 'primary (platform default)' },
  { value: 'secondary', label: 'secondary' },
  { value: 'break-glass', label: 'break-glass' },
];

function escOrEmpty(value: string | null | undefined): string {
  return esc(typeof value === 'string' ? value : '');
}

/** One option per registered recipient key version, newest first. */
function recipientKeyOptions(pane: Extract<CryptoConfigPane, { status: 'ready' }>): string {
  const view = pane.view;
  const options: string[] = [];
  const follow = view.state.pinnedRecipientKeyVersion === null ? ' selected' : '';
  options.push('<option value=""' + follow + '>(follow the current active key)</option>');
  for (const key of view.recipientKeys) {
    const selected = view.state.pinnedRecipientKeyVersion === key.version ? ' selected' : '';
    const disabled = key.revokedAt === null ? '' : ' disabled';
    const status = key.revokedAt === null ? 'active' : 'revoked';
    const preview = esc(fingerprintPreview(key.fingerprint));
    options.push('<option value="' + esc(String(key.version)) + '"' + selected + disabled +
      ' data-fingerprint-preview="' + preview + '"' + ' data-key-status="' + status + '">' +
      'v' + esc(String(key.version)) + ' - ' + preview + ' (' + status + ')</option>');
  }
  return options.join('');
}

function storageKeyRefOptions(pane: Extract<CryptoConfigPane, { status: 'ready' }>): string {
  const view = pane.view;
  const parts: string[] = [];
  for (const option of STORAGE_KEY_REF_OPTIONS) {
    const selected = view.state.storageKeyRef === option.value ? ' selected' : '';
    const unknown = view.allowedKeyRefs.includes(option.value) ? '' : ' data-key-ref-unknown="true"';
    parts.push('<option value="' + esc(option.value) + '"' + selected + unknown + '>' +
      esc(option.label) + '</option>');
  }
  return parts.join('');
}

/**
 * The ready pane: the editable form.
 *
 * `csrfToken` is the server-derived proof the POST gate will re-derive. W-ENC-08-
 * RENDERER-CSRF (Delta 112): without it the form is a trap - every browser save
 * would be refused with 403 - so when it is absent the pane renders READ-ONLY
 * (fields still readable, no Save button) and says why, instead of shipping a
 * button that can never work.
 */
export function renderCryptoConfigForm(
  pane: Extract<CryptoConfigPane, { status: 'ready' }>,
  csrfToken = '',
): string {
  const view = pane.view;
  const editable = csrfToken.length > 0;
  const parts: string[] = [];
  parts.push('<section class="crypto-config-section" data-crypto-config="true">');
  parts.push('  <header class="crypto-config-section__header">');
  parts.push('    <h2 class="crypto-config-section__title">Crypto configuration</h2>');
  parts.push('  </header>');
  parts.push('  <form class="crypto-config-form" method="post" action="/admin/crypto-config" data-crypto-config-form="true"' + (editable ? '' : ' data-crypto-config-readonly="true"') + '>');
  parts.push('    <input type="hidden" name="tenantId" value="' + esc(view.tenantId) + '">');
  if (editable) {
    // The proof the POST handler re-derives from the session cookie. It is a
    // binding, not a credential: without the cookie secret the server could not
    // produce it, and it is worthless to a cross-site page that cannot read it.
    parts.push('    <input type="hidden" name="csrf" value="' + esc(csrfToken) + '">');
  }

  parts.push('    <label class="crypto-config-form__label" for="crypto-config-storage-key-ref">Vault storage key</label>');
  parts.push('    <select id="crypto-config-storage-key-ref" name="storageKeyRef" data-storage-key-ref-select>' +
    storageKeyRefOptions(pane) + '</select>');

  const checked = view.state.deliveryEncryption ? ' checked' : '';
  parts.push('    <label class="crypto-config-form__label" for="crypto-config-delivery-encryption">Recipient-encrypted delivery</label>');
  parts.push('    <input type="checkbox" id="crypto-config-delivery-encryption" name="deliveryEncryption" value="on"' +
    checked + ' data-delivery-encryption-toggle>');

  parts.push('    <label class="crypto-config-form__label" for="crypto-config-recipient-key">Recipient key version</label>');
  parts.push('    <select id="crypto-config-recipient-key" name="recipientKeyVersion" data-recipient-key-select>' +
    recipientKeyOptions(pane) + '</select>');

  if (view.pinInvalid) {
    const why = view.pinInvalid.reason === 'version_revoked' ? ' is revoked' : ' is no longer registered';
    parts.push('    <p class="crypto-config-form__warning" role="alert" data-crypto-config-pin-invalid="' +
    esc(view.pinInvalid.reason) + '">Pinned recipient key v' + esc(String(view.pinInvalid.version)) + why +
    '. Encrypted delivery is blocked until a valid version is pinned.</p>');
  }
  if (view.state.deliveryEncryption && !view.deliveryReady) {
    const reason = view.deliveryBlockedReason === 'no_recipient_key'
      ? 'no recipient public key is registered for this tenant'
      : 'the pinned recipient key cannot be used';
    parts.push('    <p class="crypto-config-form__warning" role="status" data-delivery-blocked="' +
    esc(view.deliveryBlockedReason ?? 'unknown') + '">Encrypted delivery is enabled but blocked: ' +
    esc(reason) + '. Requests fail closed with 503.</p>');
  }

  if (editable) {
    parts.push('    <button type="submit" class="crypto-config-form__save" data-crypto-config-save="true">Save</button>');
  } else {
    parts.push('    <p class="crypto-config-form__notice" role="status" data-crypto-config-readonly-notice="true">');
    parts.push('      Read-only: this session cannot prove a CSRF token, so saving is unavailable.');
    parts.push('    </p>');
  }
  parts.push('  </form>');
  parts.push('</section>');
  return parts.join('\n');
}

/**
 * Dispatch a pane to HTML. Mirrors the other sections' status panes.
 * `csrfToken` is forwarded to the form only; the status panes carry no form
 * and therefore have nothing to prove.
 */
export function renderCryptoConfig(pane: CryptoConfigPane, csrfToken = ''): string {
  if (pane.status === 'ready') return renderCryptoConfigForm(pane, csrfToken);
  if (pane.status === 'unauthorized') {
    return '<section class="crypto-config-section crypto-config-section--unauthorized" role="alert">' +
      '<p>Admin credentials are required to view crypto configuration.</p></section>';
  }
  if (pane.status === 'not-found') {
    return '<section class="crypto-config-section crypto-config-section--not-found" role="status">' +
      '<p>No crypto configuration exists for this tenant.</p></section>';
  }
  return '<section class="crypto-config-section crypto-config-section--error" role="alert">' +
    '<p data-crypto-config-error="' + esc(pane.code) + '">Crypto configuration could not be loaded.</p></section>';
}

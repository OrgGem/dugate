import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cryptoFingerprintPreview,
  parseCryptoConfigPresentationView,
} from '../src/features/security/security-presentation.ts';

const response = {
  schemaVersion: '1',
  tenantId: 'tenant-a',
  crypto: {
    tenantId: 'tenant-a',
    state: {
      storageKeyRef: 'primary',
      deliveryEncryption: true,
      pinnedRecipientKeyVersion: 2,
    },
    allowedKeyRefs: ['primary', 'secondary'],
    recipientKeys: [
      { version: 3, fingerprint: 'SHA256:abcdefghijklmnop', revokedAt: null, effectiveAt: '2026-10-01T00:00:00.000Z' },
      { version: 2, fingerprint: 'SHA256:zyxwvutsrqponmlk', revokedAt: '2026-10-02T00:00:00.000Z', effectiveAt: '2026-09-01T00:00:00.000Z' },
    ],
    effectiveRecipientKeyVersion: null,
    pinInvalid: { reason: 'version_revoked', version: 2 },
    deliveryReady: false,
    deliveryBlockedReason: 'pin_invalid',
  },
};

describe('security crypto-config presentation', () => {
  it('maps saved policy separately from registry-derived key readiness', () => {
    const view = parseCryptoConfigPresentationView(response);
    assert.ok(view);
    assert.equal(view.tenantId, 'tenant-a');
    assert.equal(view.state.storageKeyRef, 'primary');
    assert.equal(view.state.deliveryEncryption, true);
    assert.equal(view.state.pinnedRecipientKeyVersion, 2);
    assert.equal(view.effectiveRecipientKeyVersion, null);
    assert.deepEqual(view.pinInvalid, { reason: 'version_revoked', version: 2 });
    assert.equal(view.deliveryReady, false);
    assert.equal(view.deliveryBlockedReason, 'pin_invalid');
    assert.equal(view.recipientKeys[0]?.revokedAt, null);
    assert.equal(view.recipientKeys[1]?.revokedAt, '2026-10-02T00:00:00.000Z');
  });

  it('keeps unknown or malformed API shapes out of the editable presentation', () => {
    assert.equal(parseCryptoConfigPresentationView({ crypto: { tenantId: 'tenant-a', state: {} } }), null);
    assert.equal(parseCryptoConfigPresentationView({ ...response, crypto: { ...response.crypto, deliveryReady: 'yes' } }), null);
  });

  it('shows only the same 12-character public fingerprint preview as the Admin pane', () => {
    const preview = cryptoFingerprintPreview('SHA256:abcdefghijklmnop');
    assert.equal(preview, 'abcdefghijkl...');
    assert.equal(preview.includes('mnop'), false);
  });
});

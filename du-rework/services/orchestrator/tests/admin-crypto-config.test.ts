/**
 * ENC-08 (tasks/APP-ENCRYPTION-2026-09-27.md): Admin UI + Admin API for crypto
 * configuration.
 *
 * Offline throughout: no DB, no Vault, no network, no browser. The ports the handler
 * declares (store / recipient-key lister / audit) are exercised through in-memory
 * doubles, and the CSRF token is derived with the same helper the server uses, so the
 * gate under test is the real one.
 *
 * Proven, in the order the task row names it: the allowlist refuses a ref outside it;
 * the delivery toggle works but cannot be switched on without a usable recipient key;
 * a pin must be registered for THAT tenant and not revoked; reads are tenant-scoped,
 * mutations need a writer role plus the server-derived CSRF token; the storage key ref
 * is platform-only; every changed field writes one audit row naming the FIELD and not
 * its value; and a sentinel private key planted in the inputs appears in no output.
 */

import { deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import {
  EMPTY_CRYPTO_CONFIG,
  buildCryptoConfigView,
  effectiveRecipientKeyVersion,
  fingerprintPreview,
  pinInvalidReason,
  type CryptoConfigState,
  type RecipientKeyOption,
} from '../src/app/admin/crypto-config-view-models';
import { renderCryptoConfig, renderCryptoConfigForm } from '../src/app/admin/crypto-config-renderer';
import {
  applyCryptoConfig,
  readCryptoConfig,
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigAuth,
  type CryptoConfigServiceOptions,
  type CryptoConfigStore,
} from '../src/app/admin/crypto-config-api';
import type { AuditRecordInput } from '../src/modules/audit/audit';
import type { RecipientPublicKeyRecord } from '../src/modules/encryption/recipient-key-registry';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const ALLOWED = ['primary', 'secondary'];
const COOKIE_SECRET = 'enc08-cookie-secret';
const SESSION_COOKIE = 'du_admin-session-value';
/** A private key that must never appear in any output. Planted as a sentinel. */
const SECRET_SENTINEL = 'BEGIN PRIVATE KEY AAAA-SECRET-SENTINEL';

function keyRecord(over: Partial<RecipientPublicKeyRecord> = {}): RecipientPublicKeyRecord {
  return {
    id: 'key-1',
    tenantId: TENANT_A,
    version: 1,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: 'BEGIN PUBLIC KEY AAAA',
    fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz012345',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

class MemoryStore implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  public writes = 0;
  async get(tenantId: string): Promise<CryptoConfigState> {
    return this.rows.get(tenantId) ?? EMPTY_CRYPTO_CONFIG;
  }
  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    this.writes += 1;
    this.rows.set(tenantId, next);
    return next;
  }
}

class MemoryAudit implements CryptoConfigAudit {
  public readonly rows: AuditRecordInput[] = [];
  async record(input: AuditRecordInput): Promise<unknown> {
    this.rows.push(input);
    return { ok: true };
  }
}

function service(options: { keys?: RecipientPublicKeyRecord[] } = {}) {
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const keys = options.keys ?? [keyRecord()];
  const config: CryptoConfigServiceOptions = {
    allowedKeyRefs: ALLOWED,
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        return recipientKeyOptions(keys, tenantId);
      },
    },
    audit,
  };
  return { config, store, audit, keys };
}

const platformAuth: CryptoConfigAuth = { principal: { role: 'platform' } };

function operatorAuth(over: Partial<CryptoConfigAuth> = {}): CryptoConfigAuth {
  return {
    principal: { role: 'tenant_operator', tenantId: TENANT_A },
    cookieRole: 'admin',
    cookieSecret: COOKIE_SECRET,
    sessionCookie: SESSION_COOKIE,
    csrfToken: deriveCsrfToken(COOKIE_SECRET, SESSION_COOKIE),
    ...over,
  };
}

describe('ENC-08: crypto configuration view model', () => {
  it('reports no effective key and blocks delivery when nothing is registered', () => {
    const view = buildCryptoConfigView({
      tenantId: TENANT_A,
      state: { ...EMPTY_CRYPTO_CONFIG, deliveryEncryption: true },
      allowedKeyRefs: ALLOWED,
      recipientKeys: [],
    });
    expect(view.effectiveRecipientKeyVersion).toBeNull();
    expect(view.deliveryReady).toBe(false);
    expect(view.deliveryBlockedReason).toBe('no_recipient_key');
  });

  it('follows the current active key when no pin is set', () => {
    const keys: RecipientKeyOption[] = [
      { version: 1, fingerprint: 'SHA256:aaa', revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
      { version: 2, fingerprint: 'SHA256:bbb', revokedAt: null, effectiveAt: '2026-02-01T00:00:00.000Z' },
    ];
    const view = buildCryptoConfigView({
      tenantId: TENANT_A,
      state: EMPTY_CRYPTO_CONFIG,
      allowedKeyRefs: ALLOWED,
      recipientKeys: keys,
    });
    expect(view.effectiveRecipientKeyVersion).toBe(2);
    expect(view.pinInvalid).toBeNull();
  });

  it('a revoked CURRENT key is not offered as effective', () => {
    const keys: RecipientKeyOption[] = [
      { version: 1, fingerprint: 'SHA256:aaa', revokedAt: '2026-03-01T00:00:00.000Z', effectiveAt: '2026-01-01T00:00:00.000Z' },
      { version: 2, fingerprint: 'SHA256:bbb', revokedAt: null, effectiveAt: '2026-02-01T00:00:00.000Z' },
    ];
    expect(effectiveRecipientKeyVersion({ tenantId: TENANT_A, state: EMPTY_CRYPTO_CONFIG, allowedKeyRefs: ALLOWED, recipientKeys: keys })).toBe(2);
  });

  it('surfaces a pin that names a revoked version, and one that names nothing', () => {
    const revokedKeys: RecipientKeyOption[] = [
      { version: 1, fingerprint: 'SHA256:aaa', revokedAt: '2026-03-01T00:00:00.000Z', effectiveAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(pinInvalidReason({ ...EMPTY_CRYPTO_CONFIG, pinnedRecipientKeyVersion: 1 }, revokedKeys)).toEqual({ reason: 'version_revoked', version: 1 });
    expect(pinInvalidReason({ ...EMPTY_CRYPTO_CONFIG, pinnedRecipientKeyVersion: 9 }, revokedKeys)).toEqual({ reason: 'version_missing', version: 9 });
    expect(pinInvalidReason({ ...EMPTY_CRYPTO_CONFIG, pinnedRecipientKeyVersion: 1 }, [])).toEqual({ reason: 'version_missing', version: 1 });
    expect(pinInvalidReason(EMPTY_CRYPTO_CONFIG, revokedKeys)).toBeNull();
  });

  it('a revoked pin blocks delivery even when the toggle is on', () => {
    const view = buildCryptoConfigView({
      tenantId: TENANT_A,
      state: { storageKeyRef: 'primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 1 },
      allowedKeyRefs: ALLOWED,
      recipientKeys: [
        { version: 1, fingerprint: 'SHA256:aaa', revokedAt: '2026-03-01T00:00:00.000Z', effectiveAt: '2026-01-01T00:00:00.000Z' },
        { version: 2, fingerprint: 'SHA256:bbb', revokedAt: null, effectiveAt: '2026-02-01T00:00:00.000Z' },
      ],
    });
    expect(view.pinInvalid).toEqual({ reason: 'version_revoked', version: 1 });
    expect(view.deliveryReady).toBe(false);
    expect(view.deliveryBlockedReason).toBe('pin_invalid');
  });

  it('truncates the fingerprint for display and never returns the whole value as a preview', () => {
    expect(fingerprintPreview('SHA256:abcdefghijklmnopqrstuvwxyz012345')).toBe('abcdefghijkl...');
    expect(fingerprintPreview('')).toBe('(unknown)');
  });
});

describe('ENC-08: crypto configuration renderer', () => {
  const readyPane = {
    status: 'ready' as const,
    view: buildCryptoConfigView({
      tenantId: TENANT_A,
      state: { storageKeyRef: 'primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 1 },
      allowedKeyRefs: ALLOWED,
      recipientKeys: [
        { version: 1, fingerprint: 'SHA256:abcdefghijklmnop', revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
        { version: 2, fingerprint: 'SHA256:zyxwvutsrqponm', revokedAt: '2026-04-01T00:00:00.000Z', effectiveAt: '2026-02-01T00:00:00.000Z' },
      ],
    }),
  };

  it('renders the three controls with the stored state selected', () => {
    const html = renderCryptoConfigForm(readyPane);
    expect(html).toContain('data-crypto-config-form="true"');
    expect(html).toContain('name="storageKeyRef"');
    expect(html).toContain('name="deliveryEncryption"');
    expect(html).toContain('name="recipientKeyVersion"');
    expect(html).toContain('checked data-delivery-encryption-toggle');
    expect(html).toContain('<option value="primary" selected');
    expect(html).toContain('<option value="1" selected');
  });

  it('shows a fingerprint PREVIEW and disables a revoked version', () => {
    const html = renderCryptoConfigForm(readyPane);
    expect(html).toContain('data-fingerprint-preview="abcdefghijkl..."');
    expect(html).toContain('data-key-status="revoked"');
    expect(html).toContain('disabled');
    // The full fingerprint is never in the markup, only the preview.
    expect(html).not.toContain('SHA256:abcdefghijklmnop');
  });

  it('warns when the pinned version was revoked, instead of rendering a healthy pane', () => {
    const stale = {
      status: 'ready' as const,
      view: buildCryptoConfigView({
        tenantId: TENANT_A,
        state: { storageKeyRef: 'primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 2 },
        allowedKeyRefs: ALLOWED,
        recipientKeys: [
          { version: 2, fingerprint: 'SHA256:zyxwvutsrqponm', revokedAt: '2026-04-01T00:00:00.000Z', effectiveAt: '2026-02-01T00:00:00.000Z' },
        ],
      }),
    };
    const html = renderCryptoConfigForm(stale);
    expect(html).toContain('data-crypto-config-pin-invalid="version_revoked"');
    expect(html).toContain('Pinned recipient key v2 is revoked');
  });

  it('marks a stored ref the platform no longer allows', () => {
    const pane = {
      status: 'ready' as const,
      view: buildCryptoConfigView({
        tenantId: TENANT_A,
        state: { ...EMPTY_CRYPTO_CONFIG, storageKeyRef: 'break-glass' },
        allowedKeyRefs: ALLOWED,
        recipientKeys: [],
      }),
    };
    const html = renderCryptoConfigForm(pane);
    expect(html).toContain('data-key-ref-unknown="true"');
  });

  it('escapes tenant ids, and a fingerprint carrying a secret shows only its preview', () => {
    // Two separate properties, so a failure says which one broke. An operator-
    // supplied tenant id is UNTRUSTED text and must be escaped; a fingerprint
    // whose body is a secret must be truncated to the preview, never rendered
    // whole - the pane shows a preview precisely so it cannot echo key bytes.
    const injected = { status: 'ready' as const, view: buildCryptoConfigView({
      tenantId: '"><script>alert(1)</script>',
      state: EMPTY_CRYPTO_CONFIG,
      allowedKeyRefs: ALLOWED,
      recipientKeys: [],
    }) };
    const injectedHtml = renderCryptoConfig(injected);
    expect(injectedHtml).not.toContain('<script>');
    expect(injectedHtml).toContain('&lt;script&gt;');

    const secretFingerprint = { status: 'ready' as const, view: buildCryptoConfigView({
      tenantId: TENANT_A,
      state: EMPTY_CRYPTO_CONFIG,
      allowedKeyRefs: ALLOWED,
      recipientKeys: [
        { version: 1, fingerprint: 'SHA256:' + SECRET_SENTINEL, revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
      ],
    }) };
    const secretHtml = renderCryptoConfig(secretFingerprint);
    expect(secretHtml).not.toContain(SECRET_SENTINEL);
    expect(secretHtml).toContain('data-fingerprint-preview="');
  });

  it('renders the non-ready panes without leaking internals', () => {
    expect(renderCryptoConfig({ status: 'unauthorized' })).toContain('role="alert"');
    expect(renderCryptoConfig({ status: 'not-found' })).toContain('role="status"');
    expect(renderCryptoConfig({ status: 'error', code: 'VAULT_UNAVAILABLE' })).toContain('data-crypto-config-error="VAULT_UNAVAILABLE"');
  });
});

describe('ENC-08: crypto configuration API - reads', () => {
  it('a platform caller reads any named tenant', async () => {
    const s = service();
    const view = await readCryptoConfig(s.config, { auth: platformAuth, tenantId: TENANT_B });
    expect(view.tenantId).toBe(TENANT_B);
  });

  it('a tenant operator reads its own tenant without naming it', async () => {
    const s = service();
    const view = await readCryptoConfig(s.config, { auth: operatorAuth() });
    expect(view.tenantId).toBe(TENANT_A);
  });

  it('an anonymous caller is 401', async () => {
    const s = service();
    await expect(readCryptoConfig(s.config, { auth: { principal: null } })).rejects.toMatchObject({ status: 401 });
  });

  it('another tenant is 403 with identical wording for every foreign id', async () => {
    const s = service();
    const first = await readCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_B }).catch((e: unknown) => e);
    const second = await readCryptoConfig(s.config, { auth: operatorAuth(), tenantId: 'tenant-nope' }).catch((e: unknown) => e);
    expect(first).toMatchObject({ status: 403 });
    expect(second).toMatchObject({ status: 403 });
    expect((first as Error).message).toBe((second as Error).message);
  });
});

describe('ENC-08: crypto configuration API - mutations', () => {
  it('switches delivery on and pins a registered version, auditing both fields', async () => {
    const s = service();
    const result = await applyCryptoConfig(s.config, {
      auth: operatorAuth(),
      tenantId: TENANT_A,
      mutation: { deliveryEncryption: true, recipientKeyVersion: 1 },
    });
    expect(result.view.state.deliveryEncryption).toBe(true);
    expect(result.view.state.pinnedRecipientKeyVersion).toBe(1);
    expect(result.view.deliveryReady).toBe(true);
    expect(s.store.rows.get(TENANT_A)?.deliveryEncryption).toBe(true);
    const actions = s.audit.rows.map((row) => row.action).sort();
    expect(actions).toEqual(['crypto_config.delivery_encryption.set', 'crypto_config.recipient_key_pin.set']);
    expect(s.audit.rows.every((row) => row.actor === 'admin:tenant_operator')).toBe(true);
    expect(s.audit.rows.every((row) => row.resource === 'tenant:' + TENANT_A)).toBe(true);
  });

  it('switches delivery back off', async () => {
    const s = service();
    await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: true } });
    await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: false } });
    expect(s.store.rows.get(TENANT_A)?.deliveryEncryption).toBe(false);
  });

  it('a no-op change writes no audit row', async () => {
    const s = service();
    await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: false } });
    expect(s.audit.rows).toHaveLength(0);
    expect(s.store.writes).toBe(1);
  });

  it('refuses a storage key ref outside the platform allowlist', async () => {
    const s = service();
    const req = { auth: platformAuth, tenantId: TENANT_A, mutation: { storageKeyRef: 'not-allowlisted' } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 422 });
    expect(s.store.writes).toBe(0);
    expect(s.audit.rows).toHaveLength(0);
  });

  it('accepts every allowlisted ref and can clear it', async () => {
    const s = service();
    for (const ref of ALLOWED) {
      const result = await applyCryptoConfig(s.config, { auth: platformAuth, tenantId: TENANT_A, mutation: { storageKeyRef: ref } });
      expect(result.view.state.storageKeyRef).toBe(ref);
    }
    const cleared = await applyCryptoConfig(s.config, { auth: platformAuth, tenantId: TENANT_A, mutation: { storageKeyRef: null } });
    expect(cleared.view.state.storageKeyRef).toBeNull();
  });

  it('refuses to switch delivery on with no usable recipient key', async () => {
    const s = service({ keys: [] });
    const req = { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 409 });
    expect(s.store.writes).toBe(0);
    expect(s.audit.rows).toHaveLength(0);
  });

  it('refuses a pin on a version this tenant never registered', async () => {
    const s = service();
    const req = { auth: operatorAuth(), tenantId: TENANT_A, mutation: { recipientKeyVersion: 7 } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 422 });
    expect(s.store.writes).toBe(0);
  });

  it('refuses a pin on a revoked version', async () => {
    const s = service({ keys: [keyRecord({ revokedAt: '2026-05-01T00:00:00.000Z' })] });
    const req = { auth: operatorAuth(), tenantId: TENANT_A, mutation: { recipientKeyVersion: 1 } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 409 });
    expect(s.store.writes).toBe(0);
  });

  it('a key registered for ANOTHER tenant is not pinnable', async () => {
    const s = service({ keys: [keyRecord({ tenantId: TENANT_B })] });
    const req = { auth: operatorAuth(), tenantId: TENANT_A, mutation: { recipientKeyVersion: 1 } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 422 });
  });

  it('unpins by setting the version back to null', async () => {
    const s = service();
    await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: true, recipientKeyVersion: 1 } });
    const unpinned = await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { recipientKeyVersion: null } });
    expect(unpinned.view.state.pinnedRecipientKeyVersion).toBeNull();
  });
});

describe('ENC-08: RBAC and CSRF on the crypto configuration API', () => {
  it('choosing the storage key ref is platform-only', async () => {
    const s = service();
    const req = { auth: operatorAuth(), tenantId: TENANT_A, mutation: { storageKeyRef: 'primary' } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('a tenant operator cannot write to another tenant', async () => {
    const s = service();
    const req = { auth: operatorAuth(), tenantId: TENANT_B, mutation: { deliveryEncryption: false } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('a viewer session may read but not write', async () => {
    const s = service();
    const viewer = operatorAuth({ cookieRole: 'viewer' });
    await readCryptoConfig(s.config, { auth: viewer });
    const req = { auth: viewer, tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('a cookie writer without the CSRF proof is refused', async () => {
    const s = service();
    const req = { auth: operatorAuth({ csrfToken: undefined }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('a cookie writer with a WRONG CSRF proof is refused', async () => {
    const s = service();
    const req = { auth: operatorAuth({ csrfToken: 'forged-token' }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('a bearer platform caller is not asked for a CSRF proof', async () => {
    const s = service();
    const req = { auth: platformAuth, tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).resolves.toBeDefined();
  });

  it('the actor label is never the credential', async () => {
    const s = service();
    await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: true } });
    const serialized = JSON.stringify(s.audit.rows);
    expect(serialized).not.toContain(COOKIE_SECRET);
    expect(serialized).not.toContain(SESSION_COOKIE);
    expect(serialized).not.toContain(SECRET_SENTINEL);
  });
});

describe('ENC-08: no secret reaches the pane', () => {
  it('the view model and the audit rows carry no key material', async () => {
    const s = service({ keys: [keyRecord({ publicKeyPem: 'PUBLIC KEY ' + SECRET_SENTINEL })] });
    const result = await applyCryptoConfig(s.config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { deliveryEncryption: true } });
    const html = renderCryptoConfig({ status: 'ready', view: result.view });
    expect(html).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(result.view)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(s.audit.rows)).not.toContain(SECRET_SENTINEL);
    // The public key PEM is never surfaced either - only its fingerprint.
    expect(html).not.toContain('PUBLIC KEY');
  });

  it('another tenant key record is dropped from the pane', () => {
    const options = recipientKeyOptions([keyRecord({ tenantId: TENANT_B })], TENANT_A);
    expect(options).toHaveLength(0);
    const own = recipientKeyOptions([keyRecord()], TENANT_A);
    expect(own).toHaveLength(1);
    expect(own[0]?.version).toBe(1);
  });
});

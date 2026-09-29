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

// CR28-07: admin crypto configuration negatives.
//
// Four packet areas: revoked-key pinning races, malformed tenant ids, CSRF
// forgery, and fingerprint preview truncation.
//
// A rule adopted here after reading the existing suite: a `not.toContain` leak
// assertion is only worth what it proves. The delta-63 and ENC-08 leak tests
// plant their sentinel in `publicKeyPem` and assert the FULL string is absent -
// which stays true even if a fingerprint field carried the same secret. So the
// fingerprint tests below plant the sentinel IN THE FINGERPRINT and assert the
// exact characters that do reach the output.
describe('CR28-07 admin crypto config: revoked-key pinning races', () => {
  /** A lister that returns a DIFFERENT registry snapshot on each call. */
  function racingKeys(revokedAfterFirstRead: boolean) {
    const snapshots: RecipientKeyOption[][] = [
      [
        { version: 1, fingerprint: 'SHA256:aaa', revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
        { version: 2, fingerprint: 'SHA256:bbb', revokedAt: null, effectiveAt: '2026-02-01T00:00:00.000Z' },
      ],
      [
        { version: 1, fingerprint: 'SHA256:aaa', revokedAt: revokedAfterFirstRead ? '2026-06-01T00:00:00.000Z' : null, effectiveAt: '2026-01-01T00:00:00.000Z' },
        { version: 2, fingerprint: 'SHA256:bbb', revokedAt: null, effectiveAt: '2026-02-01T00:00:00.000Z' },
      ],
    ];
    let calls = 0;
    return {
      calls: () => calls,
      lister: {
        async listRecipientKeys(): Promise<RecipientKeyOption[]> {
          const snapshot = snapshots[Math.min(calls, snapshots.length - 1)]!;
          calls += 1;
          return snapshot;
        },
      },
    };
  }

  function racingService(revokedAfterFirstRead: boolean) {
    const store = new MemoryStore();
    const audit = new MemoryAudit();
    const { lister, calls } = racingKeys(revokedAfterFirstRead);
    const config: CryptoConfigServiceOptions = {
      allowedKeyRefs: ALLOWED,
      store,
      keys: lister,
      audit,
    };
    return { config, store, audit, calls };
  }

  it('a pin accepted against a listing that later revokes is reported, not silently honoured', async () => {
    const s = racingService(true);
    // The TOCTOU window: the pin is validated against the listing this request
    // read, and the registry can change before anyone looks again.
    const applied = await applyCryptoConfig(s.config, {
      auth: operatorAuth(),
      tenantId: TENANT_A,
      mutation: { deliveryEncryption: true, recipientKeyVersion: 1 },
    });
    expect(applied.view.state.pinnedRecipientKeyVersion).toBe(1);
    expect(applied.view.pinInvalid).toBeNull();

    const after = await readCryptoConfig(s.config, { auth: operatorAuth() });
    // The pin is NOT dropped - that would hide the misconfiguration - and
    // delivery is reported blocked instead of looking healthy.
    expect(after.state.pinnedRecipientKeyVersion).toBe(1);
    expect(after.pinInvalid).toEqual({ reason: 'version_revoked', version: 1 });
    expect(after.deliveryReady).toBe(false);
    expect(after.deliveryBlockedReason).toBe('pin_invalid');
    expect(s.calls()).toBeGreaterThan(1);
  });

  it('the same request never mixes two registry snapshots', async () => {
    const s = racingService(true);
    const applied = await applyCryptoConfig(s.config, {
      auth: operatorAuth(),
      tenantId: TENANT_A,
      mutation: { deliveryEncryption: true, recipientKeyVersion: 1 },
    });

    // One listing per request: the pin decision and the returned view are
    // decided by the SAME snapshot, so a response never says "pinned, valid"
    // using a revocation it had not seen yet.
    expect(applied.view.pinInvalid).toBeNull();
    expect(applied.view.deliveryReady).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it('a revoke that happens before the request is refused at write time, not at read time', async () => {
    const store = new MemoryStore();
    const audit = new MemoryAudit();
    const revokedOnly: RecipientKeyOption[] = [
      { version: 1, fingerprint: 'SHA256:aaa', revokedAt: '2026-06-01T00:00:00.000Z', effectiveAt: '2026-01-01T00:00:00.000Z' },
    ];
    const config: CryptoConfigServiceOptions = {
      allowedKeyRefs: ALLOWED,
      store,
      keys: { async listRecipientKeys() { return revokedOnly; } },
      audit,
    };

    await expect(
      applyCryptoConfig(config, { auth: operatorAuth(), tenantId: TENANT_A, mutation: { recipientKeyVersion: 1 } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.writes).toBe(0);
    expect(audit.rows).toHaveLength(0);
  });
});

describe('CR28-07 admin crypto config: malformed tenant ids', () => {
  it.each([
    ['a NUL byte', 'tenant' + String.fromCharCode(0)],
    ['a newline', 'tenant' + String.fromCharCode(10)],
    ['a carriage return', 'tenant' + String.fromCharCode(13)],
    ['a tab', 'tenant' + String.fromCharCode(9)],
    ['a DEL character', 'tenant' + String.fromCharCode(127)],
    ['a C1 control', 'tenant' + String.fromCharCode(133)],
    ['an uppercase letter', 'Tenant-A'],
    ['a leading dash', '-tenant-a'],
    ['a leading dot', '.tenant-a'],
    ['a leading underscore', '_tenant-a'],
    ['a space', 'tenant a'],
    ['a slash', 'tenant/a'],
    ['an empty string', ''],
  ])('refuses %s with 422 for a platform caller', async (_label, tenantId) => {
    const s = service();
    await expect(readCryptoConfig(s.config, { auth: platformAuth, tenantId }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
  });

  it.each([
    ['64 characters', 'a'.repeat(64), true],
    ['65 characters', 'a'.repeat(65), false],
    ['a 64 character id that starts with a digit', '9' + 'a'.repeat(63), true],
    ['a 65 character id that starts with a digit', '9' + 'a'.repeat(64), false],
  ])('accepts exactly %s', async (_label, tenantId, valid) => {
    const s = service();

    if (valid) {
      const view = await readCryptoConfig(s.config, { auth: platformAuth, tenantId });
      expect(view.tenantId).toBe(tenantId);
    } else {
      await expect(readCryptoConfig(s.config, { auth: platformAuth, tenantId }))
        .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    }
  });

  it('a tenant operator naming a FOREIGN malformed id is refused with 403, not 422', async () => {
    const s = service();
    const foreign = await readCryptoConfig(s.config, {
      auth: operatorAuth(),
      tenantId: 'tenant-b' + String.fromCharCode(0),
    }).catch((e: unknown) => e);

    // resolveTargetTenant runs BEFORE assertTenantId, so scope wins over shape.
    // The wording is identical to any other foreign id, so the 403 still
    // cannot be used to probe which tenants exist or which ids are well formed.
    expect(foreign).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    const wellFormedForeign = await readCryptoConfig(s.config, {
      auth: operatorAuth(),
      tenantId: 'tenant-beta',
    }).catch((e: unknown) => e);
    expect((foreign as Error).message).toBe((wellFormedForeign as Error).message);
  });

  it('FINDING: a control character in a tenant id survives esc() into the markup', () => {
    // buildCryptoConfigView only requires a non-empty string, so the API-layer
    // regex is not what protects the pane: escaping is the renderer's job.
    const withNul = 'tenant' + String.fromCharCode(0) + 'a';
    const pane = renderCryptoConfig({
      status: 'ready',
      view: buildCryptoConfigView({
        tenantId: withNul,
        state: EMPTY_CRYPTO_CONFIG,
        allowedKeyRefs: ALLOWED,
        recipientKeys: [],
      }),
    });
    // Positive control first, on the RAW value: JSON.stringify escapes a NUL to
    // \u0000, so asserting the raw byte against a serialised string would fail
    // for the wrong reason.
    const view = buildCryptoConfigView({
      tenantId: withNul,
      state: EMPTY_CRYPTO_CONFIG,
      allowedKeyRefs: ALLOWED,
      recipientKeys: [],
    });
    expect(view.tenantId).toBe(withNul);
    expect(view.tenantId.includes(String.fromCharCode(0))).toBe(true);

    // FINDING: esc() escapes exactly five characters (& < > " ') and passes every
    // control character through untouched, so the NUL lands in the markup. The
    // renderer's own header calls these values "untrusted by construction" -
    // true for the characters that can close a tag, not for control characters.
    // A NUL cannot break out of the quoted attribute (the quote IS escaped), so
    // this is a parser-differential / smuggling surface rather than a direct XSS;
    // the point is that the stated invariant is wider than the code.
    expect(pane).toContain('name="tenantId" value="tenant' + String.fromCharCode(0) + 'a"');

    const withBreak = 'tenant' + String.fromCharCode(13) + String.fromCharCode(10) + 'a';
    const breakPane = renderCryptoConfig({
      status: 'ready',
      view: buildCryptoConfigView({
        tenantId: withBreak,
        state: EMPTY_CRYPTO_CONFIG,
        allowedKeyRefs: ALLOWED,
        recipientKeys: [],
      }),
    });
    expect(breakPane).toContain(String.fromCharCode(13) + String.fromCharCode(10));

    // The five escaped characters DO hold - so the gap is control characters
    // specifically, not escaping in general.
    const tagPane = renderCryptoConfig({
      status: 'ready',
      view: buildCryptoConfigView({
        tenantId: [String.fromCharCode(34), '><script>&', String.fromCharCode(39)].join(''),
        state: EMPTY_CRYPTO_CONFIG,
        allowedKeyRefs: ALLOWED,
        recipientKeys: [],
      }),
    });
    expect(tagPane).not.toContain('<script>');
    expect(tagPane).toContain('&lt;script&gt;');
    expect(tagPane).toContain('&amp;');
    expect(tagPane).not.toContain(String.fromCharCode(0));
  });
});

describe('CR28-07 admin crypto config: CSRF forgery', () => {
  const valid = deriveCsrfToken(COOKIE_SECRET, SESSION_COOKIE);

  it('a token minted for a DIFFERENT session cookie is refused', async () => {
    // The real forgery: an attacker who somehow obtained a valid token for
    // THEIR OWN session replays it against a victim's cookie value.
    const s = service();
    const forged = deriveCsrfToken(COOKIE_SECRET, 'someone-elses-session');
    expect(forged).not.toBe(valid);
    const req = { auth: operatorAuth({ csrfToken: forged }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('a token minted with a DIFFERENT secret is refused', async () => {
    const s = service();
    const forged = deriveCsrfToken('a-rotated-or-guessed-secret', SESSION_COOKIE);
    const req = { auth: operatorAuth({ csrfToken: forged }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it.each([
    ['the first character changed', 'X' + valid.slice(1)],
    ['the last character changed', valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a')],
    ['one character removed', valid.slice(1)],
    ['one character appended', valid + 'a'],
    ['a different case', valid.toUpperCase()],
  ])('a token with %s is refused', async (_label, provided) => {
    const s = service();
    const req = { auth: operatorAuth({ csrfToken: provided }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
    await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    expect(s.store.writes).toBe(0);
  });

  it('the token length boundary is the HMAC hex length, not the 128 cap', async () => {
    const s = service();
    expect(valid).toHaveLength(64);
    // 64 is the only accepted length: the helper compares buffer lengths before
    // timingSafeEqual, so 63 and 65 can never match.
    for (const length of [63, 65, 128, 129]) {
      const req = { auth: operatorAuth({ csrfToken: 'a'.repeat(length) }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } };
      await expect(applyCryptoConfig(s.config, req)).rejects.toMatchObject({ status: 403 });
    }
    expect(s.store.writes).toBe(0);
    const ok = await applyCryptoConfig(s.config, { auth: operatorAuth({ csrfToken: valid }), tenantId: TENANT_A, mutation: { deliveryEncryption: true } });
    expect(ok.view.state.deliveryEncryption).toBe(true);
  });

  it('FINDING: a tenant principal with no cookieRole skips the CSRF gate entirely', async () => {
    const s = service();
    // requireWriteAuth returns early on `auth.cookieRole === undefined`, so a
    // tenant_operator principal presented WITHOUT verified cookie claims never
    // reaches validateCsrfToken. resolveAdminPrincipal DOES return
    // tenant_operator for a tenant-scoped bearer token, so this is the shape a
    // bearer-authenticated tenant request takes. Not cross-site exploitable - a
    // cross-site page cannot send an Authorization header - but the gate keys on
    // an incidental signal instead of the credential kind.
    const bearerTenant = { principal: { role: 'tenant_operator', tenantId: TENANT_A } as const };
    const result = await applyCryptoConfig(s.config, {
      auth: bearerTenant,
      tenantId: TENANT_A,
      mutation: { deliveryEncryption: true },
    });
    expect(result.view.state.deliveryEncryption).toBe(true);
    expect(s.store.writes).toBe(1);
  });

  it('adding ANY cookie role arms the CSRF gate again', () => {
    const withRole = operatorAuth({ cookieRole: 'admin', csrfToken: undefined });
    expect(withRole.cookieRole).toBe('admin');
    expect(withRole.csrfToken).toBeUndefined();
  });

  it('a viewer is refused BEFORE the CSRF check, and the two 403 wordings stay distinct', async () => {
    const s = service();
    const viewer = operatorAuth({ cookieRole: 'viewer' });
    const withValidToken = await applyCryptoConfig(s.config, {
      auth: viewer, tenantId: TENANT_A, mutation: { deliveryEncryption: true },
    }).catch((e: unknown) => e);
    const withBadToken = await applyCryptoConfig(s.config, {
      auth: operatorAuth({ cookieRole: 'viewer', csrfToken: 'nope' }), tenantId: TENANT_A, mutation: { deliveryEncryption: true },
    }).catch((e: unknown) => e);

    // Both are 403 with the SAME wording, and that is the ordering proof: the
    // viewer check short-circuits before validateCsrfToken is reached, so a bad
    // token from a viewer still reports the ROLE, never the CSRF state. I first
    // asserted the wordings differed; they do not, and the identical answer is
    // the better behaviour here - it tells a prober nothing about the proof.
    expect(withValidToken).toMatchObject({ status: 403 });
    expect(withBadToken).toMatchObject({ status: 403 });
    expect((withValidToken as Error).message).toBe((withBadToken as Error).message);
    expect((withValidToken as Error).message).toContain('may read but not change');
    expect(s.store.writes).toBe(0);
  });
});

describe('CR28-07 admin crypto config: fingerprint preview bounds', () => {
  it.each([
    ['an empty string', '', '(unknown)'],
    ['a prefix with no body', 'SHA256:', '...'],
    ['one character', 'a', 'a...'],
    ['eleven characters', 'abcdefghijk', 'abcdefghijk...'],
    ['exactly twelve characters', 'abcdefghijkl', 'abcdefghijkl...'],
    ['thirteen characters', 'abcdefghijklm', 'abcdefghijkl...'],
    ['a prefixed short body', 'SHA256:abc', 'abc...'],
    ['a prefixed body of exactly twelve', 'SHA256:abcdefghijkl', 'abcdefghijkl...'],
    ['a prefixed body of thirteen', 'SHA256:abcdefghijklm', 'abcdefghijkl...'],
  ])('previews %s', (_label, fingerprint, expected) => {
    expect(fingerprintPreview(fingerprint)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('previews %s as unknown rather than throwing', (_label, value) => {
    expect(fingerprintPreview(value as unknown as string)).toBe('(unknown)');
  });

  it('FINDING: the preview renders the FIRST 12 CHARACTERS of whatever the fingerprint holds', () => {
    // Positive control: the sentinel really is in the field under test. The
    // existing ENC-08 leak test plants its sentinel in publicKeyPem instead, so
    // it stays green even when the fingerprint field carries a secret - it
    // proves a full string is absent, not that nothing leaks.
    const secretFingerprint = 'SHA256:' + SECRET_SENTINEL;
    expect(SECRET_SENTINEL.length).toBeGreaterThan(12);
    const firstTwelve = SECRET_SENTINEL.slice(0, 12);

    const pane = renderCryptoConfig({
      status: 'ready',
      view: buildCryptoConfigView({
        tenantId: TENANT_A,
        state: EMPTY_CRYPTO_CONFIG,
        allowedKeyRefs: ALLOWED,
        recipientKeys: [
          { version: 1, fingerprint: secretFingerprint, revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    });

    // Twelve characters of a private key DO reach the markup. The pane's own
    // rule 1 says "a preview that has nothing to leak" - that holds only while
    // the fingerprint field really holds a fingerprint.
    expect(pane).toContain('data-fingerprint-preview="' + firstTwelve + '..."');
    expect(pane).toContain(firstTwelve);
    expect(pane).not.toContain(SECRET_SENTINEL);
  });

  it('FINDING: the view model carries the FULL fingerprint, so only the renderer protects it', () => {
    const secretFingerprint = 'SHA256:' + SECRET_SENTINEL;
    const view = buildCryptoConfigView({
      tenantId: TENANT_A,
      state: EMPTY_CRYPTO_CONFIG,
      allowedKeyRefs: ALLOWED,
      recipientKeys: [
        { version: 1, fingerprint: secretFingerprint, revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    // The API response body is `{ schemaVersion, tenantId, crypto: view }`, so
    // whatever the view model holds is what a caller receives. The claim that
    // no secret reaches this layer is a property of the FIELD, not of the code.
    expect(view.recipientKeys[0]!.fingerprint).toBe(secretFingerprint);
    expect(JSON.stringify(view)).toContain(SECRET_SENTINEL);
  });

  it('a fingerprint without the SHA256: prefix is previewed verbatim', () => {
    // Only the known prefix is stripped, so a differently formatted value is
    // cut in the middle of itself: 'md5:' plus 8 more characters is 12.
    expect(fingerprintPreview('md5:abcdefghijklmnop')).toBe('md5:abcdefgh...');
    expect('md5:abcdefgh').toHaveLength(12);
  });
});

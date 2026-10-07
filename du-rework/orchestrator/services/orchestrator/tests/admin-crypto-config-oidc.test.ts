/**
 * W-ENC-08-CSRF-OIDC (Delta 113): the OIDC session plane must own the crypto-config
 * CSRF proof, exactly as it owns identity.
 *
 * Why this is not a formality. Before this cycle the gate verified a token derived from
 * the LEGACY `du_admin` cookie, even when the request rode an opaque `du_session`. Under
 * OIDC that is wrong in one direction or the other: either the form is handed a token
 * the gate will refuse, or the gate accepts a token minted for a different plane.
 *
 * Pinned here, per the packet:
 *
 *   1. a live session's OWN token is accepted and applies the change;
 *   2. a legacy-derived token is REFUSED once a session rides the request - the session
 *      plane decides, with no fallback, mirroring the identity rule in the async gate;
 *   3. a wrong session token is refused and the applier never runs;
 *   4. a legacy-ONLY deployment is untouched (no store = du_admin derivation still works);
 *   5. a `du_session` with no store record yields no token, so the pane is read-only
 *      rather than shipping a Save button that can only 403.
 *
 * Offline: no socket, no DB, no IdP. The session store is a stub, but the CSRF comparison
 * is the REAL `verifySessionCsrf` primitive, so the format check and the constant-time
 * compare are the production ones.
 */

import {
  dispatchShellRequest,
  registerCryptoConfigWiring,
} from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import { deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import type { AdminShellRequest, AdminCookieClaims } from '../src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import {
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigState,
  type CryptoConfigStore,
} from '../src/app/admin/crypto-config-api';
import { registerAdminCryptoConfigWiring } from '../src/server';
import type { RecipientPublicKeyRecord } from '../src/modules/encryption/recipient-key-registry';

const TENANT = 'oidc-csrf-tenant';
const COOKIE_SECRET = 'oidc-csrf-cookie-secret';
/**
 * A live session's server-side CSRF token: 43-char base64url, the shape the OIDC
 * store mints and `verifySessionCsrf` enforces. The length is not decoration -
 * the real primitive rejects a shorter value before it ever compares.
 */
const SESSION_CSRF = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_AaBbC';
/** Opaque session ids are 43 base64url chars. */
const SESSION_ID = 's'.repeat(43);

class MemoryStore implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  async get(tenantId: string): Promise<CryptoConfigState> {
    const empty: CryptoConfigState = {
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: null,
    };
    return this.rows.get(tenantId) ?? empty;
  }
  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    this.rows.set(tenantId, next);
    return next;
  }
}

class MemoryAudit implements CryptoConfigAudit {
  public readonly rows: unknown[] = [];
  async record(input: unknown): Promise<unknown> {
    this.rows.push(input);
    return { ok: true };
  }
}

/** A live OIDC session store returning the role and the server-side CSRF token. */
function sessionStore(token: string) {
  return {
    async get(id: string) {
      if (id !== SESSION_ID) return null;
      return { role: 'admin' as const, csrfToken: token, tenantId: TENANT };
    },
  };
}

function adminClaims(): AdminCookieClaims {
  return { role: 'admin', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 };
}

function adminCookie(): string {
  const c = signCookie(COOKIE_SECRET, {
    role: 'admin',
    iss: 'du-admin-shell',
    iat: 1000,
    exp: 9999999999999,
  });
  return c ?? '';
}

interface Fixture {
  store: MemoryStore;
  audit: MemoryAudit;
  service: CryptoConfigServiceOptions;
  config: ShellRuntimeConfig;
}

/** The service the composition root wires, plus a shell config with no store. */
function fixture(): Fixture {
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const service: CryptoConfigServiceOptions = {
    allowedKeyRefs: ['primary'],
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        if (tenantId !== TENANT) return [];
        // Shaped like a real ENC-06 record: the tenantId is what the
        // projection filters on, so a record without it yields an empty
        // option list and every pin would be refused.
        const one: RecipientPublicKeyRecord[] = [{
          id: 'oidc-key-1',
          tenantId: TENANT,
          version: 1,
          algorithm: 'rsa-oaep-sha256',
          publicKeyPem: 'BEGIN PUBLIC KEY fixture',
          fingerprint: 'SHA256:oidc',
          effectiveAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
        }];
        return recipientKeyOptions(one, tenantId);
      },
    },
    audit,
  };
  const config: ShellRuntimeConfig = { cookieSecret: COOKIE_SECRET, adminToken: 'at' };
  registerAdminCryptoConfigWiring(
    { cryptoConfig: { allowedKeyRefs: ['primary'] } } as never,
    service,
  );
  return { store, audit, service, config };
}

function sessionRequest(over: Partial<AdminShellRequest> = {}): AdminShellRequest {
  return {
    method: 'GET',
    pathname: '/admin/crypto-config',
    cookies: { du_session: SESSION_ID },
    body: {},
    // The pane reads its tenant from the query; without it the wiring answers
    // CRYPTO_CONFIG_TENANT_REQUIRED, which is the honest result, not a pane.
    query: { tenantId: TENANT },
    ...over,
  };
}

function legacyRequest(over: Partial<AdminShellRequest> = {}): AdminShellRequest {
  return {
    method: 'GET',
    pathname: '/admin/crypto-config',
    cookies: { du_admin: adminCookie() },
    body: {},
    query: { tenantId: TENANT },
    ...over,
  };
}

describe('W-ENC-08-CSRF-OIDC: the session plane owns the crypto-config proof', () => {
  afterEach(() => {
    registerCryptoConfigWiring({});
  });

  it('the pane renders the SESSION token, not a legacy-derived one', async () => {
    const f = fixture();
    const cfg: ShellRuntimeConfig = { ...f.config, oidcSessions: sessionStore(SESSION_CSRF) };
    const out = dispatchShellRequest(sessionRequest(), cfg, adminClaims(), SESSION_CSRF);
    const html = await out.response.deferredSectionExtras?.();
    expect(html).toContain('name="csrf"');
    expect(html).toContain(SESSION_CSRF);
  });

  it('a POST carrying the session token is accepted and applies the change', async () => {
    const f = fixture();
    const cfg: ShellRuntimeConfig = { ...f.config, oidcSessions: sessionStore(SESSION_CSRF) };
    const body: Record<string, string> = {
      tenantId: TENANT,
      csrf: SESSION_CSRF,
      deliveryEncryption: 'on',
    };
    const out = dispatchShellRequest(
      sessionRequest({ method: 'POST', body }),
      cfg,
      adminClaims(),
      SESSION_CSRF,
    );
    expect(out.response.status).toBe(302);
    await out.response.deferredSectionExtras?.();
    expect(f.store.rows.get(TENANT)?.deliveryEncryption).toBe(true);
  });

  it('a legacy-derived token is REFUSED once the session plane is in play', async () => {
    const f = fixture();
    const cfg: ShellRuntimeConfig = { ...f.config, oidcSessions: sessionStore(SESSION_CSRF) };
    const legacy = deriveCsrfToken(COOKIE_SECRET, adminCookie());
    const body: Record<string, string> = { tenantId: TENANT, csrf: legacy, deliveryEncryption: 'on' };
    const out = dispatchShellRequest(
      sessionRequest({ method: 'POST', body }),
      cfg,
      adminClaims(),
      SESSION_CSRF,
    );
    expect(out.response.status).toBe(403);
    expect(f.store.rows.size).toBe(0);
    expect(f.audit.rows).toHaveLength(0);
  });

  it('a wrong session token is refused and the applier never runs', () => {
    const f = fixture();
    const cfg: ShellRuntimeConfig = { ...f.config, oidcSessions: sessionStore(SESSION_CSRF) };
    const body: Record<string, string> = { tenantId: TENANT, csrf: 'Z'.repeat(43), deliveryEncryption: 'on' };
    const out = dispatchShellRequest(
      sessionRequest({ method: 'POST', body }),
      cfg,
      adminClaims(),
      SESSION_CSRF,
    );
    expect(out.response.status).toBe(403);
    expect(f.store.rows.size).toBe(0);
  });

  it('a legacy-ONLY deployment is untouched: no store means the du_admin derivation', async () => {
    const f = fixture();
    const out = dispatchShellRequest(legacyRequest(), f.config);
    const html = await out.response.deferredSectionExtras?.();
    expect(html).toContain(deriveCsrfToken(COOKIE_SECRET, adminCookie()));
    expect(html).not.toContain(SESSION_CSRF);
  });

  it('a du_session with no store record yields no token, so the pane is read-only', async () => {
    const f = fixture();
    const deadStore = {
      async get() {
        return null;
      },
    };
    const cfg: ShellRuntimeConfig = { ...f.config, oidcSessions: deadStore };
    const out = dispatchShellRequest(sessionRequest(), cfg, adminClaims(), 'unset');
    const html = await out.response.deferredSectionExtras?.();
    expect(html).toContain('data-crypto-config-readonly="true"');
    expect(html).not.toContain('name="csrf"');
  });
});

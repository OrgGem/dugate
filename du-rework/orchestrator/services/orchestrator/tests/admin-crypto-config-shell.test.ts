/**
 * W-ADM-UX-08-SHELL (Delta 106): the Admin shell's crypto-configuration pane,
 * wired from the composition root and gated end to end.
 *
 * Offline: no socket, no DB, no Vault. The crypto-config service is the
 * real one over an in-memory store and a stub registry; the shell is driven
 * through the real `dispatchShellRequest` with a genuinely signed cookie.
 *
 * Pinned here, in the order the packet lists it: the wiring renders real data
 * instead of the not-wired error pane (the Delta 106 gap); no session is 401 and
 * a viewer is 403; the CSRF gate runs BEFORE the applier, so a forged request
 * never reaches validation; and neither the HTML nor the view model may carry
 * the recipient key, a private key, the admin bearer or the CSRF token.
 */

import {
  dispatchShellRequest,
  matchShellRoute,
  registerCryptoConfigWiring,
} from '../src/app/admin/shell-router';
import { registerAdminCryptoConfigWiring } from '../src/server';
import { signCookie } from '../src/app/admin/shell-auth';
import { renderCryptoConfigForm } from '../src/app/admin/crypto-config-renderer';
import { buildCryptoConfigView, type RecipientKeyOption } from '../src/app/admin/crypto-config-view-models';
import { deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import {
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigState,
  type CryptoConfigStore,
} from '../src/app/admin/crypto-config-api';

const TENANT = 'shell-enc-tenant';
const ADMIN_TOKEN = 'shell-enc-admin-token';
const COOKIE_SECRET = 'shell-enc-cookie-secret';
const SECRET_PEM = 'BEGIN PRIVATE KEY MUST-NEVER-RENDER';

/** A ready pane view, for renderer-level assertions. */
const READY_KEYS: RecipientKeyOption[] = [
  { version: 1, fingerprint: 'SHA256:shellfixture', revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
];
const READY_VIEW = buildCryptoConfigView({
  tenantId: TENANT,
  state: { storageKeyRef: 'primary', deliveryEncryption: false, pinnedRecipientKeyVersion: null },
  allowedKeyRefs: ['primary'],
  recipientKeys: READY_KEYS,
});

class MemoryStore implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  async get(tenantId: string): Promise<CryptoConfigState> {
    const empty: CryptoConfigState = { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: null };
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

interface Fixture {
  store: MemoryStore;
  service: CryptoConfigServiceOptions;
  audit: MemoryAudit;
  config: ShellRuntimeConfig;
}

/** The service the composition root wires, plus a matching shell config. */
function fixture(): Fixture {
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const record = {
    id: 'shell-key-1',
    tenantId: TENANT,
    version: 1,
    algorithm: 'rsa-oaep-sha256' as const,
    publicKeyPem: 'BEGIN PUBLIC KEY fixture',
    fingerprint: 'SHA256:shellfixture',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  };
  const service: CryptoConfigServiceOptions = {
    allowedKeyRefs: ['primary'],
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        return recipientKeyOptions([record], tenantId);
      },
    },
    audit,
  };
  const config: ShellRuntimeConfig = {
    cookieSecret: COOKIE_SECRET,
    adminToken: ADMIN_TOKEN,
  };
  return { store, service, audit, config };
}

/** The real composition-root wiring, called the way createApp calls it. */
function wire(f: Fixture, serverConfig: Record<string, unknown> = {}): void {
  registerAdminCryptoConfigWiring(
    { cryptoConfig: { allowedKeyRefs: ['primary'] }, ...serverConfig } as never,
    f.service,
  );
}

function adminCookie(): string {
  const c = signCookie(COOKIE_SECRET, { role: 'admin', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });
  return c ?? '';
}

function viewerCookie(): string {
  const c = signCookie(COOKIE_SECRET, { role: 'viewer', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });
  return c ?? '';
}

function shellRequest(over: Partial<AdminShellRequest> = {}): AdminShellRequest {
  const base: AdminShellRequest = {
    method: 'GET',
    pathname: '/admin/crypto-config',
    cookies: { du_admin: adminCookie() },
    body: {},
    query: { tenantId: TENANT },
  };
  return { ...base, ...over };
}

async function paneHtml(f: Fixture, request: AdminShellRequest): Promise<string> {
  const out = dispatchShellRequest(request, f.config);
  const extras = await out.response.deferredSectionExtras?.();
  return extras ?? '';
}

describe('W-ADM-UX-08-SHELL: crypto-config pane wiring', () => {
  afterEach(() => {
    registerCryptoConfigWiring({});
  });

  it('a GET without the composition wiring renders the not-wired pane', async () => {
    const f = fixture();
    const html = await paneHtml(f, shellRequest());
    expect(html).toContain('CRYPTO_CONFIG_NOT_WIRED');
  });

  it('the registered resolver renders the real tenant configuration', async () => {
    const f = fixture();
    wire(f);
    const html = await paneHtml(f, shellRequest());
    expect(html).toContain('data-crypto-config-form');
    expect(html).toContain('data-recipient-key-select');
    expect(html).toContain('name="tenantId"');
  });
});

describe('W-ADM-UX-08-SHELL: RBAC and CSRF', () => {
  afterEach(() => {
    registerCryptoConfigWiring({});
  });

  it('a signed-out visitor is 401', () => {
    const f = fixture();
    wire(f);
    const out = dispatchShellRequest(shellRequest({ cookies: {} }), f.config);
    expect(out.response.status).toBe(401);
  });

  it('a viewer session is 403', () => {
    const f = fixture();
    wire(f);
    const out = dispatchShellRequest(
      shellRequest({ cookies: { du_admin: viewerCookie() } }),
      f.config,
    );
    expect(out.response.status).toBe(403);
  });

  it('a POST is now a route (the pane form has somewhere to go)', () => {
    expect(matchShellRoute('POST', '/admin/crypto-config')).toMatchObject({
      id: 'admin-crypto-config',
      requiredRole: 'admin',
    });
  });
});

describe('W-ADM-UX-08-SHELL: CSRF gates the mutation', () => {
  afterEach(() => {
    registerCryptoConfigWiring({});
  });

  function post(f: Fixture, body: Record<string, string>): ReturnType<typeof dispatchShellRequest> {
    return dispatchShellRequest(
      shellRequest({ method: 'POST', body }),
      f.config,
    );
  }

  it('a POST without a CSRF proof is 403 and the applier never runs', async () => {
    const f = fixture();
    wire(f);
    const out = post(f, { tenantId: TENANT, deliveryEncryption: 'on' });
    expect(out.response.status).toBe(403);
    expect(await out.response.deferredSectionExtras?.()).toBeUndefined();
    expect(f.store.rows.size).toBe(0);
    expect(f.audit.rows).toHaveLength(0);
  });

  it('a POST with a forged token is 403', () => {
    const f = fixture();
    wire(f);
    const out = post(f, { tenantId: TENANT, csrf: 'forged' });
    expect(out.response.status).toBe(403);
    expect(f.store.rows.size).toBe(0);
  });
});

describe('W-ADM-UX-08-SHELL: an accepted save applies and redirects', () => {
  afterEach(() => {
    registerCryptoConfigWiring({});
  });

  it('the same POST WITH the derived token applies the change', async () => {
    const f = fixture();
    wire(f);
    const cookie = adminCookie();
    const body: Record<string, string> = {
      tenantId: TENANT,
      csrf: deriveCsrfToken(COOKIE_SECRET, cookie),
      deliveryEncryption: 'on',
      storageKeyRef: 'primary',
    };
    const out = dispatchShellRequest(
      shellRequest({ method: 'POST', cookies: { du_admin: cookie }, body }),
      f.config,
    );
    expect(out.response.status).toBe(302);
    expect(out.response.headers['location']).toContain(encodeURIComponent(TENANT));
    // The mutation rides the deferred hook, so the store changes when the
    // extras resolve - not when dispatch returns.
    await out.response.deferredSectionExtras?.();
    expect(f.store.rows.get(TENANT)?.deliveryEncryption).toBe(true);
    expect(f.store.rows.get(TENANT)?.storageKeyRef).toBe('primary');
    expect(f.audit.rows.length).toBe(2);
  });
});

describe('W-ADM-UX-08-SHELL: nothing sensitive reaches the DOM', () => {
  afterEach(() => {
    registerCryptoConfigWiring({});
  });

  it('the pane carries no key material, bearer or SECRET — and the token it does carry is session-bound', async () => {
    // W-ENC-08-RENDERER-CSRF (Delta 112) deliberately renders the derived CSRF
    // token: a form that cannot prove itself can never be saved, so omitting it
    // made every browser submit a guaranteed 403. The token is the HMAC, not the
    // secret - the SECRET is what must never reach the DOM, and what a cross-site
    // page could not compute the token from anyway.
    const f = fixture();
    wire(f);
    const html = await paneHtml(f, shellRequest());
    expect(html).not.toContain(SECRET_PEM);
    expect(html).not.toContain('BEGIN PUBLIC KEY');
    expect(html).not.toContain(ADMIN_TOKEN);
    expect(html).not.toContain(COOKIE_SECRET);
    // The token IS rendered, and it is bound to THIS session, not a constant.
    expect(html).toContain(deriveCsrfToken(COOKIE_SECRET, adminCookie()));
    expect(html).not.toContain(deriveCsrfToken(COOKIE_SECRET, 'someone-elses-session'));
    expect(html).toContain('data-fingerprint-preview');
  });

  it('a signed-out visitor gets 401, never a pane (the read-only branch is not that case)', async () => {
    const f = fixture();
    wire(f);
    const out = dispatchShellRequest(shellRequest({ cookies: {} }), f.config);
    expect(out.response.status).toBe(401);
  });

  it('the renderer renders READ-ONLY when handed no CSRF proof', () => {
    // Defence in depth, tested at the layer that owns the branch. Through the
    // route this state is practically unreachable: a verified session already
    // implies a non-empty secret to derive the token FROM. So the branch is a
    // guard, not a normal operating mode - and it is asserted as such.
    const pane = { status: 'ready' as const, view: READY_VIEW };
    const html = renderCryptoConfigForm(pane, '');
    expect(html).toContain('data-crypto-config-readonly="true"');
    expect(html).toContain('data-crypto-config-readonly-notice="true"');
    expect(html).not.toContain('data-crypto-config-save');
    expect(html).not.toContain('name="csrf"');
  });

  it('end to end: the token rendered in the DOM is the one the POST gate accepts', async () => {
    // The proof that closes Delta 112: take the token OUT of the rendered HTML
    // and post it back, exactly as a browser would. If the renderer emitted
    // anything other than what the gate re-derives, this goes 403.
    const f = fixture();
    wire(f);
    const cookie = adminCookie();
    const request = shellRequest({ cookies: { du_admin: cookie } });
    const html = await paneHtml(f, request);
    const match = /name="csrf" value="([a-f0-9]+)"/.exec(html);
    expect(match).not.toBeNull();
    const fromDom = match?.[1] ?? '';
    expect(fromDom).toBe(deriveCsrfToken(COOKIE_SECRET, cookie));

    const out = dispatchShellRequest(
      shellRequest({
        method: 'POST',
        cookies: { du_admin: cookie },
        body: { tenantId: TENANT, csrf: fromDom, deliveryEncryption: 'on' },
      }),
      f.config,
    );
    expect(out.response.status).toBe(302);
    await out.response.deferredSectionExtras?.();
    expect(f.store.rows.get(TENANT)?.deliveryEncryption).toBe(true);
  });
});

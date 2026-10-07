/**
 * crypto-config-dispatch - extracted from shell-router.ts by CONV-12.
 *
 * Declarations moved VERBATIM: no behaviour change, no signature change.
 * Shared types and pure query helpers live in ./shell-router-shared, which imports
 * nothing from this directory, so no module here imports shell-router.ts back - the
 * split adds no cycle. shell-router.ts re-exports every moved public name, so
 * server.ts, shell-server.ts, index.ts and the tests are untouched.
 */
import { ROLE_ORDER } from './types';
import type { AdminCookieClaims, AdminShellResponse } from './shell-types';
import {
  buildAdminShellView,
  buildScreenState,
  getCanonicalNavItems,
} from './p6-01-shell-fixtures';
import type { AdminShellRequest } from './shell-types';
import { SESSION_COOKIE_NAME, verifySessionCsrf, type SessionRecord } from '../../modules/auth/session-store';
import { renderCryptoConfig } from './crypto-config-renderer';
import { deriveCsrfToken, validateCsrfToken } from '../../modules/admin-actions/rbac';
import {
  renderErrorPage,
  renderLoginPage,
  renderShell,
} from './shell-render';
import { CryptoConfigApply } from './shell-router-shared';
import type { ShellRuntimeConfig, CryptoConfigPaneResolver } from './shell-router-shared';


/**
 * W-ADM-UX-08-SHELL: process-level holder for the composition root's wiring.
 *
 * `attachAdminShell` builds its `ShellRuntimeConfig` from a fixed field list
 * inside shell-server.ts, and that file is outside this packet's scope, so the
 * resolver cannot be passed through `ServerConfig`. The composition root
 * therefore REGISTERS it here once at boot, and the route reads it when the
 * per-request config does not carry one. A stale registration from a previous
 * app in the same process is why `createApp` always calls this - including with
 * `undefined` to clear, so a test that boots two apps cannot inherit the
 * first one's resolver.
 */
export let registeredCryptoConfigPane: CryptoConfigPaneResolver | undefined;
export let registeredCryptoConfigApply: CryptoConfigApply | undefined;

export function registerCryptoConfigWiring(input: {
  pane?: CryptoConfigPaneResolver;
  apply?: CryptoConfigApply;
}): void {
  registeredCryptoConfigPane = input.pane;
  registeredCryptoConfigApply = input.apply;
}

/** The pane resolver in effect: per-request config first, then the boot registration. */
export function cryptoConfigPaneResolver(config: ShellRuntimeConfig): CryptoConfigPaneResolver | undefined {
  return config.cryptoConfigPane ?? registeredCryptoConfigPane;
}

export function cryptoConfigApplier(config: ShellRuntimeConfig): CryptoConfigApply | undefined {
  return config.cryptoConfigApply ?? registeredCryptoConfigApply;
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

/**
 * ENC-08-WIRING: GET /admin/crypto-config. Same shape as a section GET -
 * cookie claims, then the role guard - and the pane itself arrives through the
 * deferred extras hook, so the synchronous dispatcher stays synchronous.
 *
 * A resolver that throws renders the error pane rather than a stack trace: a
 * crypto pane that cannot load must say so, not look empty.
 */
export function handleCryptoConfigGet(
  requiredRole: 'admin' | 'operator' | 'viewer',
  request: AdminShellRequest,
  claims: AdminCookieClaims | null,
  config: ShellRuntimeConfig,
): AdminShellResponse {
  if (!claims) {
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 401,
        title: 'Sign-in required',
        message: 'Sign in to view the Admin shell.',
      }),
    };
  }
  if (ROLE_ORDER[claims.role] < ROLE_ORDER[requiredRole]) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Access denied',
        message: `Role '${claims.role}' is not authorized for crypto configuration (requires 'admin').`,
      }),
    };
  }
  const view = buildAdminShellView({
    role: claims.role,
    path: request.pathname,
    navItems: getCanonicalNavItems(),
    dataAvailable: { kind: 'ready' },
  });
  const screen = buildScreenState({
    role: claims.role,
    section: null,
    dataAvailable: { kind: 'ready' },
  });
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderShell(view, screen),
    deferredSectionExtras: async () => {
      const resolve = cryptoConfigPaneResolver(config);
      if (!resolve) {
        return renderCryptoConfig({ status: 'error', code: 'CRYPTO_CONFIG_NOT_WIRED' });
      }
      try {
        // W-ENC-08-RENDERER-CSRF (Delta 112): the pane's form must carry the
        // CSRF proof the POST gate will re-derive, or every browser save is a
        // guaranteed 403. It is a binding, not a page-specific nonce, and the
        // SECRET is never rendered anywhere.
        // W-ENC-08-CSRF-OIDC (Delta 113): under an OIDC session the gate
        // verifies the SESSION's server-side token, so the form must carry
        // that one. Falling back to the legacy du_admin derivation here would
        // render a proof the POST leg then refuses.
        const sessionId = request.cookies[SESSION_COOKIE_NAME];
        const sessionStore = config.oidcSessions;
        let csrfToken = '';
        if (sessionStore && typeof sessionId === 'string' && sessionId.length > 0) {
          const session = await sessionStore.get(sessionId);
          csrfToken = session?.csrfToken ?? '';
        } else {
          const sessionCookie = request.cookies['du_admin'] ?? '';
          csrfToken = config.cookieSecret && sessionCookie
            ? deriveCsrfToken(config.cookieSecret, sessionCookie)
            : '';
        }
        return renderCryptoConfig(await resolve(request), csrfToken);
      } catch {
        return renderCryptoConfig({ status: 'error', code: 'CRYPTO_CONFIG_UNAVAILABLE' });
      }
    },
  };
}

/**
 * W-ADM-UX-08-SHELL (Delta 106): POST /admin/crypto-config - the pane form's
 * save. Three gates, in order, and the first one that fails decides the answer:
 *
 *   1. a valid signed cookie session, then role >= admin (same guard as the GET);
 *   2. the server-derived CSRF token, re-derived from the presented cookie and
 *      the shell secret with a constant-time compare. A cross-site form can SEND
 *      the cookie (SameSite=Strict is the first layer) but cannot compute the
 *      HMAC, so this is the gate that makes the mutation non-forgeable;
 *   3. only then the composition-root applier runs.
 *
 * A failed CSRF proof answers 403 and NEVER calls the applier, so a forged
 * request cannot even reach the validation that would have rejected it.
 */
export function handleCryptoConfigPost(
  requiredRole: 'admin' | 'operator' | 'viewer',
  request: AdminShellRequest,
  claims: AdminCookieClaims | null,
  config: ShellRuntimeConfig,
  /**
   * W-ENC-08-CSRF-OIDC (Delta 113): the live session's server-side CSRF
   * token, supplied by the async session gate. Present => the SESSION plane
   * decides the proof, exactly as it decides identity: the token is checked
   * with the OIDC primitive and there is NO fallback to the legacy
   * du_admin derivation, because falling back would let a request that rides a
   * revoked-or-mismatched session plane authenticate against the other one.
   */
  oidcCsrfToken?: string,
): AdminShellResponse {
  if (!claims) {
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 401,
        title: 'Sign-in required',
        message: 'Sign in to view the Admin shell.',
      }),
    };
  }
  if (ROLE_ORDER[claims.role] < ROLE_ORDER[requiredRole]) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Access denied',
        message: `Role '${claims.role}' is not authorized to change crypto configuration (requires 'admin').`,
      }),
    };
  }
  const sessionCookie = request.cookies['du_admin'] ?? '';
  const provided = request.body['csrf'];
  // Delta 113: under an OIDC session the proof is the session's own token,
  // compared with the OIDC primitive (format check + constant time). The
  // narrowing is honest: verifySessionCsrf reads exactly one field, csrfToken,
  // and AdminSessionView is the projection that carries it. Reusing the real
  // primitive is the point — a hand-rolled second comparison is how the two
  // planes drift apart.
  const csrfOk = typeof oidcCsrfToken === 'string'
    ? verifySessionCsrf({ csrfToken: oidcCsrfToken } as SessionRecord, provided)
    : validateCsrfToken({
        secret: config.cookieSecret,
        sessionCookie,
        provided,
      });
  if (!csrfOk) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Request rejected',
        message: 'Missing or invalid CSRF proof. Reload the page and try again.',
      }),
    };
  }

  const apply = cryptoConfigApplier(config);
  if (!apply) {
    return {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 503,
        title: 'Not available',
        message: 'Crypto configuration changes are not available on this deployment.',
      }),
    };
  }
  const tenantId = (request.body['tenantId'] ?? '').trim();
  if (!tenantId) {
    return {
      status: 422,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 422,
        title: 'Invalid request',
        message: 'A tenant must be selected before changing crypto configuration.',
      }),
    };
  }
  // An unchecked checkbox sends nothing, so an absent field means OFF. That
  // asymmetry is the form's, not ours: a save that silently ignored the
  // toggle would be worse than one that turns it off.
  const deliveryRaw = request.body['deliveryEncryption'];
  const deliveryEncryption = deliveryRaw === 'on' || deliveryRaw === 'true';
  const versionRaw = (request.body['recipientKeyVersion'] ?? '').trim();
  const recipientKeyVersion = versionRaw === '' ? null : Number(versionRaw);
  if (recipientKeyVersion !== null && !Number.isSafeInteger(recipientKeyVersion)) {
    return {
      status: 422,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 422,
        title: 'Invalid request',
        message: 'The recipient key version is not a number.',
      }),
    };
  }
  // POST-redirect-GET: a reloaded save must not re-submit the mutation.
  return {
    status: 302,
    headers: {
      location: '/admin/crypto-config?tenantId=' + encodeURIComponent(tenantId),
      'content-type': 'text/html; charset=utf-8',
    },
    body: '',
    deferredSectionExtras: async () => {
      try {
        const pane = await apply({
          request,
          tenantId,
          storageKeyRef: request.body['storageKeyRef'],
          deliveryEncryption,
          recipientKeyVersion,
        });
        return renderCryptoConfig(pane);
      } catch {
        return renderCryptoConfig({ status: 'error', code: 'CRYPTO_CONFIG_SAVE_FAILED' });
      }
    },
  };
}

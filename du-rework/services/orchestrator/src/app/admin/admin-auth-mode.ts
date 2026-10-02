/**
 * LOCAL-03: the explicit server-side Admin authentication mode
 * (`DU_ADMIN_AUTH_MODE`).
 *
 * Contract (tasks/ADMIN-LOCAL-AUTH-2026-09-30.md §"Contract cấu hình"):
 *  - `local` — username/password against the server-side local user store;
 *    no IdP required, password login is the only human entry point.
 *  - `oidc`  — the IdP flow only; the password login must NOT open.
 *  - `both`  — both identity sources served by the same shell, kept
 *    distinct by session `issuer`+`sub`.
 *  - UNSET   — the pre-LOCAL-03 deployment: the legacy `du_admin`
 *    token plane stays byte-for-byte. Production is expected to set the
 *    mode explicitly; absence is the backward-compat branch, not a
 *    silent fallback.
 *
 * Garbage values refuse the boot (fail closed) — never a silent default.
 * The parser is pure so the boot gate is unit-testable without a process.
 */

export type AdminAuthMode = 'local' | 'oidc' | 'both';

export const ADMIN_AUTH_MODE_ENV = 'DU_ADMIN_AUTH_MODE';

export function parseAdminAuthMode(env: NodeJS.ProcessEnv): AdminAuthMode | undefined {
  const raw = (env[ADMIN_AUTH_MODE_ENV] ?? '').trim().toLowerCase();
  if (raw.length === 0) return undefined;
  if (raw === 'local' || raw === 'oidc' || raw === 'both') return raw;
  throw new Error(
    ADMIN_AUTH_MODE_ENV + " must be 'local', 'oidc' or 'both', got '" + raw + "'",
  );
}

/** True when the mode serves the local username/password login. */
export function modeAllowsLocal(mode: AdminAuthMode | undefined): boolean {
  return mode === 'local' || mode === 'both';
}

/** True when the mode serves the OIDC login/callback flow. */
export function modeAllowsOidc(mode: AdminAuthMode | undefined): boolean {
  return mode === 'oidc' || mode === 'both';
}

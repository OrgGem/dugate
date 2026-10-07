/** Shared BFF types (kept separate to avoid import cycles). */

export type ScopedPrincipal = { kind: 'platform' } | { kind: 'tenant_operator'; tenantId: string };

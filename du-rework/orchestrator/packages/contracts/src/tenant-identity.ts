/**
 * Canonical textual UUID syntax for tenant identifiers.
 *
 * PostgreSQL accepts every 8-4-4-4-12 hexadecimal UUID shape, including
 * legacy zero/version sentinel values. Tenant identity validation must keep
 * that wire syntax aligned without assuming an RFC version or variant.
 */
const TENANT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && TENANT_UUID_PATTERN.test(value);
}

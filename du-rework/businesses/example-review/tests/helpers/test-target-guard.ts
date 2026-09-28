/**
 * Test Target Guard for Example-Review Integration Tests
 *
 * Enforces strict fail-closed test target verification before executing live tests:
 * - Refuses non-test database names (must contain 'test')
 * - Prohibits non-test ports (must be 5433 for Postgres, 6380 for Redis)
 * - Prohibits remote/non-loopback hosts
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertTestDatabase(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`[Security Target Guard] Non-loopback database host forbidden: ${url.hostname}`);
  }
  const port = parseInt(url.port, 10);
  if (port !== 5433) {
    throw new Error(`[Security Target Guard] Database port must be 5433, got: ${port}`);
  }
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(`[Security Target Guard] Database name must contain 'test', got: ${dbName}`);
  }
}

export function assertTestRedis(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`[Security Target Guard] Non-loopback Redis host forbidden: ${url.hostname}`);
  }
  const port = parseInt(url.port, 10);
  if (port !== 6380) {
    throw new Error(`[Security Target Guard] Redis port must be 6380, got: ${port}`);
  }
}

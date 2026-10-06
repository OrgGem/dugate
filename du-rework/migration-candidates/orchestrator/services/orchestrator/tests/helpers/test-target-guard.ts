/**
 * Test Environment Target Guard (Wave 15 / Wave 16)
 *
 * Enforces fail-closed target verification BEFORE connections, migrations, or writes.
 * Validates parsed URL, loopback host policy, dedicated test ports, and strict test database naming.
 * Prohibits remote hosts, prod databases/ports (such as Redis 6379), ambiguous paths, and query target overrides.
 * Strictly sanitizes URLs before error reporting (never echoes passwords, query parameter values, or fragments).
 */

export interface ValidatedDatabaseTarget {
  host: string;
  port: number;
  database: string;
  sanitizedUrl: string;
}

export interface ValidatedRedisTarget {
  host: string;
  port: number;
  dbIndex: number;
  sanitizedUrl: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Dedicated allowed Redis test port (default 6380 for local test service)
const ALLOWED_TEST_REDIS_PORTS = new Set([
  6380,
  ...(process.env.TEST_REDIS_PORT ? [parseInt(process.env.TEST_REDIS_PORT, 10)] : []),
]);

const FORBIDDEN_PG_QUERY_OVERRIDES = new Set(['host', 'hostname', 'database', 'dbname', 'port']);

/**
 * Sanitizes URLs for safe error reporting:
 * - Masks username and password as '***'
 * - Masks all query parameter values as '***'
 * - Masks fragment as '#***'
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';

    // Mask all query parameter values so secrets and tokens are never echoed in logs/errors
    for (const key of Array.from(u.searchParams.keys())) {
      u.searchParams.set(key, '***');
    }

    if (u.hash) {
      u.hash = '#***';
    }

    return u.toString();
  } catch {
    return '[malformed-url]';
  }
}

/**
 * Validates that DATABASE_URL points strictly to a local dedicated test database.
 * Throws a descriptive error with sanitized URL on violation.
 */
export function validateTestDatabaseTarget(databaseUrl: string | undefined): ValidatedDatabaseTarget {
  if (!databaseUrl || typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('Test environment guard rejected: DATABASE_URL is missing or empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      `Test environment guard rejected: DATABASE_URL is malformed: "${sanitizeUrl(databaseUrl)}"`
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `Test environment guard rejected: unsupported database protocol "${parsed.protocol}" in "${sanitizeUrl(
        databaseUrl
      )}". Expected postgresql: or postgres:`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Test environment guard rejected: database host "${hostname}" in "${sanitizeUrl(
        databaseUrl
      )}" is not an authorized loopback test host. Remote databases are prohibited in test suites.`
    );
  }

  // Reject URL-encoded characters in pathname to prevent path traversal / ambiguity tricks
  if (/%[0-9a-fA-F]{2}/.test(parsed.pathname)) {
    throw new Error(
      `Test environment guard rejected: URL-encoded characters in pathname "${parsed.pathname}" are prohibited in "${sanitizeUrl(
        databaseUrl
      )}".`
    );
  }

  const rawPath = parsed.pathname.replace(/^\/+/, '');
  if (!rawPath) {
    throw new Error(
      `Test environment guard rejected: database name is missing in "${sanitizeUrl(databaseUrl)}".`
    );
  }

  // Disallow ambiguous multi-segment paths (e.g. /du_test/nested/segment)
  if (rawPath.includes('/')) {
    throw new Error(
      `Test environment guard rejected: ambiguous multi-segment database path "${parsed.pathname}" in "${sanitizeUrl(
        databaseUrl
      )}". Expected single database name.`
    );
  }

  const dbName = rawPath;

  // Exact allowed test database check: database name must end with '_test' or be in whitelist
  const isAllowedTestDb =
    dbName === 'du_orchestrator_test' || dbName === 'du_test' || dbName.endsWith('_test');
  if (!isAllowedTestDb) {
    throw new Error(
      `Test environment guard rejected: database "${dbName}" in "${sanitizeUrl(
        databaseUrl
      )}" is not an authorized test database. Database name must end with "_test" (e.g. "du_orchestrator_test"). Port alone or substring in credentials/host does not authorize execution.`
    );
  }

  // Reject query parameters that could override driver target host, dbname, or port
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (FORBIDDEN_PG_QUERY_OVERRIDES.has(key.toLowerCase())) {
      throw new Error(
        `Test environment guard rejected: query parameter target override "${key}" in "${sanitizeUrl(
          databaseUrl
        )}" is prohibited in test connection strings.`
      );
    }
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Test environment guard rejected: invalid port "${parsed.port}" in "${sanitizeUrl(databaseUrl)}"`
    );
  }

  return {
    host: hostname,
    port,
    database: dbName,
    sanitizedUrl: sanitizeUrl(databaseUrl),
  };
}

/**
 * Validates that REDIS_URL points strictly to an authorized local test Redis service.
 * Enforces dedicated test port 6380 (rejects standard production port 6379).
 */
export function validateTestRedisTarget(redisUrl: string | undefined): ValidatedRedisTarget {
  if (!redisUrl || typeof redisUrl !== 'string' || redisUrl.trim() === '') {
    throw new Error('Test environment guard rejected: REDIS_URL is missing or empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error(
      `Test environment guard rejected: REDIS_URL is malformed: "${sanitizeUrl(redisUrl)}"`
    );
  }

  if (parsed.protocol !== 'redis:') {
    throw new Error(
      `Test environment guard rejected: unsupported Redis protocol "${parsed.protocol}" in "${sanitizeUrl(
        redisUrl
      )}". Expected redis:`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Test environment guard rejected: Redis host "${hostname}" in "${sanitizeUrl(
        redisUrl
      )}" is not an authorized loopback test host. Remote Redis is prohibited in test suites.`
    );
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : 6379;

  // Explicitly reject standard production Redis port 6379
  if (port === 6379) {
    throw new Error(
      `Test environment guard rejected: Redis port 6379 in "${sanitizeUrl(
        redisUrl
      )}" is the default production Redis port and is prohibited in test suites. Dedicated test Redis must run on port 6380.`
    );
  }

  if (!ALLOWED_TEST_REDIS_PORTS.has(port)) {
    throw new Error(
      `Test environment guard rejected: Redis port "${port}" in "${sanitizeUrl(
        redisUrl
      )}" is not an authorized test port. Expected dedicated test Redis on port 6380.`
    );
  }

  // Validate optional database index if specified in pathname
  let dbIndex = 0;
  const rawPath = parsed.pathname.replace(/^\/+/, '');
  if (rawPath) {
    if (rawPath.includes('/')) {
      throw new Error(
        `Test environment guard rejected: ambiguous multi-segment Redis path "${parsed.pathname}" in "${sanitizeUrl(
          redisUrl
        )}".`
      );
    }
    dbIndex = parseInt(rawPath, 10);
    if (isNaN(dbIndex) || dbIndex < 0 || dbIndex > 15) {
      throw new Error(
        `Test environment guard rejected: invalid Redis database index "${rawPath}" in "${sanitizeUrl(
          redisUrl
        )}". Expected integer between 0 and 15.`
      );
    }
  }

  return {
    host: hostname,
    port,
    dbIndex,
    sanitizedUrl: sanitizeUrl(redisUrl),
  };
}

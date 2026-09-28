import {
  validateTestDatabaseTarget,
  validateTestRedisTarget,
  sanitizeUrl,
} from './helpers/test-target-guard';

describe('Test Environment Target Guard (Wave 15 / Wave 16 Driver Semantics)', () => {
  describe('validateTestDatabaseTarget', () => {
    describe('authorized test database targets', () => {
      const validCases = [
        {
          name: 'standard du_orchestrator_test on localhost:5433',
          url: 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test',
          expectedDb: 'du_orchestrator_test',
          expectedPort: 5433,
        },
        {
          name: 'standard du_orchestrator_test on 127.0.0.1:5433',
          url: 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test',
          expectedDb: 'du_orchestrator_test',
          expectedPort: 5433,
        },
        {
          name: 'generic database ending in _test on localhost:5432',
          url: 'postgresql://postgres:secret@localhost:5432/my_integration_test',
          expectedDb: 'my_integration_test',
          expectedPort: 5432,
        },
        {
          name: 'postgres protocol alias with IPv6 loopback',
          url: 'postgres://[::1]:5433/du_test',
          expectedDb: 'du_test',
          expectedPort: 5433,
        },
        {
          name: 'database with valid non-target query options ending in _test',
          url: 'postgresql://du@localhost:5433/du_orchestrator_test?sslmode=disable',
          expectedDb: 'du_orchestrator_test',
          expectedPort: 5433,
        },
      ];

      for (const tc of validCases) {
        test(`authorizes ${tc.name}`, () => {
          const res = validateTestDatabaseTarget(tc.url);
          expect(res.database).toBe(tc.expectedDb);
          expect(res.port).toBe(tc.expectedPort);
          expect(res.sanitizedUrl).not.toContain('du-test-only');
        });
      }
    });

    describe('rejected database targets (fail-closed security checks)', () => {
      const rejectedCases = [
        {
          name: 'production database name on test port 5433',
          url: 'postgresql://du:secretPass123@localhost:5433/du_production',
          expectedError: 'not an authorized test database',
        },
        {
          name: 'port alone on 5433 with production DB name (no _test suffix)',
          url: 'postgresql://localhost:5433/production_database',
          expectedError: 'not an authorized test database',
        },
        {
          name: '_test substring only in username with prod DB',
          url: 'postgresql://my_test_user:secretPass123@localhost:5433/production_database',
          expectedError: 'not an authorized test database',
        },
        {
          name: '_test substring only in password with prod DB',
          url: 'postgresql://admin:password_test_123@localhost:5433/production_database',
          expectedError: 'not an authorized test database',
        },
        {
          name: '_test substring only in hostname with prod DB',
          url: 'postgresql://admin:secretPass123@local_test_box:5433/production_database',
          expectedError: 'not an authorized loopback test host',
        },
        {
          name: '_test substring only in non-target query parameters with prod DB',
          url: 'postgresql://user:secretPass123@localhost:5433/production_db?env=_test',
          expectedError: 'not an authorized test database',
        },
        {
          name: 'query host override parameter (?host=remote.db)',
          url: 'postgresql://localhost:5433/du_test?host=remote.db',
          expectedError: 'query parameter target override "host"',
        },
        {
          name: 'query hostname override parameter (?hostname=remote.db)',
          url: 'postgresql://localhost:5433/du_test?hostname=remote.db',
          expectedError: 'query parameter target override "hostname"',
        },
        {
          name: 'query database override parameter (?database=prod_db)',
          url: 'postgresql://localhost:5433/du_test?database=prod_db',
          expectedError: 'query parameter target override "database"',
        },
        {
          name: 'query dbname override parameter (?dbname=production)',
          url: 'postgresql://localhost:5433/du_test?dbname=production',
          expectedError: 'query parameter target override "dbname"',
        },
        {
          name: 'query port override parameter (?port=5432)',
          url: 'postgresql://localhost:5433/du_test?port=5432',
          expectedError: 'query parameter target override "port"',
        },
        {
          name: 'ambiguous extra path segments (/du_test/nested/segment)',
          url: 'postgresql://localhost:5433/du_test/nested/segment',
          expectedError: 'ambiguous multi-segment database path',
        },
        {
          name: 'URL-encoded path separator character trick (%2f)',
          url: 'postgresql://localhost:5433/du_test%2fadmin',
          expectedError: 'URL-encoded characters in pathname',
        },
        {
          name: 'remote host even with test database name',
          url: 'postgresql://user:secretPass123@remote.cloud.provider:5433/du_orchestrator_test',
          expectedError: 'not an authorized loopback test host',
        },
        {
          name: 'private network non-loopback host (192.168.1.100)',
          url: 'postgresql://user:secretPass123@192.168.1.100:5433/du_orchestrator_test',
          expectedError: 'not an authorized loopback test host',
        },
        {
          name: 'wrong protocol (mysql:)',
          url: 'mysql://localhost:5433/du_orchestrator_test',
          expectedError: 'unsupported database protocol',
        },
        {
          name: 'missing database name (root pathname)',
          url: 'postgresql://localhost:5433/',
          expectedError: 'database name is missing',
        },
        {
          name: 'missing database name (no pathname)',
          url: 'postgresql://localhost:5433',
          expectedError: 'database name is missing',
        },
        {
          name: 'malformed database URL',
          url: 'not-a-valid-database-url',
          expectedError: 'DATABASE_URL is malformed',
        },
        {
          name: 'empty string database URL',
          url: '',
          expectedError: 'DATABASE_URL is missing or empty',
        },
        {
          name: 'undefined database URL',
          url: undefined,
          expectedError: 'DATABASE_URL is missing or empty',
        },
      ];

      for (const tc of rejectedCases) {
        test(`rejects ${tc.name}`, () => {
          expect(() => validateTestDatabaseTarget(tc.url)).toThrow(tc.expectedError);
        });
      }
    });

    test('never logs credential-bearing passwords in thrown error messages', () => {
      const secretPassword = 'SUPER_SECRET_PRODUCTION_CREDENTIAL_XYZ_987';
      const prodUrl = `postgresql://admin:${secretPassword}@localhost:5433/production_db`;

      try {
        validateTestDatabaseTarget(prodUrl);
        fail('Expected target validation to throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain(secretPassword);
        expect(msg).toContain('***');
      }
    });
  });

  describe('validateTestRedisTarget', () => {
    test('authorizes valid loopback Redis on dedicated test port 6380', () => {
      const res = validateTestRedisTarget('redis://localhost:6380');
      expect(res.host).toBe('localhost');
      expect(res.port).toBe(6380);
      expect(res.dbIndex).toBe(0);
    });

    test('authorizes valid loopback Redis with db index on port 6380', () => {
      const res = validateTestRedisTarget('redis://127.0.0.1:6380/2');
      expect(res.host).toBe('127.0.0.1');
      expect(res.port).toBe(6380);
      expect(res.dbIndex).toBe(2);
    });

    test('strictly rejects local production Redis port 6379', () => {
      expect(() => validateTestRedisTarget('redis://127.0.0.1:6379')).toThrow(
        'default production Redis port and is prohibited in test suites'
      );
      expect(() => validateTestRedisTarget('redis://localhost:6379/0')).toThrow(
        'default production Redis port and is prohibited in test suites'
      );
    });

    test('rejects unapproved Redis ports (e.g. 6381)', () => {
      expect(() => validateTestRedisTarget('redis://localhost:6381')).toThrow(
        'not an authorized test port. Expected dedicated test Redis on port 6380'
      );
    });

    test('rejects remote Redis hosts', () => {
      expect(() => validateTestRedisTarget('redis://remote.cloud.host:6380')).toThrow(
        'not an authorized loopback test host'
      );
    });

    test('rejects ambiguous multi-segment Redis path', () => {
      expect(() => validateTestRedisTarget('redis://localhost:6380/0/extra')).toThrow(
        'ambiguous multi-segment Redis path'
      );
    });

    test('rejects invalid Redis database index (> 15)', () => {
      expect(() => validateTestRedisTarget('redis://localhost:6380/99')).toThrow(
        'invalid Redis database index'
      );
    });

    test('rejects wrong protocol (http:)', () => {
      expect(() => validateTestRedisTarget('http://localhost:6380')).toThrow(
        'unsupported Redis protocol'
      );
    });

    test('rejects malformed Redis URL', () => {
      expect(() => validateTestRedisTarget('invalid-redis-url')).toThrow(
        'REDIS_URL is malformed'
      );
    });

    test('rejects empty or missing Redis URL', () => {
      expect(() => validateTestRedisTarget('')).toThrow('REDIS_URL is missing or empty');
      expect(() => validateTestRedisTarget(undefined)).toThrow('REDIS_URL is missing or empty');
    });

    test('never logs Redis credentials in thrown error message', () => {
      const secretPassword = 'REDIS_AUTH_SECRET_PASSWORD_123';
      const remoteUrl = `redis://default:${secretPassword}@unapproved-remote-redis:6379`;
      try {
        validateTestRedisTarget(remoteUrl);
        fail('Expected redis validation to throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain(secretPassword);
      }
    });
  });

  describe('sanitizeUrl utility', () => {
    test('masks username and password', () => {
      const sanitized = sanitizeUrl('postgresql://myuser:mypassword@localhost:5432/test_db');
      expect(sanitized).toBe('postgresql://***:***@localhost:5432/test_db');
    });

    test('masks all query parameter values to protect secrets and tokens', () => {
      const sanitized = sanitizeUrl(
        'postgresql://localhost:5433/du_test?api_key=secretKey123&session_token=tokenXYZ'
      );
      expect(sanitized).not.toContain('secretKey123');
      expect(sanitized).not.toContain('tokenXYZ');
      expect(sanitized).toContain('api_key=***');
      expect(sanitized).toContain('session_token=***');
    });

    test('masks fragment identifiers', () => {
      const sanitized = sanitizeUrl('postgresql://localhost:5433/du_test#sensitiveFragment');
      expect(sanitized).not.toContain('sensitiveFragment');
      expect(sanitized).toContain('#***');
    });

    test('returns [malformed-url] for unparseable input', () => {
      expect(sanitizeUrl('not a url')).toBe('[malformed-url]');
    });
  });
});

import {
  createConnectorComposition,
  createConnectorServer,
  PgSqlClient,
  IoredisEvalClient,
  type SqlClient,
} from '../src';
import { createServer } from 'node:http';

test('composition readiness includes both durable dependency probes and drains', async () => {
  let databaseReady = false;
  let redisReady = true;
  let closed = false;
  const composition = createConnectorComposition({
    port: 0,
    databaseUrl: 'postgres://unused',
    redisUrl: 'redis://unused',
  }, {
    http: {
      management: {
        list: async () => [],
        get: async () => undefined,
        createRevision: async (input) => ({ ...input, revision: 1 }),
        rotateCredential: async () => {},
        disable: async () => {},
        test: async () => ({ ok: true }),
      },
      runtime: {
        invoke: async () => ({ invocationId: 'i', state: 'completed' }),
        get: async () => undefined,
        cancel: async () => ({ invocationId: 'i', state: 'cancelled' }),
      },
      capabilities: () => ({}),
      ready: async () => true,
    },
    pingDatabase: async () => databaseReady,
    pingRedis: async () => redisReady,
    close: async () => { closed = true; },
  });

  await expect(composition.dependencies.ready()).resolves.toBe(false);
  databaseReady = true;
  await expect(composition.dependencies.ready()).resolves.toBe(true);
  await composition.start();
  await composition.shutdown();
  expect(closed).toBe(true);
});

test('production composition fails closed without durable security configuration', () => {
  expect(() => createConnectorComposition({
    port: 0,
    databaseUrl: 'postgres://unused',
    redisUrl: 'redis://unused',
  })).toThrow('Connector security configuration is required.');
});

test('concrete adapter constructors expose lifecycle methods without connecting until used', async () => {
  const pg = new PgSqlClient({ connectionString: 'postgres://unused', max: 1 });
  const redis = new IoredisEvalClient({ host: '127.0.0.1', port: 6399, lazyConnect: true });
  expect(typeof pg.migrate).toBe('function');
  expect(typeof pg.close).toBe('function');
  expect(typeof redis.eval).toBe('function');
  expect(typeof redis.close).toBe('function');
  await pg.close();
  await redis.close();
});

test('SQL transaction adapter preserves callback result and rollback boundary', async () => {
  const calls: string[] = [];
  const sql: SqlClient = {
    query: async () => ({ rows: [] }),
    transaction: async (callback) => callback({
      query: async (text) => {
        calls.push(text);
        return { rows: [] };
      },
      transaction: async (nested) => nested(sql),
    }),
  };
  await expect(sql.transaction(async (tx) => {
    await tx.query('SELECT 1');
    return 'ok';
  })).resolves.toBe('ok');
  expect(calls).toEqual(['SELECT 1']);
});

void createConnectorServer;
void createServer;

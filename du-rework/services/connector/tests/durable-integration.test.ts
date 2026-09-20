import { PgSqlClient, IoredisEvalClient, RedisQuotaStore } from '../src';

if (process.env.CONNECTOR_INTEGRATION !== '1') {
  test.skip('Connector durable integration requires CONNECTOR_INTEGRATION=1', () => {});
} else {
describe('Connector durable integration at Claude compose ports', () => {
  const databaseUrl = process.env.CONNECTOR_DATABASE_URL ?? 'postgres://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
  const redisUrl = process.env.CONNECTOR_REDIS_URL ?? 'redis://127.0.0.1:6380';
  const database = new PgSqlClient({ connectionString: databaseUrl });
  const redis = new IoredisEvalClient({ host: '127.0.0.1', port: 6380 });

  afterAll(async () => {
    await database.close();
    await redis.close();
  });

  test('migrates empty database and recognizes applied version', async () => {
    await database.migrate();
    await database.migrate();
    await expect(database.ping()).resolves.toBe(true);
  });

  test('two connector quota instances share Redis in-flight cap', async () => {
    const first = new RedisQuotaStore(redis, 'connector:integration:');
    const second = new RedisQuotaStore(redis, 'connector:integration:');
    const lease = await first.acquire('provider:model', Date.now(), 10_000, 1);
    expect(lease).toBeDefined();
    await expect(second.acquire('provider:model', Date.now(), 10_000, 1)).resolves.toBeUndefined();
    await first.release(lease!);
  });
});
}

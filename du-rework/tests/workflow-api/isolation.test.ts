import {
  createWorkflowApiIsolation,
  syntheticMetadataKeyProvider,
} from './isolation';
import { adaptKeyProviderForMetadata } from '../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import {
  createMetadataCrypto,
  type MetadataContext,
} from '../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';

describe('WFA isolated integration harness', () => {
  test('allocates its own loopback PostgreSQL schema and Redis database', () => {
    const isolated = createWorkflowApiIsolation();
    expect(new URL(isolated.databaseUrl).hostname).toBe('127.0.0.1');
    expect(new URL(isolated.databaseUrl).searchParams.get('options')).toContain(
      isolated.context.dbSchema,
    );
    expect(isolated.context.dbSchema).toMatch(/^du_test_wfa_/);
    expect(new URL(isolated.redisUrl).hostname).toBe('127.0.0.1');
    expect(Number(new URL(isolated.redisUrl).pathname.slice(1))).toBeGreaterThan(0);
    expect(isolated.context.redisPrefix).toContain(isolated.context.runId);
  });

  test('uses the production metadata cipher with a synthetic, offline key wrapper', async () => {
    const crypto = createMetadataCrypto(
      adaptKeyProviderForMetadata(syntheticMetadataKeyProvider()),
      'du-orch-metadata-v1',
    );
    const context: MetadataContext = {
      tenantId: '00000000-0000-4000-a000-000000000001',
      slot: 'operations.input_ref',
      refId: 'wfa-synthetic-operation',
    };
    const value = { input: { reference: 'synthetic-only' } };
    const sealed = await crypto.seal(value, context);

    expect(crypto.isSealed(sealed)).toBe(true);
    expect(await crypto.open(sealed, context)).toEqual(value);
    await expect(
      crypto.open(sealed, { ...context, tenantId: '00000000-0000-4000-a000-000000000002' }),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });
});

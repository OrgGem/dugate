import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  assertSafeIsolationConfig,
  createTestIsolationContext,
  type TestIsolationContext,
} from '../isolation/namespace';

const DEFAULT_DATABASE_URL = 'postgresql://du_wfa:du_wfa_test_only@127.0.0.1:55498/du_workflow_api_test';
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:56398/2';

export interface WorkflowApiIsolation {
  readonly id: string;
  readonly baseDatabaseUrl: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly context: TestIsolationContext;
}

function loopbackUrl(raw: string, expectedProtocol: 'postgresql:' | 'redis:'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`WFA isolation URL is invalid for ${expectedProtocol}`);
  }
  if (url.protocol !== expectedProtocol || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`WFA test infrastructure must use loopback ${expectedProtocol} URLs`);
  }
  if (url.port === '') throw new Error(`WFA test infrastructure URL must specify a dedicated host port`);
  return url;
}

export function createWorkflowApiIsolation(): WorkflowApiIsolation {
  const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const baseRedisUrl = process.env.WFA_REDIS_URL ?? DEFAULT_REDIS_URL;
  const databaseUrl = loopbackUrl(baseDatabaseUrl, 'postgresql:');
  const redisUrl = loopbackUrl(baseRedisUrl, 'redis:');
  const runId = `wfa_${Date.now()}_${randomBytes(5).toString('hex')}`;
  const context = createTestIsolationContext({
    runId,
    baseArtifactPath: 'tests/workflow-api/.scratch/artifacts',
  });
  const scopedDatabaseUrl = context.getDatabaseUrlWithSchema(databaseUrl.toString());
  const scopedRedis = new URL(context.getRedisUrl(redisUrl.toString()));
  scopedRedis.pathname = `/${context.redisDbIndex}`;
  const scopedRedisUrl = scopedRedis.toString();

  assertSafeIsolationConfig({
    databaseUrl: scopedDatabaseUrl,
    redisUrl: scopedRedisUrl,
    isolationCtx: context,
  });

  return {
    id: runId,
    baseDatabaseUrl: databaseUrl.toString(),
    databaseUrl: scopedDatabaseUrl,
    redisUrl: scopedRedisUrl,
    context,
  };
}

/** Synthetic test-only key wrapper; production and legacy key providers are never used. */
export function syntheticMetadataKeyProvider() {
  const rootKey = createHash('sha256')
    .update('du-rework WFA synthetic metadata key provider v1', 'utf8')
    .digest();

  return {
    async wrapDek(input: { keyRef: string; dek: Uint8Array; keyVersion?: number }) {
      const keyVersion = input.keyVersion ?? 1;
      const key = createHash('sha256')
        .update(rootKey)
        .update(input.keyRef, 'utf8')
        .update(String(keyVersion), 'utf8')
        .digest();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.dek)), cipher.final()]);
      const serialized = JSON.stringify({
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      });
      return { keyRef: input.keyRef, keyVersion, ciphertext: `wfa:${Buffer.from(serialized).toString('base64')}` };
    },
    async unwrapDek(wrapped: { keyRef: string; keyVersion: number; ciphertext: string }) {
      if (!wrapped.ciphertext.startsWith('wfa:')) throw new Error('unsupported WFA wrapped key format');
      const value = JSON.parse(Buffer.from(wrapped.ciphertext.slice(4), 'base64').toString('utf8')) as {
        nonce: string;
        tag: string;
        ciphertext: string;
      };
      const key = createHash('sha256')
        .update(rootKey)
        .update(wrapped.keyRef, 'utf8')
        .update(String(wrapped.keyVersion), 'utf8')
        .digest();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(value.nonce, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64')),
        decipher.final(),
      ]);
    },
    async rewrap(wrapped: { keyRef: string; keyVersion: number; ciphertext: string }, targetKeyVersion?: number) {
      const dek = await this.unwrapDek(wrapped);
      return this.wrapDek({ keyRef: wrapped.keyRef, dek, keyVersion: targetKeyVersion ?? wrapped.keyVersion });
    },
  };
}

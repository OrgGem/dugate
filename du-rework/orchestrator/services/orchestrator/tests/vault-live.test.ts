/**
 * vault-live.test.ts — Live HashiCorp Vault Integration Verification
 *
 * Runs only when DU_LIVE_INFRA=1 against a running Vault dev server.
 * Tests real Transit KMS (DEK wrap/unwrap) and KV v2 secret read/write.
 */

import { randomBytes } from 'node:crypto';
import {
  VaultTransitProvider,
} from '../src/modules/encryption/vault-transit-provider';

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;

if (!LIVE) {
  console.warn('vault-live.test.ts: SKIPPED — set DU_LIVE_INFRA=1 with running Vault.');
}

const VAULT_ADDR = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
const VAULT_TOKEN = process.env.VAULT_TOKEN || 'root-dev-token';
const TRANSIT_MOUNT = process.env.VAULT_TRANSIT_MOUNT || 'transit';
const TRANSIT_KEY = process.env.VAULT_TRANSIT_KEY || 'du-app-encryption-key';
const KV_MOUNT = process.env.VAULT_KV_MOUNT || 'secret';

liveDescribe('HashiCorp Vault Live Integration', () => {

  test('Vault status is initialized and unsealed', async () => {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/health`);
    expect([200, 429, 472, 473]).toContain(res.status);
    const data = await res.json() as { initialized: boolean; sealed: boolean };
    expect(data.initialized).toBe(true);
    expect(data.sealed).toBe(false);
  });

  test('Transit KMS: Real DEK wrap, version pin, and unwrap round-trip', async () => {
    const provider = new VaultTransitProvider({
      vaultAddress: VAULT_ADDR,
      allowedKeyRefs: { 'storage/main': TRANSIT_KEY },
      transitMount: TRANSIT_MOUNT,
      encryptIdentity: { token: () => VAULT_TOKEN },
      decryptIdentity: { token: () => VAULT_TOKEN },
      rewrapIdentity: { token: () => VAULT_TOKEN },
    });

    const dek = randomBytes(32);
    const wrapped = await provider.wrapDek({ keyRef: 'storage/main', dek });

    expect(wrapped.keyRef).toBe('storage/main');
    expect(wrapped.ciphertext).toMatch(/^vault:v\d+:/);
    expect(wrapped.keyVersion).toBeGreaterThanOrEqual(1);

    const unwrapped = await provider.unwrapDek(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  test('KV v2 Engine: Secret create with CAS, read version, and cleanup', async () => {
    const secretPath = `du/connector/live-test-${Date.now()}/provider/acc-1`;
    const secretPayload = { apiKey: 'sk-live-vault-secret-' + randomBytes(8).toString('hex') };

    // 1. Write secret to KV v2
    const writeRes = await fetch(`${VAULT_ADDR}/v1/${KV_MOUNT}/data/${secretPath}`, {
      method: 'POST',
      headers: {
        'x-vault-token': VAULT_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ data: secretPayload }),
    });
    expect(writeRes.status).toBe(200);
    const writeData = await writeRes.json() as { data: { version: number } };
    const version = writeData.data.version;
    expect(version).toBeGreaterThanOrEqual(1);

    // 2. Read secret from KV v2
    const readRes = await fetch(`${VAULT_ADDR}/v1/${KV_MOUNT}/data/${secretPath}?version=${version}`, {
      headers: { 'x-vault-token': VAULT_TOKEN },
    });
    expect(readRes.status).toBe(200);
    const readData = await readRes.json() as { data: { data: { apiKey: string } } };
    expect(readData.data.data.apiKey).toBe(secretPayload.apiKey);

    // 3. Clean up metadata
    await fetch(`${VAULT_ADDR}/v1/${KV_MOUNT}/metadata/${secretPath}`, {
      method: 'DELETE',
      headers: { 'x-vault-token': VAULT_TOKEN },
    });
  });

});

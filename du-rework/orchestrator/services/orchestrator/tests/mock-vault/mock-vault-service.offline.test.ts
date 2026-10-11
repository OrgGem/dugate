/**
 * DU_VAULT_MOCK offline suite - the in-process mock Vault must speak the
 * exact wire dialect the production adapters use, with no live Vault:
 *   - KV v2: seeded read, CAS write, 412 conflict, 404 missing, policy 403;
 *   - Transit: real VaultTransitProvider wrap/unwrap/rewrap round-trips;
 *   - Composition: the production boot (composeCredentialWorkflow +
 *     buildEncryptionBootOptions) wired from the DU_VAULT_MOCK env patch.
 *
 * Every assertion below is offline: loopback only, no DB, no Redis, no
 * external Vault binary.
 */

import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEncryptionBootOptions } from '../../src/modules/encryption/boot-options';
import { VaultTransitProvider } from '../../src/modules/encryption/vault-transit-provider';
import { composeCredentialWorkflow } from '../../src/modules/connector-credentials/compose';
import {
  type ConnectorRevisionStore,
  type PinnedSource,
  type RevisionRow,
} from '../../src/modules/connector-credentials/workflow';
import { loadFixture } from './mock-vault-fixture.cjs';
import { applyMockVaultEnv } from './bootstrap.cjs';
import { startMockVaultService, type MockVaultService } from './mock-vault-service.cjs';

const FIXTURE = join(__dirname, 'mock-vault.json');
const SEEDED_PATH = 'du/tenants/tenant-openai/connectors/openai/accounts/du-conn-openai-main';
const SEEDED_VALUE = 'mock-openai-main-key-not-a-real-secret';
const REF = { account: 'du-conn-openai-main', mount: 'secret', path: SEEDED_PATH, key: 'api-key' };

class MemStore implements ConnectorRevisionStore {
  readonly rows: RevisionRow[] = [];

  constructor() {
    this.rows.push({
      revision: 1,
      adapter: 'openai-http',
      state: 'ACTIVE',
      credentialSource: { kind: 'legacy-db', credentialRef: 'legacy-openai-main' },
      tenantId: 'tenant-openai',
      accountId: 'du-conn-openai-main',
    });
  }

  async get(): Promise<RevisionRow | undefined> {
    return [...this.rows].reverse().find((row) => row.state === 'ACTIVE');
  }

  async createPending(_connectorId: string, source: PinnedSource): Promise<RevisionRow> {
    const head = this.rows[this.rows.length - 1]!;
    const row: RevisionRow = {
      revision: head.revision + 1,
      adapter: head.adapter,
      state: 'PENDING',
      credentialSource: source,
      ...(head.tenantId === undefined ? {} : { tenantId: head.tenantId }),
      ...(head.accountId === undefined ? {} : { accountId: head.accountId }),
    };
    this.rows.push(row);
    return row;
  }

  async activate(_connectorId: string, revision: number, expectedCurrent: number): Promise<boolean> {
    const current = await this.get();
    if (!current || current.revision !== expectedCurrent) return false;
    const target = this.rows.find((row) => row.revision === revision);
    if (!target || target.state !== 'PENDING') return false;
    current.state = 'RETIRED';
    target.state = 'ACTIVE';
    return true;
  }

  async retire(_connectorId: string, revision: number): Promise<void> {
    const target = this.rows.find((row) => row.revision === revision);
    if (target && target.state === 'PENDING') target.state = 'RETIRED';
  }

  async revokeAll(): Promise<void> {
    for (const row of this.rows) row.state = 'RETIRED';
  }
}

interface WireResponse {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function wire(
  service: MockVaultService,
  routePath: string,
  init: { method: string; token?: string; body?: unknown } = { method: 'GET' },
): Promise<WireResponse> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers['x-vault-token'] = init.token;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(service.url + routePath, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json, text };
}

describe('mock-vault fixture is validated fail-closed', () => {
  it('parses the committed mockup', () => {
    const fixture = loadFixture(FIXTURE);
    expect(fixture.kv.mount).toBe('secret');
    expect(fixture.kv.allowedPrefix).toBe('du/tenants');
    expect(fixture.kv.secrets.map((secret) => secret.path)).toContain(SEEDED_PATH);
    expect(fixture.tokens.encrypt).not.toBe(fixture.tokens.decrypt);
    expect(Object.keys(fixture.transit.allowedKeyRefs)).toEqual(['metadata', 'artifacts']);
  });

  it('rejects a malformed mockup instead of half-seeding', () => {
    const bad = join(tmpdir(), 'du-mock-vault-bad-' + randomBytes(6).toString('hex') + '.json');
    writeFileSync(bad, JSON.stringify({ kv: { mount: 'secret' } }));
    try {
      expect(() => loadFixture(bad)).toThrow(/invalid mock vault fixture/);
    } finally {
      rmSync(bad, { force: true });
    }
  });

  it('rejects an unreadable mockup path', () => {
    const absent = join(tmpdir(), 'du-mock-vault-absent-' + randomBytes(6).toString('hex') + '.json');
    expect(() => loadFixture(absent)).toThrow(/invalid mock vault fixture/);
  });
});

describe('mock-vault service speaks KV v2 on the wire', () => {
  let service: MockVaultService;

  beforeAll(async () => {
    service = await startMockVaultService({ fixturePath: FIXTURE, port: 42010 });
  });

  afterAll(async () => {
    await service.stop();
  });

  it('reads the seeded secret at its pinned version', async () => {
    const res = await wire(service, '/v1/secret/data/' + SEEDED_PATH, { method: 'GET', token: service.tokens.kv });
    expect(res.status).toBe(200);
    const body = res.json['data'] as { data: Record<string, unknown>; metadata: { version: number } };
    expect(body.data['api-key']).toBe(SEEDED_VALUE);
    expect(body.metadata.version).toBe(1);
  });

  it('metadata endpoint lists versions WITHOUT values', async () => {
    const res = await wire(service, '/v1/secret/metadata/' + SEEDED_PATH, { method: 'GET', token: service.tokens.kv });
    expect(res.status).toBe(200);
    expect((res.json['data'] as { current_version: number }).current_version).toBe(1);
    expect(res.json['data']).not.toHaveProperty('data');
    expect(res.text).not.toContain(SEEDED_VALUE);
  });

  it('CAS write bumps the version and merges the payload', async () => {
    const written = await wire(service, '/v1/secret/data/' + SEEDED_PATH, {
      method: 'POST',
      token: service.tokens.kv,
      body: { data: { 'api-key': 'mock-rotated-value' }, options: { cas: 1 } },
    });
    expect(written.status).toBe(200);
    expect((written.json['data'] as { version: number }).version).toBe(2);
    expect(service.versionsOf(SEEDED_PATH)).toEqual([1, 2]);
    expect(service.readValue(SEEDED_PATH, 'api-key')?.value).toBe('mock-rotated-value');
  });

  it('stale CAS is refused with 412 and creates no version', async () => {
    const res = await wire(service, '/v1/secret/data/' + SEEDED_PATH, {
      method: 'POST',
      token: service.tokens.kv,
      body: { data: { 'api-key': 'mock-conflict' }, options: { cas: 1 } },
    });
    expect(res.status).toBe(412);
    expect(service.versionsOf(SEEDED_PATH)).toEqual([1, 2]);
    expect(service.readValue(SEEDED_PATH, 'api-key')?.value).toBe('mock-rotated-value');
  });

  it('unknown path answers 404 and an unknown mount answers 404', async () => {
    const missing = await wire(service, '/v1/secret/data/du/tenants/tenant-openai/connectors/openai/accounts/nope', {
      method: 'GET',
      token: service.tokens.kv,
    });
    expect(missing.status).toBe(404);
    const wrongMount = await wire(service, '/v1/kv/data/' + SEEDED_PATH, { method: 'GET', token: service.tokens.kv });
    expect(wrongMount.status).toBe(404);
  });

  it('a foreign path prefix is a real 403 on the wire', async () => {
    const res = await wire(service, '/v1/secret/data/du/shared/connectors/openai/accounts/x', {
      method: 'GET',
      token: service.tokens.kv,
    });
    expect(res.status).toBe(403);
    expect(service.requests().map((entry) => entry.route)).toContain('policy-denied');
  });

  it('a wrong identity is a real 403 on the wire', async () => {
    const res = await wire(service, '/v1/secret/data/' + SEEDED_PATH, { method: 'GET', token: service.tokens.encrypt });
    expect(res.status).toBe(403);
  });

  it('sys/health never reports a live Vault', async () => {
    const res = await wire(service, '/v1/sys/health', { method: 'GET' });
    expect(res.status).toBe(503);
  });

  it('lease revoke makes the identity unusable', async () => {
    const login = await wire(service, '/v1/auth/token/create', { method: 'POST', body: { role: 'kv' } });
    expect(login.status).toBe(200);
    const auth = login.json['auth'] as { lease_id: string };
    const renew = await wire(service, '/v1/sys/leases/renew', { method: 'POST', body: { lease_id: auth.lease_id } });
    expect(renew.status).toBe(200);
    const revoke = await wire(service, '/v1/sys/leases/revoke', { method: 'POST', body: { lease_id: auth.lease_id } });
    expect(revoke.status).toBe(204);
    const afterRevoke = await wire(service, '/v1/secret/data/' + SEEDED_PATH, { method: 'GET', token: service.tokens.kv });
    expect(afterRevoke.status).toBe(403);
    expect(service.counters().revokes).toBe(1);
  });
});

describe('mock-vault service answers the real Transit provider', () => {
  let service: MockVaultService;

  beforeAll(async () => {
    service = await startMockVaultService({ fixturePath: FIXTURE, port: 42020 });
  });

  afterAll(async () => {
    await service.stop();
  });

  function provider(): VaultTransitProvider {
    return new VaultTransitProvider({
      vaultAddress: service.url,
      allowedKeyRefs: service.allowedKeyRefs,
      encryptIdentity: { token: () => service.tokens.encrypt },
      decryptIdentity: { token: () => service.tokens.decrypt },
      transitMount: service.transitMount,
    });
  }

  it('wraps and unwraps a DEK through the production adapter', async () => {
    const dek = randomBytes(32);
    const wrapped = await provider().wrapDek({ keyRef: 'metadata', dek });
    expect(wrapped.ciphertext).toMatch(/^vault:v1:/);
    expect((await provider().unwrapDek(wrapped)).equals(dek)).toBe(true);
  });

  it('honours a pinned key version and rewrap rotates it', async () => {
    const dek = randomBytes(32);
    const pinned = await provider().wrapDek({ keyRef: 'artifacts', dek, keyVersion: 2 });
    expect(pinned.keyVersion).toBe(2);
    const rewrapped = await provider().rewrap(pinned);
    expect(rewrapped.keyVersion).toBeGreaterThanOrEqual(2);
    expect((await provider().unwrapDek(rewrapped)).equals(dek)).toBe(true);
  });

  it('a key ref outside the allowlist never reaches the wire', async () => {
    const before = service.counters().reads;
    await expect(provider().wrapDek({ keyRef: 'unknown-ref', dek: randomBytes(32) })).rejects.toMatchObject({
      code: 'KEY_REF_NOT_ALLOWED',
    });
    expect(service.counters().reads).toBe(before);
  });

  it('decrypt with the encrypt identity is refused', async () => {
    const dek = randomBytes(32);
    const wrapped = await provider().wrapDek({ keyRef: 'metadata', dek });
    const res = await wire(service, '/v1/transit/decrypt/du-metadata', {
      method: 'POST',
      token: service.tokens.encrypt,
      body: { ciphertext: wrapped.ciphertext },
    });
    expect(res.status).toBe(403);
  });

  it('a tampered ciphertext fails closed inside the provider', async () => {
    await expect(provider().unwrapDek({ keyRef: 'metadata', keyVersion: 1, ciphertext: 'vault:v1:AAAA' })).rejects.toMatchObject({
      code: 'VAULT_REJECTED',
    });
  });
});

describe('DU_VAULT_MOCK gate', () => {
  it('starts nothing when the flag is absent or false', async () => {
    await expect(applyMockVaultEnv({})).resolves.toBeUndefined();
    await expect(applyMockVaultEnv({ DU_VAULT_MOCK: 'false' })).resolves.toBeUndefined();
  });

  it('a typo in the flag fails the boot instead of guessing', async () => {
    await expect(applyMockVaultEnv({ DU_VAULT_MOCK: 'yes' })).rejects.toThrow(/DU_VAULT_MOCK must be true or false/);
  });
});

describe('DU_VAULT_MOCK drives the production boot composition', () => {
  let env: Record<string, string | undefined>;
  let service: MockVaultService;

  beforeAll(async () => {
    env = { ...process.env, DU_VAULT_MOCK: 'true' };
    const started = await applyMockVaultEnv(env);
    expect(started).toBeDefined();
    service = started!;
  });

  afterAll(async () => {
    await service.stop();
  });

  it('buildEncryptionBootOptions wires the real Transit blocks to the mock', async () => {
    const boot = buildEncryptionBootOptions({
      ...env,
      ARTIFACT_STORAGE_BACKEND: 'postgres',
      DU_DATA_MODE: 'real',
      DU_ENCRYPTION_METADATA_ENABLED: 'true',
      DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED: 'true',
    });
    expect(boot?.metadataEncryption?.keyRef).toBe('metadata');
    expect(boot?.publicUploadEncryption?.keyRef).toBe('artifacts');
    const keyProvider = boot!.metadataEncryption!.keyProvider;
    const dek = randomBytes(32);
    const wrapped = await keyProvider.wrapDek({ keyRef: 'metadata', dek });
    expect((await keyProvider.unwrapDek(wrapped)).equals(dek)).toBe(true);
  });

  it('composeCredentialWorkflow rotates a credential through the mock and pins the version', async () => {
    const store = new MemStore();
    const workflow = composeCredentialWorkflow({ env, revisions: store });
    expect(workflow).toBeDefined();
    const rotated = await workflow!.rotate({
      connectorId: 'openai',
      ref: REF,
      value: 'mock-rotated-through-workflow',
    });
    expect(rotated).toMatchObject({ revision: 2, state: 'ACTIVE' });
    expect(rotated.version).toBe(2);
    const described = await workflow!.describe('openai');
    expect(described.revision).toBe(2);
    expect(described.vaultVersions).toEqual([1, 2]);
    expect(service.readValue(SEEDED_PATH, 'api-key')?.value).toBe('mock-rotated-through-workflow');
  });

  it('the masked workflow surface never carries the secret value', async () => {
    const workflow = composeCredentialWorkflow({ env, revisions: new MemStore() });
    await workflow!.rotate({ connectorId: 'openai', ref: REF, value: 'mock-rotated-through-workflow' });
    const described = await workflow!.describe('openai');
    expect(JSON.stringify(described)).not.toContain('mock-rotated-through-workflow');
  });
});

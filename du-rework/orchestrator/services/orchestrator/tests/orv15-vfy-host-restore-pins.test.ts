import { createHash } from 'node:crypto';
import { chmod, chown, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import { readTrustedMaintenanceHostIdentity, restoredArtifactManifestObjectKey } from '../src/modules/maintenance/trusted-backup-adapter';
import { verifyNftPolicy } from '../src/modules/maintenance/trusted-isolated-restore-runtime-ports';

const tenantId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const generationA = '33333333-3333-4333-8333-333333333333';
const generationB = '44444444-4444-4444-8444-444444444444';
const uploadToken = '55555555-5555-4555-8555-555555555555';
const storageKey = `${tenantId}/artifacts/${artifactId}`;
const plaintext = Buffer.from('restored artifact pinned to old generation and old transit version');

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
const itOnPosixHost = typeof process.getuid === 'function' ? it : it.skip;
const itWithNativeSymlinks = process.platform === 'win32' ? it.skip : it;

function xor(bytes: Uint8Array, key: Uint8Array): Buffer {
  return Buffer.from(bytes.map((value, index) => value ^ (key[index % key.length] ?? 0)));
}

function pinnedKeyProvider(): KeyProvider {
  const v1 = Buffer.alloc(32, 0x31);
  const v2 = Buffer.alloc(32, 0x72);
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      return { keyRef: input.keyRef, keyVersion: input.keyVersion ?? 1, ciphertext: xor(input.dek, v1).toString('base64') };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const wrappingKey = wrapped.keyVersion === 1 ? v1 : wrapped.keyVersion === 2 ? v2 : undefined;
      if (!wrappingKey) throw new Error('unavailable pinned key version');
      return xor(Buffer.from(wrapped.ciphertext, 'base64'), wrappingKey);
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> { return wrapped; },
  };
}

const sourceRefs = [
  'orchestratorSourceDb', 'connectorSourceDb', 'sourceCatalogKeyring', 'sourceConnectorRecoveryRegistry',
  'sourceMetadataTransit', 'sourceArtifactTransit', 'sourceVault',
] as const;

function nftFixture() {
  const sourceEndpoints = Object.fromEntries(sourceRefs.map((ref, index) => [ref, {
    host: `192.0.2.${40 + index}`, port: index < 2 ? 5432 : 443,
  }])) as Record<(typeof sourceRefs)[number], { host: string; port: number }>;
  const sourceRuleIds = Object.fromEntries(sourceRefs.map((ref) => [ref, `deny-${ref}`]));
  const rules = sourceRefs.map((ref) => ({
    rule: {
      family: 'inet', table: 'du_restore', chain: 'output', comment: sourceRuleIds[ref],
      expr: [
        { match: { op: '==', left: { payload: { protocol: 'ip', field: 'daddr' } }, right: sourceEndpoints[ref].host } },
        { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: sourceEndpoints[ref].port } },
        { match: { op: '==', left: { meta: { key: 'l4proto' } }, right: 'tcp' } },
        { drop: null },
      ],
    },
  }));
  return {
    host: { networkPolicy: { sourceRuleIds }, sourceEndpoints } as Parameters<typeof verifyNftPolicy>[1],
    policy: { nftables: [
      { chain: { family: 'inet', table: 'du_restore', name: 'output', hook: 'output', policy: 'drop' } },
      ...rules,
    ] },
  };
}

async function encryptedArtifactFixture() {
  const crypto = new CryptoStorageFacade(pinnedKeyProvider());
  const sealed = await crypto.encrypt(plaintext, {
    tenantId, artifactId, objectVersion: uploadToken, purpose: 'public-artifact-upload', keyRef: 'artifact-transit/old', keyVersion: 1,
  });
  const ciphertext = Buffer.from(sealed.ciphertext);
  const sidecar = Buffer.from(JSON.stringify({
    version: 1, kind: 'single', artifactId, tenantId, objectVersion: uploadToken,
    ciphertextSizeBytes: ciphertext.byteLength, ciphertextSha256: sha256(ciphertext),
    encryption: {
      version: sealed.version, algorithm: sealed.algorithm, nonce: sealed.nonce, tag: sealed.tag,
      aad: sealed.aad, plaintextSizeBytes: sealed.plaintextSizeBytes, plaintextSha256: sealed.plaintextSha256,
      dek: sealed.dek,
    },
  }));
  const objectVersion = 'old-generation-object-v1';
  const sidecarVersion = 'old-generation-sidecar-v1';
  const row = {
    id: artifactId, tenantId, state: 'READY', purpose: 'input', fileName: 'source-off.txt', mimeType: 'text/plain',
    sizeBytes: ciphertext.byteLength, sha256: sha256(ciphertext), storageBackend: 's3', storageGenerationId: generationA,
    storageKey, storageVersionId: objectVersion, manifestVersionId: sidecarVersion, uploadToken,
  };
  const requested: string[] = [];
  const oldGeneration = {
    async openRead(input: { objectKey: string; versionId: string }): Promise<Readable> {
      requested.push(`${input.objectKey}@${input.versionId}`);
      if (input.objectKey === storageKey && input.versionId === objectVersion) return Readable.from([ciphertext]);
      if (input.objectKey === restoredArtifactManifestObjectKey(storageKey) && input.versionId === sidecarVersion) return Readable.from([sidecar]);
      throw new Error('unexpected generation or object version requested');
    },
  };
  const forGeneration = jest.fn((generationId: string) => {
    if (generationId !== generationA) throw new Error(`artifact reader selected non-pinned generation ${generationId}`);
    return oldGeneration;
  });
  const service = createArtifactService({
    query: jest.fn(async (sql: string) => sql.includes('FROM artifacts') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }),
  } as never, {
    storageBackend: 's3', storageGenerations: { current: async () => ({ generationId: generationB }), forGeneration } as never,
    encryption: { facade: crypto, keyRef: 'artifact-transit/current', keyVersion: 2, required: true },
    maxArtifactBytes: 1024 * 1024,
  });
  return { service, requested, forGeneration, ciphertext, sidecar, objectVersion, sidecarVersion };
}

describe('ORV15 independent trusted restore pins and readers', () => {
  it('accepts only the exact deny policy for each of seven literal source endpoints', () => {
    const fixture = nftFixture();
    expect(() => verifyNftPolicy(fixture.policy, fixture.host)).not.toThrow();

    const changed = structuredClone(fixture.policy) as { nftables: Array<Record<string, unknown>> };
    const firstEntry = changed.nftables[1] as { rule?: { expr: Array<{ match: { right: unknown } }> } } | undefined;
    const firstRule = firstEntry?.rule;
    expect(firstRule).toBeDefined();
    if (firstRule) firstRule.expr[0]!.match.right = '198.51.100.90';
    expect(() => verifyNftPolicy(changed, fixture.host)).toThrow('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  });

  itOnPosixHost('rejects a user-owned manifest at the public root-pinned identity boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orv15-vfy-host-pin-'));
    try {
      const manifest = path.join(root, 'manifest.json');
      const bytes = Buffer.from('{"schemaVersion":1,"hostId":"synthetic-host"}');
      await writeFile(manifest, bytes, { mode: 0o400 });
      await chmod(manifest, 0o400);
      if (process.getuid?.() === 0) await chown(manifest, 1001, 1001);
      const digest = sha256(bytes);
      await expect(readTrustedMaintenanceHostIdentity({ manifestPath: manifest, expectedManifestSha256: digest }))
        .rejects.toThrow('BACKUP_MANIFEST_UNTRUSTED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itWithNativeSymlinks('rejects a symlink at the public root-pinned identity boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orv15-vfy-host-pin-link-'));
    try {
      const manifest = path.join(root, 'manifest.json');
      const bytes = Buffer.from('{"schemaVersion":1,"hostId":"synthetic-host"}');
      await writeFile(manifest, bytes, { mode: 0o400 });
      await chmod(manifest, 0o400);
      const digest = sha256(bytes);
      const link = path.join(root, 'manifest-link.json');
      await symlink(manifest, link);
      await expect(readTrustedMaintenanceHostIdentity({ manifestPath: link, expectedManifestSha256: digest }))
        .rejects.toThrow('BACKUP_MANIFEST_UNTRUSTED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('decrypts a v1 sidecar from its immutable old generation after the active pointer advances to generation B', async () => {
    const state = await encryptedArtifactFixture();
    const result = await state.service.readInvocationArtifacts({ tenantId, artifactIds: [artifactId] });

    expect(Buffer.from(result.contents[0]!.contentBase64, 'base64')).toEqual(plaintext);
    expect(state.forGeneration).toHaveBeenCalledTimes(1);
    expect(state.forGeneration).toHaveBeenCalledWith(generationA);
    expect(state.requested).toEqual(expect.arrayContaining([
      `${storageKey}@${state.objectVersion}`,
      `${restoredArtifactManifestObjectKey(storageKey)}@${state.sidecarVersion}`,
    ]));
    expect(state.requested).toHaveLength(2);
    expect(result.pins[0]).toMatchObject({
      storageGenerationId: generationA, storageVersionId: state.objectVersion,
      integrity: { verified: true, sidecar: { versionId: state.sidecarVersion } },
    });
    expect(state.ciphertext.equals(plaintext)).toBe(false);
    expect(state.sidecar.byteLength).toBeGreaterThan(0);
  });
});

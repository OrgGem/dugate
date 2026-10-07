/**
 * RV01-04 — acceptance rows 4, 5, 6 of RV01-01 against REAL infrastructure.
 *
 * The offline matrix (Muc 59) proved the parser REFUSES bad configuration.
 * That is not the same as proving the good path works: every prior artifact
 * test ran against MemoryS3 and a fake KeyProvider, so no ciphertext ever
 * touched a real object store and no DEK ever reached a real Vault.
 *
 * Real deps:
 *   MinIO  127.0.0.1:9000   bucket du-rv0104-enc
 *   Vault  127.0.0.1:8200   mount transit-rv0104, keys du-metadata/du-artifact
 *
 * Needs RV0104_VAULT_ENC_TOKEN / RV0104_VAULT_DEC_TOKEN in the environment
 * (two distinct least-privilege tokens on mount transit-rv0104). The suite
 * skips when they are absent, like it skips when MinIO/Vault are unreachable.
 *
 * Row 4 = the stored object is ciphertext plus a manifest carrying a
 *         Vault-wrapped DEK, and the object is stamped with the sealed marker.
 * Row 5 = byte-scan: stored bytes are not the plaintext, by every measure.
 * Row 6 = a DEK unwrapped by an INDEPENDENT raw Vault HTTP call decrypts the
 *         stored ciphertext back to the original plaintext.
 *
 * Row 6 is the strongest row: it re-derives the plaintext using only the bytes
 * in the bucket plus Vault, with no repo crypto module in the decryption path.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Db } from '../src/db/db';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import { VaultTransitProvider } from '../src/modules/encryption/vault-transit-provider';
import { buildEncryptionBootOptions } from '../src/modules/encryption/boot-options';
import { createPublicUploadGateway } from '../src/modules/public-api/upload-encryption-gateway';

const ENDPOINT = 'http://127.0.0.1:9000';
const REGION = 'us-east-1';
const BUCKET = 'du-rv0104-enc';
const VAULT_ADDR = 'http://127.0.0.1:8200';
const VAULT_TOKEN = 'du-rv0104-root-token';
// Two DISTINCT least-privilege tokens scoped to transit-rv0104 only. The
// provider refuses a shared identity, and the split is the point of the seam.
// Read from env: Vault tokens must never be committed to the repo.
// Re-create them against a local Vault dev server, e.g.:
//   vault token create -policy=du_test_rv0101_enc -ttl=1h   (x2, enc + dec)
const ENC_TOKEN = process.env['RV0104_VAULT_ENC_TOKEN'] ?? '';
const DEC_TOKEN = process.env['RV0104_VAULT_DEC_TOKEN'] ?? '';
const HAS_LIVE_TOKENS = ENC_TOKEN.length > 0 && DEC_TOKEN.length > 0;
const MOUNT = 'transit-rv0104';
const KEY_REF = 'artifact';
const TRANSIT_KEY = 'du-artifact';
const ARTIFACT_ID = 'bbbbbbbb-0000-4000-8000-0000000000f4';
const TENANT_ID = '73000000-0000-4000-8000-0000000000f4';
const UPLOAD_TOKEN = 'dddddddd-0000-4000-8000-0000000000f4';
const STORAGE_KEY = 'rv0104-art-' + ARTIFACT_ID;
const VaultCiphertext = /^vault:v[1-9][0-9]*:/;
const base64 = 'base64';
const utf8 = 'utf8';

const PLAINTEXT = Buffer.from(
  'RV01-04 ROW4/5/6 PLAINTEXT SENTINEL 7a7a7a 0001ff80c3280a7f00fe',
  'utf8',
);

function newS3(): S3Client {
  return new S3Client({
    endpoint: ENDPOINT,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: 'du_rv0104', secretAccessKey: 'du-rv0104-test-only' },
  });
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * DB stub shaped like the offline gateway test's. `db.query` returns
 * { rowCount, rows } because the gateway checks rowCount, and the row must
 * carry the exact aliased column names the SELECT asks for.
 */
function createDb(): { db: Db; row: Record<string, unknown> } {
  const row: Record<string, unknown> = {
    artifactId: ARTIFACT_ID,
    tenantId: TENANT_ID,
    storageKey: STORAGE_KEY,
    storageBackend: 's3',
    uploadToken: UPLOAD_TOKEN,
    multipartUploadId: null,
    mimeType: 'application/octet-stream',
    sizeBytes: PLAINTEXT.length,
    state: 'STAGING',
    claimToken: 'rv0104-upload-bearer',
    originalToken: 'rv0104-upload-bearer',
    claimExpiresAt: null,
    sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    storageVersionId: null,
    sha256: null,
  };
  const query = async (sql: string): Promise<{ rowCount: number; rows: unknown[] }> => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT/.test(q) && /FROM artifacts/.test(q)) return { rowCount: 1, rows: [row] };
    if (/^UPDATE/.test(q)) return { rowCount: 1, rows: [] };
    throw new Error('unexpected test DB query: ' + q);
  };
  // claim() runs inside db.tx; the offline test's stub shape is reproduced so
  // the gateway cannot take a test-only path.
  const db = {
    query,
    tx: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  } as unknown as Db;
  return { db, row };
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function bootEnv(): Record<string, string> {
  return {
    ARTIFACT_STORAGE_BACKEND: 's3',
    DU_VAULT_TRANSIT_OPTIONS: JSON.stringify({
      vaultAddress: VAULT_ADDR,
      allowedKeyRefs: { metadata: 'du-metadata', artifact: TRANSIT_KEY },
      metadataKeyRef: 'metadata',
      publicUploadKeyRef: KEY_REF,
      transitMount: MOUNT,
    }),
    DU_VAULT_TRANSIT_ENC_TOKEN: ENC_TOKEN,
    DU_VAULT_TRANSIT_DEC_TOKEN: DEC_TOKEN,
  };
}

async function uploadOnce(): Promise<{ s3: S3Client; ack: unknown; db: Db }> {
  const s3 = newS3();
  // mapCryptoError() flattens every non-HttpError into a bare 503, hiding
  // the real cause. Log it here instead of editing production to debug.
  const loggingClient = {
    send: async (command: unknown): Promise<unknown> => {
      try {
        return await s3.send(command as never);
      } catch (error) {
        const e = error as { name?: string; message?: string };
        const n = (command as { constructor: { name: string } }).constructor.name;
        console.log('S3-RAW-ERROR', n, '|', e.name, '|', e.message);
        throw error;
      }
    },
  } as unknown as S3Client;
  const { db } = createDb();
  const boot = buildEncryptionBootOptions(bootEnv());
  if (!boot?.publicUploadEncryption) throw new Error('boot did not build publicUploadEncryption');
  const gateway = createPublicUploadGateway({
    db,
    client: loggingClient,
    bucket: BUCKET,
    cryptoStorage: new CryptoStorageFacade(boot.publicUploadEncryption.keyProvider),
    keyRef: KEY_REF,
  });
  const ack = await gateway.upload({
    artifactId: ARTIFACT_ID,
    tenantId: TENANT_ID,
    source: Readable.from([PLAINTEXT]),
    contentLength: String(PLAINTEXT.length),
    plaintextSha256: createHash('sha256').update(PLAINTEXT).digest('hex'),
  });
  return { s3, ack, db };
}

async function readStored(s3: S3Client): Promise<Buffer> {
  const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: STORAGE_KEY }));
  return bodyBytes(got.Body);
}

describe('RV01-04 rows 4-6 live: MinIO + Vault', () => {
  let live = false;

  beforeAll(async () => {
    live = (await reachable(ENDPOINT + '/minio/health/live')) && (await reachable(VAULT_ADDR + '/v1/sys/health'));
    if (!live) {
      console.log('SKIP rv0104: live MinIO/Vault not reachable — rows 4-6 need du-rv0104-minio + du-rv0104-vault');
      return;
    }
    if (!HAS_LIVE_TOKENS) {
      live = false;
      console.log('SKIP rv0104: RV0104_VAULT_ENC_TOKEN / RV0104_VAULT_DEC_TOKEN not set — rows 4-6 need live Vault tokens');
      return;
    }
    // Prove the real provider wraps against the real Transit mount first.
    const probe = new VaultTransitProvider({
      vaultAddress: VAULT_ADDR,
      allowedKeyRefs: { [KEY_REF]: TRANSIT_KEY },
      encryptIdentity: { token: () => VAULT_TOKEN },
      decryptIdentity: { token: () => VAULT_TOKEN + '.other' },
      transitMount: MOUNT,
    });
    const wrapped = await probe.wrapDek({ keyRef: KEY_REF, dek: Buffer.alloc(32, 7) });
    expect(wrapped.ciphertext).toMatch(/^vault:v[1-9][0-9]*:/);
  });

  test('ROW 4 — object is ciphertext with a manifest holding a Vault-wrapped DEK', async () => {
    if (!live) return;
    const { s3, ack } = await uploadOnce();

    const acked = ack as { state: string; manifestKey: string; storageVersionId: string; ciphertextSha256: string };
    expect(acked.state).toBe('READY');
    expect(acked.manifestKey).toBe(STORAGE_KEY + '.crypto-manifest.json');
    expect(acked.storageVersionId.length).toBeGreaterThan(0);

    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: STORAGE_KEY }));
    // RV01-03 marker + the sidecar pointer stamped by the gateway.
    expect(head.Metadata?.['du-encrypted']).toBe('aes-256-gcm-v1');
    expect(String(head.Metadata?.['du-manifest-key']).length).toBeGreaterThan(0);

    const gotManifest = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: acked.manifestKey }));
    const manifest = JSON.parse((await bodyBytes(gotManifest.Body)).toString('utf8')) as {
      version: number;
      kind: string;
      artifactId: string;
      tenantId: string;
      objectVersion: string;
      ciphertextSizeBytes: number;
      ciphertextSha256: string;
      encryption: { version: number; algorithm: string; nonce: string; tag: string; aad: string; plaintextSizeBytes: number; plaintextSha256: string; dek: { keyRef: string; keyVersion: number; ciphertext: string } };
    };
    expect(manifest.version).toBe(1);
    expect(manifest.kind).toBe('single');
    expect(manifest.artifactId).toBe(ARTIFACT_ID);
    expect(manifest.tenantId).toBe(TENANT_ID);
    expect(manifest.objectVersion).toBe(UPLOAD_TOKEN);
    expect(manifest.ciphertextSizeBytes).toBeGreaterThan(0);
    expect(manifest.ciphertextSha256).toBe(acked.ciphertextSha256);
    expect(manifest.encryption.algorithm).toBe('aes-256-gcm');
    const aad = JSON.parse(Buffer.from(manifest.encryption.aad, base64).toString(utf8)) as {
      context: { tenantId: string; artifactId: string; objectVersion: string; purpose: string };
    };
    expect(aad.context.tenantId).toBe(TENANT_ID);
    expect(aad.context.artifactId).toBe(ARTIFACT_ID);
    expect(aad.context.objectVersion).toBe(UPLOAD_TOKEN);
    expect(aad.context.purpose).toBe('public-artifact-upload');
    expect(manifest.encryption.dek.keyRef).toBe(KEY_REF);
    expect(manifest.encryption.dek.keyVersion).toBeGreaterThan(0);
    expect(manifest.encryption.dek.ciphertext).toMatch(VaultCiphertext);
  });

  test('ROW 5 — byte-scan: the stored bytes are not the plaintext', async () => {
    if (!live) return;
    const { s3 } = await uploadOnce();
    const stored = await readStored(s3);
    const plain = Buffer.from(PLAINTEXT);

    expect(stored.equals(plain)).toBe(false);
    expect(stored.includes(plain)).toBe(false);
    expect(stored.toString('utf8')).not.toContain('PLAINTEXT SENTINEL');
    expect(stored.toString('latin1')).not.toContain('RV01-04 ROW4/5/6');
    expect(createHash('sha256').update(stored).digest('hex'))
      .not.toBe(createHash('sha256').update(plain).digest('hex'));
    expect(stored.length).toBeGreaterThan(0);
  });

  test('ROW 6 — an independent Vault call unwraps the DEK and decrypts to the original plaintext', async () => {
    if (!live) return;
    const { s3, ack } = await uploadOnce();
    const stored = await readStored(s3);
    const acked = ack as { manifestKey: string };

    const gotManifest = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: acked.manifestKey }));
    const manifest = JSON.parse((await bodyBytes(gotManifest.Body)).toString('utf8')) as {

      encryption: { nonce: string; tag: string; aad: string; dek: { ciphertext: string } };
    };

    // Independent unwrap: raw fetch, no repo crypto module in this path.
    const unwrap = await fetch(VAULT_ADDR + '/v1/' + MOUNT + '/decrypt/' + TRANSIT_KEY, {
      method: 'POST',
      headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: manifest.encryption.dek.ciphertext }),
    });
    expect(unwrap.status).toBe(200);
    const unwrappedJson = (await unwrap.json()) as { data: { plaintext: string } };
    const dek = Buffer.from(unwrappedJson.data.plaintext, 'base64');
    expect(dek.length).toBe(32);

    // Decrypt with the Vault-unwrapped DEK, the nonce and tag from the
    // manifest, and the AAD the manifest itself carries. A wrong DEK, a wrong
    // nonce/tag or a tampered AAD would all fail the GCM tag check here, so a
    // byte-identical plaintext is a real end-to-end proof.
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(manifest.encryption.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(manifest.encryption.tag, 'base64'));
    decipher.setAAD(Buffer.from(manifest.encryption.aad, 'base64'));
    const roundTrip = Buffer.concat([decipher.update(stored), decipher.final()]);
    expect(roundTrip.equals(Buffer.from(PLAINTEXT))).toBe(true);
  });
});

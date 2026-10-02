/**
 * CR28-01: an encrypted artifact must be authenticated and opened before any
 * caller sees bytes — a worker, or the public download API.
 *
 * The last test is the one that matters most. Before this module both read
 * paths streamed the raw stored bytes, so a sealed object was handed to a
 * worker as ciphertext and to the API labelled with the artifact's MIME type.
 * "Never returns ciphertext when it could not decrypt" is the property that
 * closes that, and it is asserted directly rather than implied.
 *
 * The key provider is a REAL reversible transform (XOR over an HMAC
 * keystream), not an echo: an echo provider would make a broken AAD binding
 * look authenticated, which is exactly the negative this file exists to pin.
 */
import { createHmac } from 'node:crypto';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import {
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
  PUBLIC_UPLOAD_PURPOSE,
  decryptStoredArtifact,
  manifestKeyFor,
  type ArtifactDecryptDeps,
  type SealedArtifactRef,
  type StoredObjectMetadata,
  type StoredObjectReader,
} from '../src/modules/encryption/artifact-read-decrypt';

const KEY_REF = 'du-read-path-v1';
const TENANT = 'tenant-read-a';
const OTHER_TENANT = 'tenant-read-b';
const ARTIFACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ARTIFACT = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UPLOAD_TOKEN = '11111111-2222-4333-8444-555555555555';
const OTHER_TOKEN = '99999999-2222-4333-8444-555555555555';
const STORAGE_KEY = TENANT + '/ingest/2026-09-28/doc.pdf';
const SECRET = 'CONFIDENTIAL-READ-PATH-BODY-3b81f0';
const HASH = String.fromCharCode(35);

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'read-path-double').update(seed + String.fromCharCode(58) + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}

function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}

function makeKeyProvider(opts: { wrongKey?: boolean } = {}): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + HASH + version, input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      if (opts.wrongKey) return Buffer.alloc(32, 0xee);
      return xor(raw, keystream(wrapped.keyRef + HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

interface SealedFixture {
  readonly ciphertext: Buffer;
  readonly manifest: Record<string, unknown>;
  readonly metadata: StoredObjectMetadata;
}

/** Encrypt exactly the way the upload gateway does, so the AAD has to match. */
async function sealStoredObject(provider: KeyProvider, objectVersion: string): Promise<SealedFixture> {
  const facade = new CryptoStorageFacade(provider);
  const sealed = await facade.encrypt(Buffer.from(SECRET, 'utf8'), {
    tenantId: TENANT,
    artifactId: ARTIFACT,
    objectVersion,
    purpose: PUBLIC_UPLOAD_PURPOSE,
    keyRef: KEY_REF,
  });
  return {
    ciphertext: Buffer.from(sealed.ciphertext),
    manifest: {
      version: sealed.version,
      algorithm: sealed.algorithm,
      nonce: sealed.nonce,
      tag: sealed.tag,
      aad: sealed.aad,
      plaintextSizeBytes: sealed.plaintextSizeBytes,
      plaintextSha256: sealed.plaintextSha256,
      dek: sealed.dek,
    },
    metadata: {
      [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
      artifactid: ARTIFACT,
      tenantid: TENANT,
      [MANIFEST_KEY_METADATA]: manifestKeyFor(STORAGE_KEY),
    },
  };
}

function makeReader(fixture: SealedFixture | null, plaintext = ''): StoredObjectReader {
  return {
    async head(): Promise<StoredObjectMetadata | null> {
      if (fixture) return fixture.metadata;
      return { artifactid: ARTIFACT, tenantid: TENANT };
    },
    async read(): Promise<Buffer> {
      if (fixture) return fixture.ciphertext;
      return Buffer.from(plaintext, 'utf8');
    },
    async readManifest(): Promise<unknown> {
      if (!fixture) throw new Error('no manifest');
      return fixture.manifest;
    },
  };
}

const REF: SealedArtifactRef = {
  artifactId: ARTIFACT,
  tenantId: TENANT,
  storageKey: STORAGE_KEY,
  uploadToken: UPLOAD_TOKEN,
};

function depsFor(reader: StoredObjectReader, provider: KeyProvider = makeKeyProvider()): ArtifactDecryptDeps {
  return { reader, facade: new CryptoStorageFacade(provider) };
}

describe('CR28-01 read path: a plain object is untouched', () => {
  it('passes the stored bytes through and reports decrypted=false', async () => {
    const out = await decryptStoredArtifact(depsFor(makeReader(null, SECRET)), REF);
    expect(out.decrypted).toBe(false);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
  });

  it('never asks for a manifest when the object is not sealed', async () => {
    let asked = 0;
    const base = makeReader(null, SECRET);
    const reader: StoredObjectReader = { ...base, readManifest: async () => { asked += 1; return {}; } };
    await decryptStoredArtifact(depsFor(reader), REF);
    expect(asked).toBe(0);
  });
});

describe('CR28-01 read path: a sealed object comes back as plaintext', () => {
  it('decrypts with the bound key and returns the original bytes', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    const out = await decryptStoredArtifact(depsFor(makeReader(fixture), provider), REF);
    expect(out.decrypted).toBe(true);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
  });

  it('reads the manifest from the sidecar key derived from the storage key', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    let requested = '';
    const base = makeReader(fixture);
    const reader: StoredObjectReader = {
      ...base,
      readManifest: async (k) => { requested = k; return base.readManifest(k); },
    };
    await decryptStoredArtifact(depsFor(reader, provider), REF);
    expect(requested).toBe(manifestKeyFor(STORAGE_KEY));
    expect(requested.endsWith('.crypto-manifest.json')).toBe(true);
  });
});

describe('CR28-01 read path: every failure is closed, none falls back to ciphertext', () => {
  it('a wrong key is refused', async () => {
    const fixture = await sealStoredObject(makeKeyProvider(), UPLOAD_TOKEN);
    await expect(
      decryptStoredArtifact(depsFor(makeReader(fixture), makeKeyProvider({ wrongKey: true })), REF),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a wrong pinned object version (upload token) is refused', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    await expect(
      decryptStoredArtifact(depsFor(makeReader(fixture), provider), {
        ...REF,
        uploadToken: OTHER_TOKEN,
      }),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a missing pinned object version is refused rather than guessed', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    await expect(
      decryptStoredArtifact(depsFor(makeReader(fixture), provider), { ...REF, uploadToken: null }),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a manifest for another object is refused (pointer mismatch)', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    const reader: StoredObjectReader = {
      ...makeReader(fixture),
      head: async () =>
        ({
          ...fixture.metadata,
          [MANIFEST_KEY_METADATA]: 'someone-elses-manifest.json',
        }) as StoredObjectMetadata,
    };
    await expect(decryptStoredArtifact(depsFor(reader, provider), REF)).rejects.toMatchObject({
      status: 503,
      code: 'STORAGE_FAILURE',
    });
  });

  it('a manifest missing a required field is refused', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    const broken = { ...fixture.manifest } as Record<string, unknown>;
    delete broken.tag;
    const reader: StoredObjectReader = { ...makeReader(fixture), readManifest: async () => broken };
    await expect(decryptStoredArtifact(depsFor(reader, provider), REF)).rejects.toMatchObject({
      status: 503,
      code: 'STORAGE_FAILURE',
    });
  });

  it('an object stamped with another artifact id is refused', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    const reader: StoredObjectReader = {
      ...makeReader(fixture),
      head: async () => ({ ...fixture.metadata, artifactid: OTHER_ARTIFACT }) as StoredObjectMetadata,
    };
    await expect(decryptStoredArtifact(depsFor(reader, provider), REF)).rejects.toMatchObject({
      status: 503,
      code: 'STORAGE_FAILURE',
    });
  });

  it('an object stamped with another tenant is refused as forbidden', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    const reader: StoredObjectReader = {
      ...makeReader(fixture),
      head: async () => ({ ...fixture.metadata, tenantid: OTHER_TENANT }) as StoredObjectMetadata,
    };
    await expect(decryptStoredArtifact(depsFor(reader, provider), REF)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('a sealed object on a deployment with no crypto is refused', async () => {
    const fixture = await sealStoredObject(makeKeyProvider(), UPLOAD_TOKEN);
    await expect(decryptStoredArtifact({ reader: makeReader(fixture) }, REF)).rejects.toMatchObject({
      status: 503,
      code: 'STORAGE_FAILURE',
    });
  });

  it('a missing object is 404, not an empty read', async () => {
    const reader: StoredObjectReader = { ...makeReader(null, SECRET), head: async () => null };
    await expect(decryptStoredArtifact(depsFor(reader), REF)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('NEVER returns ciphertext when it cannot decrypt (the CR28-01 property)', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    let leaked = false;
    try {
      const out = await decryptStoredArtifact(
        depsFor(makeReader(fixture), makeKeyProvider({ wrongKey: true })),
        REF,
      );
      leaked = out.bytes.equals(fixture.ciphertext) || out.decrypted === true;
    } catch {
      leaked = false;
    }
    expect(leaked).toBe(false);
  });
});

// Delta 68: the CHUNKED branch. Everything else in this file is single-shot,
// which is the only shape the public upload gateway produces today, so the
// `'chunks' in manifest` path had no coverage at all. It is the path a >5 MiB
// artifact takes, and a bug there would be silent: the object is genuinely
// encrypted, the marker is present, and a reader that never exercised it would
// never learn that.
//
// The ciphertext is fed as ONE blob on purpose. The facade pulls exact byte
// counts per chunk through its own reader, so the transport shape is irrelevant
// to correctness - which is exactly what makes it worth pinning here.
describe('D68 chunked decrypt: a >5 MiB artifact round-trips through the module', () => {
  const CHUNKED_BYTES = 6 * 1024 * 1024;

  function bigPlaintext(): Buffer {
    // Deterministic, and large enough to force more than one 4 MiB chunk.
    const out = Buffer.alloc(CHUNKED_BYTES);
    for (let i = 0; i < out.length; i += 1) out[i] = i % 251;
    return out;
  }

  async function* source(buf: Buffer): AsyncGenerator<Buffer, void, void> {
    yield buf;
  }

  async function sealChunked(provider: KeyProvider) {
    const facade = new CryptoStorageFacade(provider);
    const plaintext = bigPlaintext();
    const { ciphertext, manifest } = facade.encryptStream(source(plaintext), {
      tenantId: TENANT,
      artifactId: ARTIFACT,
      objectVersion: UPLOAD_TOKEN,
      purpose: PUBLIC_UPLOAD_PURPOSE,
      keyRef: KEY_REF,
    });
    const parts: Buffer[] = [];
    for await (const chunk of ciphertext) parts.push(Buffer.from(chunk));
    return { plaintext, ciphertext: Buffer.concat(parts), manifest: await manifest };
  }

  function chunkedReader(body: Buffer, manifest: unknown): StoredObjectReader {
    return {
      head: async () => ({
        [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
        artifactid: ARTIFACT,
        tenantid: TENANT,
        [MANIFEST_KEY_METADATA]: manifestKeyFor(STORAGE_KEY),
      }),
      read: async () => body,
      readManifest: async () => manifest,
    };
  }

  it('produces a manifest that really has more than one chunk', async () => {
    const { manifest } = await sealChunked(makeKeyProvider());
    expect(manifest.totalChunks).toBeGreaterThan(1);
    expect(manifest.chunks.length).toBe(manifest.totalChunks);
    expect(typeof manifest.manifestMac).toBe('string');
  });

  it('decrypts the whole object back to the original plaintext', async () => {
    const provider = makeKeyProvider();
    const { plaintext, ciphertext, manifest } = await sealChunked(provider);
    const out = await decryptStoredArtifact(
      depsFor(chunkedReader(ciphertext, manifest), provider),
      REF,
    );
    expect(out.decrypted).toBe(true);
    expect(out.bytes.length).toBe(plaintext.length);
    expect(out.bytes.equals(plaintext)).toBe(true);
  });

  it('never hands back the ciphertext when the chunked seal is fine', async () => {
    const provider = makeKeyProvider();
    const { ciphertext, manifest } = await sealChunked(provider);
    const out = await decryptStoredArtifact(
      depsFor(chunkedReader(ciphertext, manifest), provider),
      REF,
    );
    expect(out.bytes.equals(ciphertext)).toBe(false);
  });
});

describe('D68 chunked decrypt: tampering and mis-binding fail closed', () => {
  const CHUNKED_BYTES = 6 * 1024 * 1024;

  function bigPlaintext(): Buffer {
    const out = Buffer.alloc(CHUNKED_BYTES);
    for (let i = 0; i < out.length; i += 1) out[i] = i % 251;
    return out;
  }

  async function* source(buf: Buffer): AsyncGenerator<Buffer, void, void> {
    yield buf;
  }

  async function sealChunked(provider: KeyProvider) {
    const facade = new CryptoStorageFacade(provider);
    const { ciphertext, manifest } = facade.encryptStream(source(bigPlaintext()), {
      tenantId: TENANT,
      artifactId: ARTIFACT,
      objectVersion: UPLOAD_TOKEN,
      purpose: PUBLIC_UPLOAD_PURPOSE,
      keyRef: KEY_REF,
    });
    const parts: Buffer[] = [];
    for await (const chunk of ciphertext) parts.push(Buffer.from(chunk));
    return { ciphertext: Buffer.concat(parts), manifest: await manifest };
  }

  function chunkedReader(body: Buffer, manifest: unknown): StoredObjectReader {
    return {
      head: async () => ({
        [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
        artifactid: ARTIFACT,
        tenantid: TENANT,
        [MANIFEST_KEY_METADATA]: manifestKeyFor(STORAGE_KEY),
      }),
      read: async () => body,
      readManifest: async () => manifest,
    };
  }

  it('a wrong key is refused before any plaintext is yielded', async () => {
    const { ciphertext, manifest } = await sealChunked(makeKeyProvider());
    await expect(
      decryptStoredArtifact(
        depsFor(chunkedReader(ciphertext, manifest), makeKeyProvider({ wrongKey: true })),
        REF,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a tampered manifest MAC is refused', async () => {
    // The MAC covers every manifest field including the ordered chunk list, so
    // editing one byte of it must fail authentication rather than be ignored.
    const provider = makeKeyProvider();
    const { ciphertext, manifest } = await sealChunked(provider);
    const tampered = { ...manifest, manifestMac: manifest.manifestMac.replace(/^./, 'A') };
    await expect(
      decryptStoredArtifact(depsFor(chunkedReader(ciphertext, tampered), provider), REF),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a manifest bound to another artifact is refused', async () => {
    // Sealed for a different artifactId, then offered under this one: the
    // contextAad in the manifest no longer rebuilds, so it must not open.
    const provider = makeKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const { ciphertext, manifest } = facade.encryptStream(source(bigPlaintext()), {
      tenantId: TENANT,
      artifactId: OTHER_ARTIFACT,
      objectVersion: UPLOAD_TOKEN,
      purpose: PUBLIC_UPLOAD_PURPOSE,
      keyRef: KEY_REF,
    });
    const parts: Buffer[] = [];
    for await (const chunk of ciphertext) parts.push(Buffer.from(chunk));
    await expect(
      decryptStoredArtifact(depsFor(chunkedReader(Buffer.concat(parts), manifest), provider), REF),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a wrong pinned object version is refused', async () => {
    const provider = makeKeyProvider();
    const { ciphertext, manifest } = await sealChunked(provider);
    await expect(
      decryptStoredArtifact(depsFor(chunkedReader(ciphertext, manifest), provider), {
        ...REF,
        uploadToken: OTHER_TOKEN,
      }),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('a truncated ciphertext body is refused, not returned short', async () => {
    const provider = makeKeyProvider();
    const { ciphertext, manifest } = await sealChunked(provider);
    const truncated = ciphertext.subarray(0, ciphertext.length - 1024);
    await expect(
      decryptStoredArtifact(depsFor(chunkedReader(truncated, manifest), provider), REF),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('NEVER returns partial plaintext for a chunked object that fails', async () => {
    const provider = makeKeyProvider();
    const { ciphertext, manifest } = await sealChunked(provider);
    const truncated = ciphertext.subarray(0, ciphertext.length - 1024);
    let leaked = false;
    try {
      const out = await decryptStoredArtifact(
        depsFor(chunkedReader(truncated, manifest), provider),
        REF,
      );
      // A short buffer is the dangerous outcome: it looks like a successful
      // read of a smaller document.
      leaked = out.decrypted && out.bytes.length > 0;
    } catch {
      leaked = false;
    }
    expect(leaked).toBe(false);
  });
});

describe('RV01-03 defect 3: a marker-less object fails closed where encryption is required', () => {
  it('refuses the read instead of serving the stored bytes as plaintext', async () => {
    const deps: ArtifactDecryptDeps = { ...depsFor(makeReader(null, SECRET)), encryptionRequired: true };
    await expect(decryptStoredArtifact(deps, REF)).rejects.toMatchObject({
      status: 503,
      code: 'STORAGE_FAILURE',
    });
  });

  it('never returns the bytes, even when the caller already holds them', async () => {
    // The streaming routes pass the bytes in rather than letting the reader
    // fetch them, so the refusal must hold in that shape too - otherwise the
    // same object would be refused on one route and served on another.
    const deps: ArtifactDecryptDeps = { ...depsFor(makeReader(null, SECRET)), encryptionRequired: true };
    await expect(
      decryptStoredArtifact(deps, REF, Buffer.from(SECRET, 'utf8')),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('asks for no manifest on the refused path', async () => {
    let asked = 0;
    const base = makeReader(null, SECRET);
    const reader: StoredObjectReader = {
      ...base,
      readManifest: async () => {
        asked += 1;
        return {};
      },
    };
    const deps: ArtifactDecryptDeps = { ...depsFor(reader), encryptionRequired: true };
    await expect(decryptStoredArtifact(deps, REF)).rejects.toMatchObject({ status: 503 });
    expect(asked).toBe(0);
  });

  it('CONFIG OFF: the compatibility path still returns the plain object', async () => {
    // encryptionRequired defaults to false, so a deployment that has not opted
    // in keeps the pre-RV01-03 behaviour. That is safe by construction: an
    // unmarked object is plaintext because nothing ever marked it otherwise.
    const out = await decryptStoredArtifact(depsFor(makeReader(null, SECRET)), REF);
    expect(out.decrypted).toBe(false);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
  });

  it('a properly sealed object still decrypts when encryption is required', async () => {
    const provider = makeKeyProvider();
    const fixture = await sealStoredObject(provider, UPLOAD_TOKEN);
    const deps: ArtifactDecryptDeps = { ...depsFor(makeReader(fixture), provider), encryptionRequired: true };
    const out = await decryptStoredArtifact(deps, REF);
    expect(out.decrypted).toBe(true);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
  });
});

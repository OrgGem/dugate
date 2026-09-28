import { Readable } from 'node:stream';
import {
  ArtifactDownloadResponseSchema,
  EncryptedArtifactDownloadSchema,
  EncryptedResultEnvelopeSchema,
  PlainArtifactDownloadBodySchema,
  ResultEnvelopeSchema,
  ResultResponseSchema,
} from '../src';

const VALID_DELIVERY = {
  version: 1 as const,
  suite: 'rsa-oaep-sha256' as const,
  recipientKeyId: 'tenant-key-3',
  recipientKeyVersion: 3,
  enc: 'YQ==',
  nonce: 'AAAAAAAAAAAAAAAA',
  tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
  ciphertext: 'Yg==',
};

const PLAIN_RESULT = {
  schemaVersion: '1' as const,
  data: { resultRef: 'result-123' },
  artifacts: [],
  usage: { inputTokens: 2, outputTokens: 5, costMicrousd: 7, measurement: 'final' as const },
  warnings: [],
};

const ENCRYPTED_RESULT = {
  schemaVersion: '1' as const,
  encrypted: true as const,
  delivery: VALID_DELIVERY,
};

describe('RESULT-WIRE-01 result and artifact download contracts', () => {
  it('accepts the inline plain ResultEnvelope and keeps its established fields/defaults', () => {
    expect(ResultEnvelopeSchema.parse(PLAIN_RESULT)).toMatchObject(PLAIN_RESULT);
    expect(ResultResponseSchema.parse(PLAIN_RESULT)).toMatchObject(PLAIN_RESULT);
    expect(ResultEnvelopeSchema.safeParse({ ...PLAIN_RESULT, encrypted: true }).success).toBe(false);
  });

  it('accepts only the versioned encrypted result wrapper with the shared recipient envelope', () => {
    expect(EncryptedResultEnvelopeSchema.parse(ENCRYPTED_RESULT)).toEqual(ENCRYPTED_RESULT);
    expect(ResultResponseSchema.parse(ENCRYPTED_RESULT)).toEqual(ENCRYPTED_RESULT);
    expect(EncryptedResultEnvelopeSchema.safeParse({
      ...ENCRYPTED_RESULT,
      delivery: { ...VALID_DELIVERY, recipientKeyVersion: 0 },
    }).success).toBe(false);
    expect(EncryptedResultEnvelopeSchema.safeParse({ ...ENCRYPTED_RESULT, data: PLAIN_RESULT.data }).success).toBe(false);
    expect(EncryptedResultEnvelopeSchema.safeParse({ ...ENCRYPTED_RESULT, encrypted: false }).success).toBe(false);
  });

  it('accepts raw byte or streaming bodies for plain downloads without JSON wrapping', () => {
    expect(PlainArtifactDownloadBodySchema.safeParse(Buffer.from('artifact bytes')).success).toBe(true);
    expect(PlainArtifactDownloadBodySchema.safeParse(Readable.from([Buffer.from('artifact bytes')])).success).toBe(true);
    expect(ArtifactDownloadResponseSchema.safeParse(Readable.from([Buffer.from('artifact bytes')])).success).toBe(true);
    expect(PlainArtifactDownloadBodySchema.safeParse({ data: 'base64-body' }).success).toBe(false);
  });

  it('validates the encrypted download wrapper and rejects unknown fields', () => {
    const encryptedDownload = {
      schemaVersion: '1',
      encrypted: true,
      delivery: VALID_DELIVERY,
      artifactId: '22222222-2222-4222-8222-222222222222',
      mimeType: 'application/octet-stream',
    };
    expect(EncryptedArtifactDownloadSchema.parse(encryptedDownload)).toEqual(encryptedDownload);
    expect(ArtifactDownloadResponseSchema.parse(encryptedDownload)).toEqual(encryptedDownload);
    expect(EncryptedArtifactDownloadSchema.safeParse({ ...encryptedDownload, rawBytes: 'leak' }).success).toBe(false);
    expect(EncryptedArtifactDownloadSchema.safeParse({ ...encryptedDownload, artifactId: 'not-a-uuid' }).success).toBe(false);
  });
});

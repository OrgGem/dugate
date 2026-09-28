/**
 * ENC-07 (tasks/APP-ENCRYPTION-2026-09-27.md): Delivery encryption for
 * public result/download API responses.
 *
 * Server-side policy decides plaintext vs recipient-encrypted; no client
 * override exists (no query param, no header). When enabled per tenant:
 *   1. A fresh delivery DEK (32 bytes) is generated per response.
 *   2. The payload is encrypted with AES-256-GCM (unique nonce).
 *   3. The DEK is wrapped under the recipient public key from the
 *      ENC-06 registry (RSA-OAEP-SHA256 suite; HPKE when available).
 *   4. The RecipientDeliveryEnvelope (ENC-01 schema) is returned.
 *
 * Fail-closed: missing key, revoked key, registry error, or crypto failure
 * all produce 503 — never a plaintext fallback.
 */

import {
  createCipheriv,
  publicEncrypt,
  randomBytes,
  constants,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { RecipientDeliveryEnvelopeSchema } from '@du/contracts';
import type { RecipientDeliveryEnvelope, DeliverySuite } from '@du/contracts';
import type { RecipientKeyRegistry, RecipientPublicKeyRecord } from '../encryption/recipient-key-registry';
import { RecipientKeyRegistryError } from '../encryption/recipient-key-registry';

// ---------------------------------------------------------------------------
// Policy types (injected via ServerConfig; no DB table yet)
// ---------------------------------------------------------------------------

/** Per-tenant delivery encryption policy. */
export interface TenantDeliveryPolicy {
  readonly enabled: boolean;
  /** Cipher suite for DEK encapsulation. Default: rsa-oaep-sha256. */
  readonly suite?: DeliverySuite;
  /**
   * Optional pinned recipient key version. When set, the service MUST use
   * this exact version (retrieved via the registry's getKeyVersion) instead of
   * the current active key. This allows an operator to pin a specific key
   * version for delivery. The version MUST be registered for the tenant and
   * must not be revoked; otherwise delivery fails closed.
   */
  readonly pinnedRecipientKeyVersion?: number | null;
}

/**
 * A policy source for the delivery encryption service. Supplied by the
 * ENC-08 admin layer, backed by its durable store. Returns the CURRENT policy
 * for a tenant, resolved per-request — a change an operator makes in the
 * Admin UI takes effect on the very next public delivery without a restart.
 */
export interface TenantDeliveryPolicySource {
  getDeliveryPolicy(tenantId: string): Promise<TenantDeliveryPolicy | undefined>;
}

/** Configuration injected at composition root. */
export interface DeliveryEncryptionConfig {
  /** tenantId → policy. Absent tenant = plaintext (no encryption). */
  readonly policyByTenant?: Readonly<Record<string, TenantDeliveryPolicy>>;
  /** ENC-08 store-backed source. Takes precedence over `policyByTenant` when present. */
  readonly policySource?: TenantDeliveryPolicySource;
  /** ENC-06 recipient key registry. Required when any policy is enabled. */
  readonly recipientKeyRegistry?: RecipientKeyRegistry;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DeliveryEncryptionErrorCode =
  | 'DELIVERY_ENCRYPTION_DISABLED'
  | 'RECIPIENT_KEY_NOT_FOUND'
  | 'RECIPIENT_KEY_REVOKED'
  | 'DELIVERY_CRYPTO_FAILURE'
  | 'REGISTRY_UNAVAILABLE';

export class DeliveryEncryptionError extends Error {
  public readonly code: DeliveryEncryptionErrorCode;
  public readonly httpStatus: number;

  public constructor(code: DeliveryEncryptionErrorCode, message: string) {
    super(message);
    this.name = 'DeliveryEncryptionError';
    this.code = code;
    this.httpStatus = code === 'DELIVERY_ENCRYPTION_DISABLED' ? 409 : 503;
  }
}

// ---------------------------------------------------------------------------
// Delivery encryption service
// ---------------------------------------------------------------------------

export interface DeliveryEncryptionService {
  /** Returns the tenant policy, or undefined when absent (= plaintext). */
  getPolicy(tenantId: string): TenantDeliveryPolicy | undefined;
  /**
   * Resolve the tenant policy, consulting the dynamic source when one is
   * configured. This is what the public routes call: the Admin toggle must
   * take effect without a restart, so the policy is read per-request.
   */
  resolvePolicy(tenantId: string): Promise<TenantDeliveryPolicy | undefined>;
  /**
   * Encrypt a payload buffer for delivery to the tenant's registered
   * recipient key. Returns the ENC-01 RecipientDeliveryEnvelope.
   * Throws DeliveryEncryptionError on any failure (fail-closed).
   */
  encryptForDelivery(tenantId: string, payload: Buffer): Promise<RecipientDeliveryEnvelope>;
}

const GCM_NONCE_BYTES = 12;
const AES_KEY_BYTES = 32;

/**
 * Resolve the effective suite from policy + recipient key algorithm.
 * RSA keys → rsa-oaep-sha256; X25519 → hpke-rfc9180.
 * Policy suite preference is honored only if compatible with the key.
 */
function resolveSuite(key: RecipientPublicKeyRecord): DeliverySuite {
  if (key.algorithm === 'hpke-x25519') return 'hpke-rfc9180';
  return 'rsa-oaep-sha256';
}

/**
 * Wrap the delivery DEK under the recipient RSA public key using
 * RSA-OAEP-SHA256. The wrapped blob becomes the envelope's `enc` field.
 */
function wrapDekRsaOaep(dek: Buffer, publicKeyPem: string): Buffer {
  const key: KeyObject = createPublicKey(publicKeyPem);
  return publicEncrypt(
    {
      key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    dek,
  );
}

export function createDeliveryEncryptionService(
  config: DeliveryEncryptionConfig | undefined,
): DeliveryEncryptionService | null {
  const staticPolicies = config?.policyByTenant;
  const source = config?.policySource;
  const hasStatic = staticPolicies !== undefined && Object.keys(staticPolicies).length > 0;
  if (!config || (!hasStatic && !source)) {
    return null;
  }
  const registry = config.recipientKeyRegistry;

  const service: DeliveryEncryptionService = {
    getPolicy(tenantId: string): TenantDeliveryPolicy | undefined {
      // A dynamic source resolves per request and cannot be read synchronously.
      // Failing loudly beats returning a stale static answer that a caller would
      // then act on: the whole point of the Admin toggle is that it is NOT stale.
      if (source) {
        throw new DeliveryEncryptionError(
          'DELIVERY_ENCRYPTION_DISABLED',
          'Delivery policy is store-backed; resolvePolicy() must be used',
        );
      }
      return staticPolicies?.[tenantId];
    },

    async resolvePolicy(tenantId: string): Promise<TenantDeliveryPolicy | undefined> {
      if (source) return source.getDeliveryPolicy(tenantId);
      return staticPolicies?.[tenantId];
    },

    async encryptForDelivery(tenantId: string, payload: Buffer): Promise<RecipientDeliveryEnvelope> {
      const policy = await service.resolvePolicy(tenantId);
      if (!policy || !policy.enabled) {
        throw new DeliveryEncryptionError(
          'DELIVERY_ENCRYPTION_DISABLED',
          'Delivery encryption is not enabled for this tenant',
        );
      }
      if (!registry) {
        throw new DeliveryEncryptionError(
          'REGISTRY_UNAVAILABLE',
          'Recipient key registry is not configured',
        );
      }

      // Resolve the recipient key. A PINNED version is honoured exactly: the
      // operator chose it in the Admin, so a rotation that happens afterwards
      // must not silently change who can decrypt. Fail-closed either way -
      // a pinned version that is gone or revoked refuses the delivery, it does
      // not fall back to the current key.
      const pinned = policy.pinnedRecipientKeyVersion;
      const hasPin = typeof pinned === 'number' && Number.isSafeInteger(pinned) && pinned > 0;
      let recipientKey: RecipientPublicKeyRecord;
      try {
        recipientKey = hasPin
          ? await registry.getKeyVersion(tenantId, pinned as number)
          : await registry.getCurrentKey(tenantId);
      } catch (err) {
        if (err instanceof RecipientKeyRegistryError) {
          if (err.code === 'KEY_NOT_FOUND') {
            throw new DeliveryEncryptionError('RECIPIENT_KEY_NOT_FOUND', err.message);
          }
          if (err.code === 'KEY_REVOKED') {
            throw new DeliveryEncryptionError('RECIPIENT_KEY_REVOKED', err.message);
          }
          throw new DeliveryEncryptionError('REGISTRY_UNAVAILABLE', err.message);
        }
        throw new DeliveryEncryptionError('REGISTRY_UNAVAILABLE', 'Recipient key registry is unavailable');
      }

      const suite = resolveSuite(recipientKey);

      // HPKE requires an external implementation not yet available.
      if (suite === 'hpke-rfc9180') {
        throw new DeliveryEncryptionError(
          'DELIVERY_CRYPTO_FAILURE',
          'HPKE delivery suite is not yet implemented; register an RSA key',
        );
      }

      // Generate fresh delivery DEK + nonce.
      const dek = randomBytes(AES_KEY_BYTES);
      const nonce = randomBytes(GCM_NONCE_BYTES);

      try {
        // AES-256-GCM encrypt the payload.
        const cipher = createCipheriv('aes-256-gcm', dek, nonce);
        const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
        const tag = cipher.getAuthTag();

        // Wrap DEK under recipient RSA public key.
        const enc = wrapDekRsaOaep(dek, recipientKey.publicKeyPem);

        // Zero the plaintext DEK.
        dek.fill(0);

        // The envelope we emit must satisfy the ENC-01 contract before it
        // leaves this function. A producer that drifts from the schema would
        // otherwise ship a body the external client cannot parse, and the
        // failure would surface on THEIR side, not ours.
        const envelope: RecipientDeliveryEnvelope = {
          version: 1,
          suite,
          recipientKeyId: recipientKey.id,
          recipientKeyVersion: recipientKey.version,
          enc: enc.toString('base64'),
          nonce: nonce.toString('base64'),
          tag: tag.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
        if (!RecipientDeliveryEnvelopeSchema.safeParse(envelope).success) {
          throw new DeliveryEncryptionError(
            'DELIVERY_CRYPTO_FAILURE',
            'Delivery envelope does not satisfy the ENC-01 contract',
          );
        }
        return envelope;
      } catch (err) {
        dek.fill(0);
        throw new DeliveryEncryptionError(
          'DELIVERY_CRYPTO_FAILURE',
          'Delivery encryption operation failed',
        );
      }
    },
  };
  return service;
}

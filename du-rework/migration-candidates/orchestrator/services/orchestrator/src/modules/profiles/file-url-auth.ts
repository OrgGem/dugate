import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  FILE_URL_AUTH_CIPHER_RE,
  FileUrlAuthConfigSchema,
  type FileUrlAuthConfig,
} from '@du/contracts';

/**
 * T-PROF-04 — `fileUrlAuthConfig` encryption at rest.
 *
 * Ports legacy `lib/crypto.ts` byte-for-byte on purpose. The storage column is
 * `profile_bindings.file_url_auth_cipher` (migration 0026) and the value is the
 * three-part lowercase-hex string `iv:tag:ciphertext` — NOT a JSON envelope.
 * A future reader that "helpfully" wraps it in JSON cannot be migrated back to
 * a column that legacy-shaped tooling expects, so the shape is frozen here and
 * asserted by `packages/contracts`' `FileUrlAuthCipherSchema`.
 *
 * This is deliberately NOT the Vault transit path used for artifacts
 * (`modules/encryption/vault-transit-provider.ts`). Plan §2 constraint: the
 * profile secret follows the legacy AES-256-GCM pattern and must not touch
 * Vault.
 */

const ALGORITHM = 'aes-256-gcm';
/** GCM standard, legacy `lib/crypto.ts` IV_LENGTH. */
const IV_LENGTH = 12;
/** Legacy TAG_LENGTH. */
const TAG_LENGTH = 16;

export type ProfileEnv = Readonly<Record<string, string | undefined>>;

/**
 * Derive the 32-byte key exactly like legacy: SHA-256 of `ENCRYPTION_KEY`,
 * falling back to `NEXTAUTH_SECRET`. Both absent is a hard boot error — never
 * a silent unkeyed fallback, which would write plaintext-shaped "ciphertext".
 */
export function resolveProfileCryptoKey(env: ProfileEnv): Buffer {
  const secret = env.ENCRYPTION_KEY ?? env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'ENCRYPTION_KEY (or NEXTAUTH_SECRET) is not set. Set it to a random 32-char ' +
        'string before encrypting a profile fileUrlAuthConfig.'
    );
  }
  return createHash('sha256').update(secret).digest();
}

/** True when the stored string is the three-part hex cipher (not a JSON envelope). */
export function isFileUrlAuthCipher(value: unknown): value is string {
  return typeof value === 'string' && FILE_URL_AUTH_CIPHER_RE.test(value);
}

/**
 * Encrypt a write-side `fileUrlAuthConfig` to the storage string.
 *
 * The IV is fresh per call, so encrypting the same config twice yields two
 * different strings — the column is not content-addressable and must never be
 * used for equality checks.
 */
export function encryptFileUrlAuthConfig(config: FileUrlAuthConfig, env: ProfileEnv): string {
  const key = resolveProfileCryptoKey(env);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Order is load-bearing: iv, then tag, then ciphertext — legacy's order.
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export type DecryptedFileUrlAuth =
  | { kind: 'cipher'; config: FileUrlAuthConfig }
  | { kind: 'legacy-plaintext'; config: FileUrlAuthConfig };

/**
 * Decrypt a stored value.
 *
 * Two storage generations are accepted:
 *
 *  - the three-part hex cipher (what T-PROF-04 writes), and
 *  - legacy plaintext JSON, which legacy's `getFileUrlAuthConfig` fell back to
 *    after `decrypt()` threw. Legacy rows are READ, never rewritten: a decrypt
 *    that silently "upgraded" the row would destroy the only copy of the value
 *    if the write transaction later failed.
 *
 * Anything else — including a JSON envelope someone handed us by mistake — is
 * `null`. A malformed secret is a missing secret, never a partial one.
 */
export function decryptFileUrlAuthConfig(
  stored: unknown,
  env: ProfileEnv,
  onLegacyPlaintext?: () => void
): DecryptedFileUrlAuth | null {
  if (typeof stored !== 'string' || stored.length === 0) return null;

  if (isFileUrlAuthCipher(stored)) {
    const [ivHex, tagHex, ciphertextHex] = stored.split(':');
    const decipher = createDecipheriv(ALGORITHM, resolveProfileCryptoKey(env), Buffer.from(ivHex!, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex!, 'hex'));
    let plaintext: string;
    try {
      plaintext =
        decipher.update(Buffer.from(ciphertextHex!, 'hex')).toString('utf8') +
        decipher.final('utf8');
    } catch {
      // Wrong key or tampered ciphertext. Fail closed: no config, no throw.
      return null;
    }
    const parsed = FileUrlAuthConfigSchema.safeParse(safeJsonParse(plaintext));
    return parsed.success ? { kind: 'cipher', config: parsed.data } : null;
  }

  // Not the cipher shape. Legacy plaintext JSON is the only other thing a
  // legacy row can hold; anything else is refused rather than guessed at.
  const legacy = FileUrlAuthConfigSchema.safeParse(safeJsonParse(stored));
  if (legacy.success) {
    onLegacyPlaintext?.();
    return { kind: 'legacy-plaintext', config: legacy.data };
  }
  return null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Warn-once latch for the legacy-plaintext read path.
 *
 * A single misconfigured profile would otherwise emit one log line per
 * download, per submission, forever. The latch is per-process and injectable so
 * a test can assert it fires exactly once without leaking state between cases.
 */
export function createLegacyPlaintextWarner(
  emit: (message: string) => void
): () => void {
  let warned = false;
  return () => {
    if (warned) return;
    warned = true;
    emit(
      'legacy plaintext fileUrlAuthConfig read; the row was not rewritten. ' +
        'Re-saving the profile migrates it to the iv:tag:ciphertext form.'
    );
  };
}

/** `type: 'none'` (and a null/undefined token) means "no auth to inject". */
export function fileUrlAuthConfigCarriesSecret(config: FileUrlAuthConfig | null): boolean {
  if (!config || config.type === 'none') return false;
  return Boolean(
    config.token ||
      (config.header_name && config.header_value) ||
      (config.query_key && config.query_value)
  );
}
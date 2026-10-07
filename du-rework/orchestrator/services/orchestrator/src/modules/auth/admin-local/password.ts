import { randomBytes, scrypt as scryptCallback } from 'node:crypto';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_PASSWORD_BYTES = 1024;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

declare const passwordHashBrand: unique symbol;

/** A self-describing scrypt hash. It is never returned by the user repository. */
export type LocalPasswordHash = string & { readonly [passwordHashBrand]: true };

function deriveKey(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      secret,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY_BYTES },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      }
    );
  });
}

/**
 * Hash a bootstrap secret with Node's built-in scrypt implementation.
 * This primitive deliberately has no password verification/comparison API;
 * LOCAL-02 owns that boundary.
 */
export async function hashLocalPassword(password: string): Promise<LocalPasswordHash> {
  const secret = Buffer.from(password, 'utf8');
  if (secret.length === 0 || secret.length > MAX_PASSWORD_BYTES) {
    secret.fill(0);
    throw new Error('password input is outside the supported size bounds');
  }

  const salt = randomBytes(SALT_LENGTH);
  try {
    const derivedKey = await deriveKey(secret, salt);
    try {
      return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}` as LocalPasswordHash;
    } finally {
      derivedKey.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}

/** Runtime guard used at the persistence boundary as well as by the schema. */
export function isLocalPasswordHash(value: string): value is LocalPasswordHash {
  return /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(value);
}

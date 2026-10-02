import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const HASH_ALGORITHM = 'scrypt';
// LOCAL-03 integration fix: the persisted admin_local_users encoding (LOCAL-01
// hashLocalPassword + migration 0023 CHECK) is `scrypt$32768$8$1$…`. The
// verifier must accept exactly that format or every stored credential fails
// closed. Parameters stay FIXED here — the encoding never selects KDF work.
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const MAX_PASSWORD_BYTES = 1_024;
const SCRYPT_MAX_MEMORY_BYTES = 64 * 1_024 * 1_024;

interface ParsedPasswordHash {
  salt: Buffer;
  digest: Buffer;
}

function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      DERIVED_KEY_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY_BYTES,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function decodeBase64Url(value: string | undefined, expectedBytes: number): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) return null;
  return decoded;
}

function parsePasswordHash(encodedHash: string): ParsedPasswordHash | null {
  const parts = encodedHash.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== HASH_ALGORITHM ||
    parts[1] !== String(SCRYPT_COST) ||
    parts[2] !== String(SCRYPT_BLOCK_SIZE) ||
    parts[3] !== String(SCRYPT_PARALLELIZATION)
  ) {
    return null;
  }

  const salt = decodeBase64Url(parts[4], SALT_BYTES);
  const digest = decodeBase64Url(parts[5], DERIVED_KEY_BYTES);
  if (!salt || !digest) return null;
  return { salt, digest };
}

/**
 * Derive a salted verifier for a local password. The input is only used during
 * derivation; callers must persist the returned verifier, never the password.
 */
export async function hashLocalPassword(password: string): Promise<string> {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') === 0 ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    throw new Error('Password input is invalid');
  }

  const salt = randomBytes(SALT_BYTES);
  const digest = await deriveKey(Buffer.from(password, 'utf8'), salt);
  return [
    HASH_ALGORITHM,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

/**
 * Verify against the fixed scrypt parameters above. Both valid and malformed
 * stored verifiers take the same derivation path; malformed records fail closed.
 */
export async function verifyLocalPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;

  const parsed = parsePasswordHash(encodedHash);
  const passwordBytes = Buffer.from(password, 'utf8');
  const passwordTooLong = passwordBytes.length > MAX_PASSWORD_BYTES;
  const derivationInput = passwordTooLong ? Buffer.alloc(0) : passwordBytes;
  const salt = parsed?.salt ?? Buffer.alloc(SALT_BYTES);
  const expectedDigest = parsed?.digest ?? Buffer.alloc(DERIVED_KEY_BYTES);

  try {
    const actualDigest = await deriveKey(derivationInput, salt);
    const matches = timingSafeEqual(actualDigest, expectedDigest);
    return parsed !== null && !passwordTooLong && passwordBytes.length > 0 && matches;
  } catch {
    return false;
  }
}

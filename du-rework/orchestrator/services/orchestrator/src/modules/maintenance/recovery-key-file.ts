import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EXTERNAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface BackupRecoveryKeyFilePin {
  filePath: string;
  escrowRef: string;
  keyVersion: string;
  fingerprintSha256: string;
}

export interface MaintenanceRecoveryKeyRegistryPin {
  filePath: string;
  sha256: string;
}

/** Backwards-compatible type alias; the pinned registry now covers several
 * independent runtime key providers, not only the Secret Catalog. */
export type SecretCatalogRecoveryKeyRegistryPin = MaintenanceRecoveryKeyRegistryPin;

type RegistryRecoveryPurpose = 'secret_catalog' | 'connector_invocation' | 'connector_credential';

interface MaintenanceRecoveryKeyEntry {
  purpose: RegistryRecoveryPurpose;
  escrowRef: string;
  keyVersion: string;
  fingerprintSha256: string;
  filePath: string;
  materialFormat: 'raw-32-byte-key' | 'base64-config';
}

export type MaintenanceRecoveryKeyPurpose = RegistryRecoveryPurpose | 'backup_bundle';

/** All four trusted pins are required together; none has a default. */
export function backupRecoveryKeyFilePinFromEnv(
  env: Record<string, string | undefined> = process.env,
): BackupRecoveryKeyFilePin | undefined {
  const names = [
    'DU_MAINTENANCE_RECOVERY_KEY_FILE',
    'DU_MAINTENANCE_RECOVERY_KEY_REF',
    'DU_MAINTENANCE_RECOVERY_KEY_VERSION',
    'DU_MAINTENANCE_RECOVERY_KEY_SHA256',
  ] as const;
  const values = names.map((name) => env[name]?.trim() || undefined);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error(`${names.join(', ')} must be configured together`);
  }
  const [filePath, escrowRef, keyVersion, fingerprintSha256] = values as [string, string, string, string];
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath
    || !EXTERNAL_REF.test(escrowRef) || !SAFE_VERSION.test(keyVersion) || !SHA256.test(fingerprintSha256)) {
    throw new Error('maintenance recovery key pins are invalid');
  }
  return { filePath, escrowRef, keyVersion, fingerprintSha256 };
}

/** Catalog encryption keys may have several retained versions. Their exact
 * escrow refs/fingerprints are supplied through one independently pinned,
 * root-owned registry file; Catalog DB/keyring state is never consulted. */
export function maintenanceRecoveryKeyRegistryPinFromEnv(
  env: Record<string, string | undefined> = process.env,
): MaintenanceRecoveryKeyRegistryPin | undefined {
  const pathName = 'DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_FILE';
  const digestName = 'DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_SHA256';
  const legacyPathName = 'DU_MAINTENANCE_SECRET_CATALOG_KEYS_FILE';
  const legacyDigestName = 'DU_MAINTENANCE_SECRET_CATALOG_KEYS_SHA256';
  const modern = Boolean(env[pathName]?.trim() || env[digestName]?.trim());
  const legacy = Boolean(env[legacyPathName]?.trim() || env[legacyDigestName]?.trim());
  if (modern && legacy) throw new Error('configure only one maintenance recovery key registry pin');
  const selectedPath = modern ? pathName : legacyPathName;
  const selectedDigest = modern ? digestName : legacyDigestName;
  const filePath = env[selectedPath]?.trim() || undefined;
  const sha256 = env[selectedDigest]?.trim() || undefined;
  if (!filePath && !sha256) return undefined;
  if (!filePath || !sha256) throw new Error(`${selectedPath} and ${selectedDigest} must be configured together`);
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || !SHA256.test(sha256)) {
    throw new Error('maintenance secret catalog recovery registry pin is invalid');
  }
  return { filePath, sha256 };
}

/** Backwards-compatible parser alias for earlier deployments. */
export const secretCatalogRecoveryKeyRegistryPinFromEnv = maintenanceRecoveryKeyRegistryPinFromEnv;

function deny(): Error {
  // Do not include the path, ref, or key material in a boot/runtime error.
  return new Error('MAINTENANCE_RECOVERY_KEY_UNAVAILABLE');
}

/**
 * Resolve only the single manifest-pinned recovery key version from a trusted
 * root-owned file. The file contains exactly 32 raw key bytes. Group-read is
 * allowed for a read-only service mount; group/world write and world-read are
 * rejected. No Catalog, environment-secret, or latest-version fallback exists.
 */
export function createBackupRecoveryKeyFileResolver(pin: BackupRecoveryKeyFilePin) {
  return createMaintenanceRecoveryKeyResolver({ backupBundle: pin });
}

async function readRootOwnedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  if (path.resolve(filePath) !== filePath || await realpath(filePath) !== filePath) throw deny();
  const file = await lstat(filePath);
  const parent = await lstat(path.dirname(filePath));
  const forbiddenWrites = fsConstants.S_IWGRP | fsConstants.S_IWOTH;
  if (!file.isFile() || file.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
    || file.uid !== 0 || parent.uid !== 0
    || (file.mode & forbiddenWrites) !== 0 || (parent.mode & forbiddenWrites) !== 0
    || (file.mode & fsConstants.S_IROTH) !== 0 || (file.mode & fsConstants.S_IRUSR) === 0
    || file.size < 1 || file.size > maxBytes) throw deny();
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino || opened.size !== file.size
      || opened.uid !== 0 || (opened.mode & forbiddenWrites) !== 0 || (opened.mode & fsConstants.S_IROTH) !== 0) throw deny();
    return await handle.readFile();
  } finally { await handle.close(); }
}

function parseSecretCatalogRegistry(bytes: Buffer): MaintenanceRecoveryKeyEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw deny(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw deny();
  const root = raw as Record<string, unknown>;
  if (root['version'] !== 2 || !Array.isArray(root['keys']) || root['keys'].length > 256
    || Object.keys(root).some((key) => key !== 'version' && key !== 'keys')) throw deny();
  const entries: MaintenanceRecoveryKeyEntry[] = [];
  const identities = new Set<string>();
  for (const candidate of root['keys']) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw deny();
    const value = candidate as Record<string, unknown>;
    const purpose = value['purpose'];
    const format = purpose === 'connector_credential' ? 'base64-config' : 'raw-32-byte-key';
    const expectedKeys = purpose === 'connector_credential'
      ? ['purpose', 'escrowRef', 'keyVersion', 'fingerprintSha256', 'filePath', 'materialFormat']
      : ['purpose', 'escrowRef', 'keyVersion', 'fingerprintSha256', 'filePath'];
    if (Object.keys(value).length !== expectedKeys.length
      || Object.keys(value).some((key) => !expectedKeys.includes(key))
      || !['secret_catalog', 'connector_invocation', 'connector_credential'].includes(String(purpose))
      || typeof value['escrowRef'] !== 'string' || !EXTERNAL_REF.test(value['escrowRef'])
      || typeof value['keyVersion'] !== 'string' || !SAFE_VERSION.test(value['keyVersion'])
      || typeof value['fingerprintSha256'] !== 'string' || !SHA256.test(value['fingerprintSha256'])
      || typeof value['filePath'] !== 'string' || !path.isAbsolute(value['filePath']) || path.normalize(value['filePath']) !== value['filePath']
      || (purpose === 'connector_credential' && value['materialFormat'] !== format)) {
      throw deny();
    }
    const identity = `${purpose}\0${value['escrowRef']}\0${value['keyVersion']}`;
    if (identities.has(identity)) throw deny();
    identities.add(identity);
    entries.push({
      purpose: purpose as RegistryRecoveryPurpose, escrowRef: value['escrowRef'], keyVersion: value['keyVersion'],
      fingerprintSha256: value['fingerprintSha256'], filePath: value['filePath'], materialFormat: format,
    });
  }
  return entries;
}

async function readKeyFile(filePath: string, fingerprintSha256: string): Promise<Buffer> {
  const key = await readRootOwnedFile(filePath, 32);
  if (key.length !== 32 || createHash('sha256').update(key).digest('hex') !== fingerprintSha256) {
    key.fill(0);
    throw deny();
  }
  return key;
}

async function readBase64ConfigFile(filePath: string, fingerprintSha256: string): Promise<Buffer> {
  const value = await readRootOwnedFile(filePath, 512);
  const text = value.toString('utf8');
  const decoded = Buffer.from(text, 'base64');
  if (Buffer.from(text, 'utf8').compare(value) !== 0
    || !/^[A-Za-z0-9+/]{43}=$/.test(text)
    || decoded.length !== 32
    || decoded.toString('base64') !== text
    || createHash('sha256').update(value).digest('hex') !== fingerprintSha256) {
    value.fill(0);
    decoded.fill(0);
    throw deny();
  }
  decoded.fill(0);
  return value;
}

/** Create the shared maintenance callback, scoped to two explicitly named
 * key purposes. A Catalog archive key can never stand in for the bundle key. */
export function createMaintenanceRecoveryKeyResolver(input: {
  backupBundle?: BackupRecoveryKeyFilePin;
  secretCatalogRegistry?: MaintenanceRecoveryKeyRegistryPin;
}) {
  return async (request: { purpose: MaintenanceRecoveryKeyPurpose; escrowRef: string; keyVersion: string }): Promise<Buffer> => {
    try {
      if (request.purpose === 'backup_bundle') {
        const pin = input.backupBundle;
        if (!pin || request.escrowRef !== pin.escrowRef || request.keyVersion !== pin.keyVersion) throw deny();
        return await readKeyFile(pin.filePath, pin.fingerprintSha256);
      }
      const registryPin = input.secretCatalogRegistry;
      if (!registryPin) throw deny();
      const registryBytes = await readRootOwnedFile(registryPin.filePath, 256 * 1024);
      try {
        if (createHash('sha256').update(registryBytes).digest('hex') !== registryPin.sha256) throw deny();
        const entry = parseSecretCatalogRegistry(registryBytes).find((candidate) =>
          candidate.purpose === request.purpose && candidate.escrowRef === request.escrowRef && candidate.keyVersion === request.keyVersion);
        if (!entry) throw deny();
        return entry.materialFormat === 'base64-config'
          ? await readBase64ConfigFile(entry.filePath, entry.fingerprintSha256)
          : await readKeyFile(entry.filePath, entry.fingerprintSha256);
      } finally { registryBytes.fill(0); }
    } catch {
      throw deny();
    }
  };
}

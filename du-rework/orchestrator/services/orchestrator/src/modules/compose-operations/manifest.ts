import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ComposeCatalogRelease, ComposeCatalogService } from './contracts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SAFE_SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const COMPOSE_PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/i;
const IMAGE_DIGEST = /^.+@sha256:[a-f0-9]{64}$/i;
const MAX_MANIFEST_BYTES = 256 * 1024;

const absolutePath = z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && path.normalize(value) === value, 'path must be canonical and absolute');
const sha256 = z.string().regex(SHA256, 'expected a SHA-256 digest');
const filePin = z.object({ path: absolutePath, sha256 }).strict();
const serviceId = z.string().regex(SAFE_SERVICE_ID);

const serviceSchema = z.object({
  serviceId,
  label: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();

const releaseSchema = z.object({
  releaseId: z.string().regex(SAFE_ID),
  label: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  composeFiles: z.array(filePin).min(1).max(8),
  serviceIds: z.array(serviceId).min(1).max(32),
  imageDigests: z.record(serviceId, z.string().regex(IMAGE_DIGEST)),
  migrationCompatibility: z.literal('acknowledged'),
  rollbackAllowedFrom: z.array(z.string().regex(SAFE_ID)).max(32),
}).strict().superRefine((release, context) => {
  if (new Set(release.serviceIds).size !== release.serviceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceIds'], message: 'serviceIds must be unique' });
  }
  const imageServiceIds = Object.keys(release.imageDigests).sort();
  if (imageServiceIds.join('\0') !== [...release.serviceIds].sort().join('\0')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['imageDigests'], message: 'every target service must have exactly one pinned image digest' });
  }
  if (new Set(release.rollbackAllowedFrom).size !== release.rollbackAllowedFrom.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rollbackAllowedFrom'], message: 'rollbackAllowedFrom must be unique' });
  }
});

export const composeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().regex(SAFE_ID),
  projectId: z.string().regex(COMPOSE_PROJECT_ID),
  displayName: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  dockerBinary: absolutePath,
  dockerContext: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  workingDirectory: absolutePath,
  homeDirectory: absolutePath,
  dockerConfigDirectory: absolutePath,
  inventoryComposeFiles: z.array(filePin).min(1).max(8),
  envFile: filePin.optional(),
  applicationServices: z.array(serviceSchema).min(1).max(32),
  releases: z.array(releaseSchema).min(1).max(64),
}).strict().superRefine((manifest, context) => {
  const serviceIds = manifest.applicationServices.map(({ serviceId: id }) => id);
  if (new Set(serviceIds).size !== serviceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['applicationServices'], message: 'application service identifiers must be unique' });
  }
  const releaseIds = manifest.releases.map(({ releaseId }) => releaseId);
  if (new Set(releaseIds).size !== releaseIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['releases'], message: 'release identifiers must be unique' });
  }
  const releaseSet = new Set(releaseIds);
  manifest.releases.forEach((release, index) => {
    if (release.serviceIds.some((id) => !serviceIds.includes(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['releases', index, 'serviceIds'], message: 'release target must be an allowlisted application service' });
    }
    if (release.rollbackAllowedFrom.some((id) => !releaseSet.has(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['releases', index, 'rollbackAllowedFrom'], message: 'rollback source must be present in the approved catalog' });
    }
    if (release.rollbackAllowedFrom.includes(release.releaseId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['releases', index, 'rollbackAllowedFrom'], message: 'a release cannot approve itself as a rollback source' });
    }
  });
});

export type ComposeManifest = z.infer<typeof composeManifestSchema>;
export type ComposeRelease = ComposeManifest['releases'][number];

export interface LoadedComposeManifest {
  readonly manifest: ComposeManifest;
  readonly sha256: string;
  readonly path: string;
}

export class ManifestValidationError extends Error {
  constructor(readonly code: 'manifest_unavailable' | 'manifest_invalid' | 'manifest_digest_mismatch' | 'manifest_file_changed') {
    super(code);
    this.name = 'ManifestValidationError';
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedDigest(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length).toLowerCase() : value.toLowerCase();
}

function noGroupOrWorldWrite(mode: number): boolean {
  return (mode & (fsConstants.S_IWGRP | fsConstants.S_IWOTH)) === 0;
}

async function assertRootOwnedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  try {
    const canonical = path.resolve(filePath);
    if (canonical !== filePath || await realpath(filePath) !== filePath) throw new ManifestValidationError('manifest_invalid');

    const target = await lstat(filePath);
    const parentPath = path.dirname(filePath);
    const parent = await lstat(parentPath);
    const details = await stat(filePath);
    if (!target.isFile() || target.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
      || details.uid !== 0 || parent.uid !== 0 || !noGroupOrWorldWrite(details.mode) || !noGroupOrWorldWrite(parent.mode)
      || details.size < 1 || details.size > maxBytes) {
      throw new ManifestValidationError('manifest_invalid');
    }

    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== details.ino || opened.dev !== details.dev) throw new ManifestValidationError('manifest_file_changed');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('manifest_unavailable');
  }
}

async function hashRootOwnedFile(filePath: string, maxBytes: number): Promise<string> {
  try {
    const canonical = path.resolve(filePath);
    if (canonical !== filePath || await realpath(filePath) !== filePath) throw new ManifestValidationError('manifest_invalid');
    const target = await lstat(filePath);
    const parent = await lstat(path.dirname(filePath));
    const details = await stat(filePath);
    if (!target.isFile() || target.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
      || details.uid !== 0 || parent.uid !== 0 || !noGroupOrWorldWrite(details.mode) || !noGroupOrWorldWrite(parent.mode)
      || details.size < 1 || details.size > maxBytes) {
      throw new ManifestValidationError('manifest_invalid');
    }
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== details.ino || opened.dev !== details.dev || opened.size !== details.size) {
        throw new ManifestValidationError('manifest_file_changed');
      }
      const hasher = createHash('sha256');
      let bytesRead = 0;
      const stream = createReadStream(filePath, { fd: handle.fd, autoClose: false });
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += bytes.length;
        if (bytesRead > maxBytes) {
          stream.destroy();
          throw new ManifestValidationError('manifest_file_changed');
        }
        hasher.update(bytes);
      }
      if (bytesRead !== details.size) throw new ManifestValidationError('manifest_file_changed');
      return hasher.digest('hex');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('manifest_unavailable');
  }
}

async function assertTrustedDirectory(directoryPath: string): Promise<void> {
  try {
    if (path.resolve(directoryPath) !== directoryPath || await realpath(directoryPath) !== directoryPath) {
      throw new ManifestValidationError('manifest_invalid');
    }
    const target = await lstat(directoryPath);
    if (!target.isDirectory() || target.isSymbolicLink() || target.uid !== 0 || !noGroupOrWorldWrite(target.mode)) {
      throw new ManifestValidationError('manifest_invalid');
    }
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('manifest_unavailable');
  }
}

export async function validateManifestFiles(manifest: ComposeManifest): Promise<void> {
  try {
    const dockerRealPath = await realpath(manifest.dockerBinary);
    const dockerInfo = await lstat(manifest.dockerBinary);
    const dockerStat = await stat(manifest.dockerBinary);
    if (dockerRealPath !== manifest.dockerBinary || !dockerInfo.isFile() || dockerInfo.isSymbolicLink()
      || dockerStat.uid !== 0 || !noGroupOrWorldWrite(dockerStat.mode)
      || (dockerStat.mode & (fsConstants.S_IXUSR | fsConstants.S_IXGRP | fsConstants.S_IXOTH)) === 0) {
      throw new ManifestValidationError('manifest_invalid');
    }
    await assertTrustedDirectory(path.dirname(manifest.dockerBinary));
    await access(manifest.dockerBinary, fsConstants.X_OK);
    for (const directory of [manifest.workingDirectory, manifest.homeDirectory, manifest.dockerConfigDirectory]) {
      await assertTrustedDirectory(directory);
    }
    const pins = [
      ...manifest.inventoryComposeFiles,
      ...(manifest.envFile ? [manifest.envFile] : []),
      ...manifest.releases.flatMap((release) => release.composeFiles),
    ];
    const seenPaths = new Map<string, string>();
    for (const pin of pins) {
      const previous = seenPaths.get(pin.path);
      if (previous && previous !== expectedDigest(pin.sha256)) throw new ManifestValidationError('manifest_invalid');
      seenPaths.set(pin.path, expectedDigest(pin.sha256));
    }
    for (const [pinnedPath, pinnedHash] of seenPaths) {
      if (await hashRootOwnedFile(pinnedPath, 16 * 1024 * 1024) !== pinnedHash) throw new ManifestValidationError('manifest_file_changed');
    }
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('manifest_unavailable');
  }
}

export async function loadComposeManifest(manifestPath: string, expectedSha256: string): Promise<LoadedComposeManifest> {
  let bytes: Buffer;
  try {
    bytes = await assertRootOwnedFile(manifestPath, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('manifest_unavailable');
  }
  const actualSha256 = digest(bytes);
  if (!SHA256.test(expectedSha256) || actualSha256 !== expectedDigest(expectedSha256)) {
    throw new ManifestValidationError('manifest_digest_mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ManifestValidationError('manifest_invalid');
  }
  const checked = composeManifestSchema.safeParse(parsed);
  if (!checked.success) throw new ManifestValidationError('manifest_invalid');
  await validateManifestFiles(checked.data);
  return { manifest: checked.data, sha256: actualSha256, path: manifestPath };
}

export async function reloadAndCheckManifest(expected: LoadedComposeManifest): Promise<LoadedComposeManifest> {
  const reloaded = await loadComposeManifest(expected.path, expected.sha256);
  if (reloaded.manifest.hostId !== expected.manifest.hostId || reloaded.manifest.projectId !== expected.manifest.projectId) {
    throw new ManifestValidationError('manifest_digest_mismatch');
  }
  return reloaded;
}

export function getComposeRelease(manifest: ComposeManifest, releaseId: string): ComposeRelease | undefined {
  return manifest.releases.find((release) => release.releaseId === releaseId);
}

function canonicalReleaseBytes(release: ComposeRelease): string {
  const files = [...release.composeFiles]
    .map(({ path: filePath, sha256: fileSha }) => ({ path: filePath, sha256: expectedDigest(fileSha) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const images = Object.entries(release.imageDigests).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    releaseId: release.releaseId,
    label: release.label,
    composeFiles: files,
    serviceIds: [...release.serviceIds].sort(),
    imageDigests: images,
    migrationCompatibility: release.migrationCompatibility,
    rollbackAllowedFrom: [...release.rollbackAllowedFrom].sort(),
  });
}

export function composeReleaseDigest(release: ComposeRelease): string {
  return createHash('sha256').update(canonicalReleaseBytes(release)).digest('hex');
}

export function toCatalogServices(manifest: ComposeManifest): ComposeCatalogService[] {
  return manifest.applicationServices.map(({ serviceId, label }) => ({
    serviceId,
    displayName: label,
    restartAllowed: true,
  }));
}

export function toCatalogReleases(manifest: ComposeManifest): ComposeCatalogRelease[] {
  return manifest.releases.map((release) => ({
    releaseId: release.releaseId,
    displayName: release.label,
    releaseDigest: composeReleaseDigest(release),
    targetServices: [...release.serviceIds].sort(),
    images: Object.entries(release.imageDigests)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([serviceId, imageDigest]) => ({ serviceId, imageDigest })),
    migrationCompatibility: release.migrationCompatibility,
    rollbackAllowedFrom: [...release.rollbackAllowedFrom].sort(),
  }));
}

export function isSafeComposeServiceId(value: string): boolean {
  return SAFE_SERVICE_ID.test(value);
}

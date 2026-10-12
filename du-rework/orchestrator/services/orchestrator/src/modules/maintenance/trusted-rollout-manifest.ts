import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { MaintenanceScope } from '@du/contracts';

export const ROLLOUT_SHA256 = /^[a-f0-9]{64}$/;
const SafeId = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const AbsolutePath = z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const FilePin = z.object({ path: AbsolutePath, sha256: z.string().regex(ROLLOUT_SHA256) }).strict();
const IngressProbeUrl = z.string().min(1).max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const DirectControlUrl = z.string().min(1).max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const SlotSchema = z.object({
  projectName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  serviceId: SafeId,
  runtimeIdentity: SafeId,
  revision: SafeId,
  imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i),
  controlBaseUrl: DirectControlUrl.optional(),
  workerBusinessId: SafeId.optional(),
}).strict();
const ReleaseSchema = z.object({
  revision: SafeId,
  slots: z.object({
    blue: z.object({ composeFiles: z.array(FilePin).min(1).max(8), imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i) }).strict(),
    green: z.object({ composeFiles: z.array(FilePin).min(1).max(8), imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i) }).strict(),
  }).strict(),
}).strict();
const TargetSchema = z.object({
  service: z.enum(['orchestrator', 'connector', 'worker']),
  slots: z.object({ blue: SlotSchema, green: SlotSchema }).strict(),
  releases: z.array(ReleaseSchema).min(1).max(128),
  selectorFile: AbsolutePath.optional(),
  fixedIngressProbeUrl: IngressProbeUrl.optional(),
  reloadExecutable: AbsolutePath.optional(),
  reloadExecutableSha256: z.string().regex(ROLLOUT_SHA256).optional(),
  reloadArgs: z.array(z.string().max(256)).max(32).optional(),
}).strict().superRefine((target, ctx) => {
  if (target.service === 'worker' && (target.selectorFile || target.fixedIngressProbeUrl || target.reloadExecutable || target.reloadExecutableSha256 || target.reloadArgs
    || target.slots.blue.controlBaseUrl || target.slots.green.controlBaseUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectorFile'], message: 'worker replacement has no HTTP ingress selector or reload process' });
  }
  if (target.service !== 'worker' && (!target.selectorFile || !target.fixedIngressProbeUrl || !target.reloadExecutable || !target.reloadExecutableSha256 || !target.reloadArgs)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectorFile'], message: 'Orchestrator and Connector require a fixed ingress selector, probe, and reload process' });
  }
  if (target.service !== 'worker' && (!target.slots.blue.controlBaseUrl || !target.slots.green.controlBaseUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: 'Orchestrator and Connector require direct per-slot runtime control endpoints' });
  }
  if (target.slots.blue.projectName === target.slots.green.projectName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: 'blue and green projects must be distinct' });
  }
  if (target.slots.blue.serviceId !== target.slots.green.serviceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: 'slot service ids must be stable' });
  }
  if (target.slots.blue.runtimeIdentity === target.slots.green.runtimeIdentity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: 'slot runtime identities must be distinct' });
  }
  if (target.service === 'worker' && (!target.slots.blue.workerBusinessId || !target.slots.green.workerBusinessId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: 'worker slots require explicit business identities' });
  }
  if (target.service !== 'worker' && (target.slots.blue.workerBusinessId || target.slots.green.workerBusinessId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: 'only worker slots may bind a worker business' });
  }
  if (new Set(target.releases.map((entry) => entry.revision)).size !== target.releases.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['releases'], message: 'release revisions must be unique' });
  }
});
export const TrustedRolloutManifestSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: SafeId,
  dockerBinary: AbsolutePath,
  dockerSha256: z.string().regex(ROLLOUT_SHA256),
  dockerContext: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  workingDirectory: AbsolutePath,
  homeDirectory: AbsolutePath,
  dockerConfigDirectory: AbsolutePath,
  targets: z.array(TargetSchema).min(1).max(3),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.targets.map((target) => target.service)).size !== manifest.targets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targets'], message: 'deployment services must be unique' });
  }
});

export type TrustedRolloutManifest = z.infer<typeof TrustedRolloutManifestSchema>;
export type TrustedRolloutService = TrustedRolloutManifest['targets'][number]['service'];
export type TrustedRolloutTarget = TrustedRolloutManifest['targets'][number];
export type TrustedRolloutSlot = 'blue' | 'green';

function noGroupOrWorldWrite(mode: number): boolean {
  return (mode & (fsConstants.S_IWGRP | fsConstants.S_IWOTH)) === 0;
}

export async function readTrustedRolloutFile(filePath: string, expectedSha256?: string, maxBytes = 1024 * 1024): Promise<Buffer> {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || await realpath(filePath) !== filePath) throw new Error('ROLLOUT_MANIFEST_UNTRUSTED');
  const target = await lstat(filePath);
  const parentPath = path.dirname(filePath);
  const parent = await lstat(parentPath);
  const details = await stat(filePath);
  if (!target.isFile() || target.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()
    || details.uid !== 0 || parent.uid !== 0 || !noGroupOrWorldWrite(details.mode) || !noGroupOrWorldWrite(parent.mode)
    || details.size < 1 || details.size > maxBytes) throw new Error('ROLLOUT_MANIFEST_UNTRUSTED');
  const file = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino || opened.size !== details.size) throw new Error('ROLLOUT_MANIFEST_CHANGED');
    const bytes = await file.readFile();
    if (expectedSha256 && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('ROLLOUT_MANIFEST_DIGEST_MISMATCH');
    return bytes;
  } finally { await file.close(); }
}

export async function readTrustedRolloutManifest(input: { manifestPath: string; expectedManifestSha256: string }): Promise<TrustedRolloutManifest> {
  if (!ROLLOUT_SHA256.test(input.expectedManifestSha256)) throw new Error('ROLLOUT_MANIFEST_DIGEST_INVALID');
  const bytes = await readTrustedRolloutFile(input.manifestPath, input.expectedManifestSha256);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Error('ROLLOUT_MANIFEST_INVALID'); }
  const parsed = TrustedRolloutManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('ROLLOUT_MANIFEST_INVALID');
  return parsed.data;
}

export function rolloutTargetFor(manifest: TrustedRolloutManifest, service: string, scope: MaintenanceScope): TrustedRolloutTarget {
  if (scope.kind !== 'platform') throw new Error('ROLLOUT_SCOPE_NOT_ALLOWLISTED');
  const target = manifest.targets.find((entry) => entry.service === service);
  if (!target) throw new Error('ROLLOUT_TARGET_NOT_ALLOWLISTED');
  return target;
}

export function rolloutReleaseFor(target: TrustedRolloutTarget, revision: string) {
  const release = target.releases.find((entry) => entry.revision === revision);
  if (!release) throw new Error('ROLLOUT_REVISION_NOT_ALLOWLISTED');
  return release;
}

export function rolloutSafeSlot(value: string): TrustedRolloutSlot {
  if (value === 'blue' || value === 'green') return value;
  throw new Error('ROLLOUT_SLOT_INVALID');
}

export function rolloutImageMatches(observed: string, expected: string): boolean {
  return observed.toLowerCase() === expected.toLowerCase();
}

/** Resolve worker business bindings from the exact pinned manifest without
 * importing the host-side command runner. */
export async function readWorkerReplicaBusinessMap(input: {
  manifestPath: string;
  expectedManifestSha256: string;
}): Promise<Record<string, string>> {
  const manifest = await readTrustedRolloutManifest(input);
  const result: Record<string, string> = {};
  for (const target of manifest.targets) {
    if (target.service !== 'worker') continue;
    for (const slot of ['blue', 'green'] as const) {
      const config = target.slots[slot];
      if (!config.workerBusinessId) throw new Error('ROLLOUT_WORKER_BUSINESS_BINDING_MISSING');
      if (Object.hasOwn(result, config.runtimeIdentity)) throw new Error('ROLLOUT_WORKER_IDENTITY_DUPLICATE');
      result[config.runtimeIdentity] = config.workerBusinessId;
    }
  }
  return result;
}

/** Return only deployment-owned fixed ingress probe URLs; no executable or
 * filesystem selector details are included in the projection. */
export async function readFixedIngressProbeUrlMap(input: {
  manifestPath: string;
  expectedManifestSha256: string;
}): Promise<Partial<Record<TrustedRolloutService, string>>> {
  const manifest = await readTrustedRolloutManifest(input);
  return Object.fromEntries(manifest.targets.flatMap((target) => target.fixedIngressProbeUrl
    ? [[target.service, target.fixedIngressProbeUrl] as const]
    : []));
}

export interface ReplicaRuntimeControlTarget {
  serviceId: string;
  runtimeIdentity: string;
  controlBaseUrl: string;
  revision: string;
  imageDigest: string;
}

/** Return exact direct per-slot service-control endpoints from the pinned
 * manifest. Callers still authenticate and validate each responder. */
export async function readReplicaRuntimeControlTargets(input: {
  manifestPath: string;
  expectedManifestSha256: string;
}): Promise<Partial<Record<TrustedRolloutService, Partial<Record<TrustedRolloutSlot, ReplicaRuntimeControlTarget>>>>> {
  const manifest = await readTrustedRolloutManifest(input);
  const result: Partial<Record<TrustedRolloutService, Partial<Record<TrustedRolloutSlot, ReplicaRuntimeControlTarget>>>> = {};
  for (const target of manifest.targets) {
    const slots: Partial<Record<TrustedRolloutSlot, ReplicaRuntimeControlTarget>> = {};
    for (const slot of ['blue', 'green'] as const) {
      const config = target.slots[slot];
      if (config.controlBaseUrl) slots[slot] = {
        serviceId: config.serviceId,
        runtimeIdentity: config.runtimeIdentity,
        controlBaseUrl: config.controlBaseUrl,
        revision: config.revision,
        imageDigest: config.imageDigest,
      };
    }
    result[target.service] = slots;
  }
  return result;
}

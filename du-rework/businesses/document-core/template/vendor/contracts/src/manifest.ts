// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/contracts/src/manifest.ts (lines=114) sha256=64C823443654ED8324F9D18BE77DD1519A9C1D3FD815680D53A6B81F382D68F7
// why: BusinessManifest, ActionManifest, ConnectorSlotManifest for src/manifest/document-core.manifest.ts

import { z } from 'zod';
import { WIRE_CONTRACT_VERSION, SCHEMA_LIMITS } from './version';

/**
 * Business registry manifest contract v1 (docs 05).
 * The shape matches what @du/document-core already publishes so the gate
 * freezes names peers can import exactly.
 */

export const JsonSchemaLiteral = z
  .record(z.string(), z.unknown())
  .refine((s) => typeof s === 'object' && s !== null, 'JSON Schema must be an object');

export const ConnectorSlotManifestSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  acceptedCapabilities: z.array(z.string().min(1)).min(1),
  allowedModelOptions: z.array(z.string()).optional(),
  promptConfigSchema: z.record(z.string(), z.unknown()).optional(),
});
export type ConnectorSlotManifest = z.infer<typeof ConnectorSlotManifestSchema>;

export const ArtifactPolicySchema = z.object({
  minFiles: z.number().int().min(0),
  maxFiles: z.number().int().min(0),
  acceptedMimeTypes: z.array(z.string()).optional(),
});
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

export const ActionManifestSchema = z.object({
  name: z.string().min(1), // stable lowercase slug
  displayName: z.string().min(1),
  description: z.string().default(''),
  inputSchema: JsonSchemaLiteral,
  outputSchema: JsonSchemaLiteral,
  profileSchema: JsonSchemaLiteral,
  uiSchema: z.record(z.string(), z.unknown()).optional(),
  connectorSlots: z.array(ConnectorSlotManifestSchema).default([]),
  artifactPolicy: ArtifactPolicySchema,
  capabilities: z.object({ cancel: z.boolean(), resume: z.boolean() }),
  defaultLimits: z.object({
    maxParallelTasks: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
  }),
});
export type ActionManifest = z.infer<typeof ActionManifestSchema>;

export const BusinessManifestSchema = z.object({
  contractVersion: z.literal(WIRE_CONTRACT_VERSION),
  businessId: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'businessId must be a lowercase slug'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, 'exact semver required'),
  displayName: z.string().min(1),
  description: z.string().default(''),
  imageDigest: z.string().min(1), // sha256:<hex> provenance
  runtime: z.object({
    wireVersion: z.literal('1'),
    handlerKinds: z.array(z.string().min(1)).min(1),
  }),
  capabilities: z.object({
    cancel: z.boolean(),
    resume: z.boolean(),
    parallel: z.boolean(),
  }),
  actions: z.array(ActionManifestSchema).min(1),
});
export type BusinessManifest = z.infer<typeof BusinessManifestSchema>;

/** Registry statuses (docs 05). */
export const BusinessStatus = [
  'REGISTERED_DISABLED',
  'ENABLED',
  'DRAINING',
  'RETIRED',
] as const;
export type BusinessStatus = (typeof BusinessStatus)[number];

export const BusinessStatusSchema = z.enum(BusinessStatus);

/** Worker health (docs 05). */
export const WorkerHealth = ['HEALTHY', 'DEGRADED', 'OFFLINE'] as const;
export type WorkerHealth = (typeof WorkerHealth)[number];

export const RegistrationRecordSchema = z.object({
  businessId: z.string(),
  version: z.string(),
  contractVersion: z.literal(WIRE_CONTRACT_VERSION),
  digest: z.string(),
  manifest: BusinessManifestSchema,
  status: BusinessStatusSchema,
  queue: z.string(), // du-business-{businessId}-{version}
  registeredAt: z.string(), // RFC3339
});
export type RegistrationRecord = z.infer<typeof RegistrationRecordSchema>;

/** Manifest validation outcome carrying structured problems. */
export interface ManifestValidation {
  ok: true;
  manifest: BusinessManifest;
  digest: string;
  queue: string;
  canonicalJson: string;
}

export interface ManifestValidationFailure {
  ok: false;
  problems: { pointer: string; message: string }[];
}

export type ManifestValidationResult = ManifestValidation | ManifestValidationFailure;
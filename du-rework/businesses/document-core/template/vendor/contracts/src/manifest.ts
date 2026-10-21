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

/**
 * PC-01 / plan §"Manifest parameter and lock resolution" item 2 — opt-in,
 * immutable per-action capability declaring which source owns each parameter
 * property. Absence means v1 semantics exactly: nothing is inferred from the
 * intentional `inputSchema`/`profileSchema` overlap, and no schema default is
 * applied.
 *
 * `version: 2` is a literal on purpose: a future semantic change must register
 * a new manifest version rather than reinterpret stored configuration.
 */
export const ParameterResolutionSourceSchema = z.enum([
  'requestDefaults',
  'profileSettings',
]);
export type ParameterResolutionSource = z.infer<typeof ParameterResolutionSourceSchema>;

export const ParameterResolutionCapabilitySchema = z
  .object({
    version: z.literal(2),
    /** Declared property -> the single source that owns it. */
    fields: z.record(z.string().min(1).max(128), ParameterResolutionSourceSchema),
    /** When true, `inputSchema.properties.<name>.default` fills absent top-level fields. */
    applyTopLevelDefaults: z.boolean(),
  })
  .strict();
export type ParameterResolutionCapability = z.infer<
  typeof ParameterResolutionCapabilitySchema
>;

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
  /** PC-01: opt-in parameter source mapping; absent = v1 semantics (§ above). */
  parameterResolution: ParameterResolutionCapabilitySchema.optional(),
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
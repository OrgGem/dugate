// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/contracts/src/version.ts (lines=38) sha256=490DA72632B9DB65A3C551928DD245C53CDF371CB34E85C7A3A7363E24AFD43F
// why: WIRE_CONTRACT_VERSION + SCHEMA_LIMITS for manifest.ts

/**
 * Wire contract versioning constants.
 * A breaking DTO change bumps the major; wire v1 remains consumable by SDKs
 * declaring compatible ranges until the retirement policy is triggered.
 */

export const WIRE_CONTRACT_VERSION = '1' as const;
export type WireContractVersion = typeof WIRE_CONTRACT_VERSION;

/**
 * Supported wire major versions. Anything else is rejected at the boundary
 * ("unsupported major bị từ chối" — REG-02).
 */
export const SUPPORTED_WIRE_MAJORS = [1] as const;
export type SupportedWireMajor = (typeof SUPPORTED_WIRE_MAJORS)[number];

/** JSON Schema dialect accepted for manifest action schemas. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const;

/** Schema size/depth guards (P1-02, REG-02): v1 limits, config-driven later. */
export const SCHEMA_LIMITS = {
  /** Max serialized bytes for a single action input/output schema. */
  maxSchemaBytes: 100_000,
  /** Max $ref chain depth (local refs only). Network refs are rejected outright. */
  maxRefDepth: 5,
  /** Max properties in a single object schema. */
  maxProperties: 200,
  /** Max total schema nodes across the manifest. */
  maxManifestSchemaNodes: 2_000,
} as const;

/** Retention window default (P0): dedup/checkpoint/ledger not deleted earlier. */
export const RETENTION_DEFAULTS = {
  submissionKeyMs: 30 * 24 * 3600 * 1000, // 30 days
  artifactStagingMs: 24 * 3600 * 1000, // 24h staging TTL
  artifactActiveMs: 30 * 24 * 3600 * 1000, // 30 days active artifact
  usageReplayMs: 7 * 24 * 3600 * 1000,
} as const;
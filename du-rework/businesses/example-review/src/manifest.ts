import {
  BusinessManifest,
  WIRE_CONTRACT_VERSION,
} from '@du/contracts';

export const exampleReviewManifest: BusinessManifest = {
  contractVersion: WIRE_CONTRACT_VERSION,
  businessId: 'example-review',
  version: '1.0.0',
  displayName: 'Example Review Business',
  description:
    'Extension proof business for multi-artifact document review with bounded child tasks, optional reasoning, and approval wait.',
  imageDigest:
    'sha256:d470b00cbfe2008556f343fcb79829567ed5e2ff702fc58e18f3e5640de48540',
  runtime: {
    wireVersion: '1',
    handlerKinds: ['review', 'review-item', 'root'],
  },
  capabilities: {
    cancel: true,
    resume: true,
    parallel: true,
  },
  actions: [
    {
      name: 'review',
      displayName: 'Review Documents',
      description:
        'Reviews 1..10 document artifacts with bounded child review tasks, optional reasoning, and optional approval wait.',
      inputSchema: {
        type: 'object',
        properties: {
          reviewId: { type: 'string', minLength: 1, maxLength: 128 },
          artifacts: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                artifactId: { type: 'string', minLength: 1 },
                fileName: { type: 'string', minLength: 1 },
              },
              required: ['artifactId'],
              additionalProperties: false,
            },
          },
          checks: {
            type: 'object',
            additionalProperties: { type: 'boolean' },
          },
          requireApproval: { type: 'boolean' },
          enableReasoning: { type: 'boolean' },
        },
        required: ['reviewId', 'artifacts'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          reviewsRef: { type: 'string' },
          reviewId: { type: 'string' },
          itemCount: { type: 'integer', minimum: 1, maximum: 10 },
          failedChecks: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
        required: ['approved', 'reviewsRef', 'reviewId', 'itemCount'],
        additionalProperties: false,
      },
      profileSchema: {
        type: 'object',
        properties: {
          enableReasoning: { type: 'boolean' },
          maxParallelItems: { type: 'integer', minimum: 1, maximum: 10 },
          autoApprovePassed: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      connectorSlots: [
        {
          name: 'reasoning',
          required: false,
          acceptedCapabilities: ['chat-completion', 'structured-output'],
        },
      ],
      artifactPolicy: {
        minFiles: 1,
        maxFiles: 10,
        acceptedMimeTypes: [
          'application/json',
          'text/plain',
          'application/pdf',
          'application/octet-stream',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ],
      },
      capabilities: {
        cancel: true,
        resume: true,
      },
      defaultLimits: {
        maxParallelTasks: 4,
        timeoutSeconds: 300,
      },
    },
  ],
};

/**
 * Manifest for version 2.0.0 (P7-06 / VER-01).
 * Features distinguishable version, displayName, and imageDigest.
 */
export const exampleReviewManifestV2: BusinessManifest = {
  ...exampleReviewManifest,
  version: '2.0.0',
  displayName: 'Example Review Business v2',
  description:
    'Extension proof business v2 with distinguishable version marker and concurrent execution support.',
  imageDigest:
    'sha256:e581cb2dcfe3119667f454fcb8983967ed5e2ff702fc58e18f3e5640de48541',
};

/**
 * PC-06 — version 3.0.0, the opt-in for the `parameterResolution` capability.
 *
 * 1.0.0 and 2.0.0 stay byte-identical: they are registered immutable versions.
 *
 * `enableReasoning` is the manifest's INTENTIONAL overlap — declared in both
 * `inputSchema.properties` and `profileSchema.properties` — and the capability
 * assigns it exactly one source (`requestDefaults`) instead of inferring one
 * from the overlap. The two profile-only knobs stay `profileSettings`, so they
 * never leak into request input. `applyTopLevelDefaults` stays false: this
 * action declares no top-level defaults, and claiming the capability would
 * only widen what the server may fill.
 */
export const exampleReviewManifestV3: BusinessManifest = {
  ...exampleReviewManifestV2,
  version: '3.0.0',
  displayName: 'Example Review Business v3',
  description:
    'Example Review v3: opt-in parameterResolution, with enableReasoning as an explicit requestDefaults source.',
  imageDigest:
    'sha256:9f2c41d7a0b8e6431d5c8f0a2b7e9d4c6a1f3b5e8c0d2a4f6b8c1e3d5a7f9b2c',
  actions: exampleReviewManifest.actions.map((action) =>
    action.name === 'review'
      ? {
          ...action,
          parameterResolution: {
            version: 2,
            fields: {
              enableReasoning: 'requestDefaults',
              maxParallelItems: 'profileSettings',
              autoApprovePassed: 'profileSettings',
            },
            applyTopLevelDefaults: false,
          },
        }
      : action,
  ),
};

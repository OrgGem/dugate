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

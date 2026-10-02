import {
  BusinessManifest,
  ActionManifest,
  ConnectorSlotManifest,
  WIRE_CONTRACT_VERSION,
} from '@du/contracts';

export { BusinessManifest, ActionManifest, ConnectorSlotManifest };

export const documentCoreManifest: BusinessManifest = {
  contractVersion: WIRE_CONTRACT_VERSION,
  businessId: 'document-core',
  version: '1.0.0',
  displayName: 'Document Core Business',
  description: 'Document understanding business providing 31 document variants and the multi-turn disbursement workflow.',
  imageDigest: 'sha256:placeholder-document-core-v1',
  runtime: {
    wireVersion: '1',
    handlerKinds: ['root', 'ingest', 'extract', 'analyze', 'transform', 'generate', 'compare', 'disbursement'],
  },
  capabilities: {
    cancel: true,
    resume: true,
    parallel: true,
  },
  actions: [
    // 1. Ingest
    {
      name: 'ingest',
      displayName: 'Document Ingestion',
      description: 'Parses structure, performs OCR, digitizes handwritten forms, or splits PDF pages.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['parse', 'ocr', 'digitize', 'split'] },
          pages: { type: 'string' },
          language: { type: 'string' },
          outputFormat: { type: 'string', enum: ['json', 'md', 'text'] },
        },
        required: ['mode'],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          markdown: { type: 'string' },
          splitArtifacts: { type: 'array' },
          metadata: { type: 'object' },
        },
        required: ['metadata'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        {
          name: 'ocr',
          required: false,
          acceptedCapabilities: ['ocr', 'pdf-text'],
        },
        {
          name: 'vision',
          required: false,
          acceptedCapabilities: ['vision', 'handwriting'],
        },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 20 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 300 },
    },

    // 2. Extract
    {
      name: 'extract',
      displayName: 'Data Extraction',
      description: 'Extracts structured domain objects (invoices, contracts, identity documents, receipts, tables, custom schemas).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'] },
          fields: { type: ['array', 'string'] },
          schema: { type: 'object' },
          outputFormat: { type: 'string', enum: ['json'] },
        },
        required: ['type'],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        required: ['data', 'provenance'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        {
          name: 'reasoning',
          required: true,
          acceptedCapabilities: ['chat-completion', 'structured-output'],
        },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 300 },
    },

    // 3. Analyze
    {
      name: 'analyze',
      displayName: 'Document Analysis',
      description: 'Taxonomy classification, sentiment analysis, compliance and fact checks, quality and summary evaluation, and risk assessment.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', enum: ['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval'] },
          categories: { type: ['array', 'string'] },
          criteria: { type: ['array', 'string'] },
          referenceData: { type: ['object', 'string'] },
          extractFields: { type: ['array', 'string'] },
        },
        required: ['task'],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        required: ['data', 'provenance'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        {
          name: 'reasoning',
          required: true,
          acceptedCapabilities: ['chat-completion', 'structured-output'],
        },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 300 },
    },

    // 4. Transform
    {
      name: 'transform',
      displayName: 'Document Transformation',
      description: 'Format conversion, translation, paraphrasing/rewrite, PII redaction, and template merge.',
      inputSchema: {
        type: 'object',
        properties: {
          variant: { type: 'string', enum: ['convert', 'translate', 'rewrite', 'redact', 'template'] },
          action: { type: 'string' }, // legacy alias
          targetLanguage: { type: 'string' },
          style: { type: 'string', enum: ['academic', 'executive', 'simplified', 'bullet_points'] },
          tone: { type: 'string', enum: ['formal', 'casual', 'business', 'academic'] },
          template: { type: 'string' },
          outputFormat: { type: 'string' },
        },
        required: [],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        required: ['data', 'provenance'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        {
          name: 'reasoning',
          required: false,
          acceptedCapabilities: ['chat-completion'],
        },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 300 },
    },

    // 5. Generate
    {
      name: 'generate',
      displayName: 'Content Generation',
      description: 'Summaries, outlines, reports, email drafts, meeting minutes, and document Q&A.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', enum: ['summary', 'outline', 'report', 'email', 'minutes', 'qa'] },
          format: { type: 'string', enum: ['paragraph', 'bullets', 'numbered', 'table'] },
          maxWords: { type: 'integer', minimum: 1 },
          questions: { type: ['array', 'string'] },
          tone: { type: 'string' },
          audience: { type: 'string' },
        },
        required: ['task'],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        required: ['data', 'provenance'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        {
          name: 'reasoning',
          required: true,
          acceptedCapabilities: ['chat-completion'],
        },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 300 },
    },

    // 6. Compare
    {
      name: 'compare',
      displayName: 'Document Comparison',
      description: 'Lexical text diff, semantic clause comparison, and version changelog.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['diff', 'semantic', 'version'] },
          source: { type: 'object' },
          target: { type: 'object' },
          focus: { type: 'string' },
        },
        required: ['mode', 'source', 'target'],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        required: ['data', 'provenance'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        {
          name: 'reasoning',
          required: false,
          acceptedCapabilities: ['chat-completion', 'structured-output'],
        },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 300 },
    },
    // Internal multi-turn workflow. The existing root handler kind remains the
    // manifest fallback until host dispatch wiring is added in the separate F4 lane.
    {
      name: 'disbursement',
      displayName: 'Disbursement Review Workflow',
      description: 'Classifies and extracts submitted document artifacts, waits for explicit human approval, cross-checks supplied reference data, and produces a report.',
      inputSchema: {
        type: 'object',
        properties: {
          inputVersion: { type: 'string', enum: ['disbursement-input-v1'] },
          artifactIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          fileNames: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          referenceData: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, expected: {} },
              required: ['key', 'expected'],
              additionalProperties: false,
            },
          },
          maxConcurrency: { type: 'integer', minimum: 1, maximum: 8 },
          failurePolicy: { type: 'string', enum: ['fail-closed', 'continue-on-partial'] },
          requireEncryptedEvidence: { type: 'boolean' },
        },
        required: ['inputVersion', 'artifactIds', 'fileNames', 'failurePolicy'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          resultVersion: { type: 'string', enum: ['disbursement-result-v1'] },
          businessId: { type: 'string', const: 'document-core' },
          businessVersion: { type: 'string', minLength: 1 },
          report: { type: 'string', minLength: 1 },
          crosscheck: {
            type: 'object',
            properties: {
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    status: { type: 'string', enum: ['match', 'mismatch', 'unresolved'] },
                    detail: { type: 'string' },
                  },
                  required: ['key', 'status', 'detail'],
                  additionalProperties: false,
                },
              },
              matchedCount: { type: 'integer', minimum: 0 },
              mismatchedCount: { type: 'integer', minimum: 0 },
            },
            required: ['findings', 'matchedCount', 'mismatchedCount'],
            additionalProperties: false,
          },
          evidence: {
            type: 'object',
            properties: {
              filesAnalyzed: { type: 'integer', minimum: 1 },
              logicalDocumentCount: { type: 'integer', minimum: 1 },
              extractedRecordCount: { type: 'integer', minimum: 1 },
              perFile: { type: 'array', minItems: 1 },
            },
            required: ['filesAnalyzed', 'logicalDocumentCount', 'extractedRecordCount', 'perFile'],
            additionalProperties: false,
          },
          failedChildren: {
            type: 'array',
            items: {
              type: 'object',
              properties: { childId: { type: 'string' }, reason: { type: 'string' } },
              required: ['childId', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['resultVersion', 'businessId', 'businessVersion', 'report', 'crosscheck', 'evidence', 'failedChildren'],
        additionalProperties: false,
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [
        { name: 'classify', required: true, acceptedCapabilities: ['chat-completion', 'structured-output'] },
        { name: 'extract', required: true, acceptedCapabilities: ['chat-completion', 'structured-output'] },
        { name: 'crosscheck', required: true, acceptedCapabilities: ['chat-completion', 'structured-output'] },
        { name: 'report', required: true, acceptedCapabilities: ['chat-completion'] },
      ],
      artifactPolicy: { minFiles: 1, maxFiles: 20 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { timeoutSeconds: 3600 },
    },
  ],
};

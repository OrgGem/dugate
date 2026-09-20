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
  description: 'Document understanding business providing Ingest, Extract, Analyze, Transform, Generate, and Compare across 28 variants.',
  imageDigest: 'sha256:placeholder-document-core-v1',
  runtime: {
    wireVersion: '1',
    handlerKinds: ['root', 'ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'],
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
      description: 'Extracts structured domain objects (invoices, contracts, receipts, tables, custom schemas).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['invoice', 'contract', 'receipt', 'table', 'custom'] },
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
      description: 'Taxonomy classification, sentiment analysis, compliance check, quality evaluation, and risk assessment.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', enum: ['classify', 'sentiment', 'compliance', 'quality', 'risk'] },
          categories: { type: ['array', 'string'] },
          criteria: { type: ['array', 'string'] },
          referenceData: { type: ['object', 'string'] },
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
  ],
};

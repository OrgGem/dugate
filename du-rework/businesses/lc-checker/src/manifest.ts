import { BusinessManifest, WIRE_CONTRACT_VERSION } from '@du/contracts';

import { LC_DEFAULT_RULE_SET_VERSION, LC_RULE_SET_ID, LC_RULE_SET_STATUS } from './rules/rule-registry';

export const LC_CHECKER_HANDLER_KINDS = ['lc-checker', 'lc-checker-ocr', 'lc-checker-visual', 'root'] as const;

/**
 * P9-02 LC checker business manifest.
 *
 * Three connector slots, one per stage that can call a provider: OCR reads the submitted
 * documents, the crosscheck slot runs the UCP 600 / ISBP 821 examination, and the report
 * slot renders the Vietnamese checking report. The slots are required because a run that
 * cannot examine the documents must not silently degrade into an empty COMPLIANT verdict.
 */
export const lcCheckerManifest: BusinessManifest = {
  contractVersion: WIRE_CONTRACT_VERSION,
  businessId: 'lc-checker',
  version: '1.0.0',
  displayName: 'LC Document Checker',
  description:
    'Examines a Letter of Credit document set against a versioned UCP 600 / ISBP 821 rules base and produces a cited, evidence-bearing checking report.',
  imageDigest: 'sha256:placeholder-lc-checker-v1',
  runtime: {
    wireVersion: '1',
    handlerKinds: [...LC_CHECKER_HANDLER_KINDS],
  },
  capabilities: {
    cancel: true,
    resume: true,
    parallel: true,
  },
  actions: [
    {
      name: 'lc-checker',
      displayName: 'LC Document Set Examination',
      description:
        'OCRs the submitted document set in bounded parallel, examines it against the pinned rules base, and returns a report in which every discrepancy cites a rule id.',
      inputSchema: {
        type: 'object',
        properties: {
          inputVersion: { type: 'string', enum: ['lc-checker-input-v1'] },
          artifactIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
          fileNames: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
          ruleSetVersion: { type: 'string', enum: [LC_DEFAULT_RULE_SET_VERSION] },
          maxConcurrency: { type: 'integer', minimum: 1, maximum: 8 },
          failurePolicy: { type: 'string', enum: ['fail-closed', 'continue-on-partial'] },
          requireEncryptedEvidence: { type: 'boolean' },
        },
        required: ['inputVersion', 'artifactIds', 'fileNames', 'ruleSetVersion', 'failurePolicy'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          resultVersion: { type: 'string', enum: ['lc-checker-result-v1'] },
          businessId: { type: 'string', const: 'lc-checker' },
          businessVersion: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['COMPLIANT', 'DISCREPANT', 'PENDING'] },
          recommendation: { type: 'string', enum: ['ACCEPT', 'REJECT', 'RESERVE_FOR_REVIEW'] },
          totalDiscrepancies: { type: 'integer', minimum: 0 },
          majorDiscrepancies: { type: 'integer', minimum: 0 },
          minorDiscrepancies: { type: 'integer', minimum: 0 },
          advisoryCount: { type: 'integer', minimum: 0 },
          documentsPresent: { type: 'array', items: { type: 'string' } },
          documentsMissing: { type: 'array', items: { type: 'string' } },
          discrepancies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                severity: { type: 'string', enum: ['MAJOR', 'MINOR', 'ADVISORY'] },
                document: { type: 'string' },
                field: { type: 'string' },
                issue: { type: 'string' },
                ruleId: { type: 'string' },
                recommendation: { type: 'string' },
              },
              required: ['id', 'severity', 'document', 'field', 'issue', 'ruleId', 'recommendation'],
              additionalProperties: false,
            },
          },
          summary: { type: 'string' },
          report: { type: 'string', minLength: 1 },
          evidence: {
            type: 'object',
            properties: {
              filesSubmitted: { type: 'integer', minimum: 0 },
              filesOcred: { type: 'integer', minimum: 0 },
              filesWithoutOcrText: { type: 'array', items: { type: 'string' } },
              totalOcrChars: { type: 'integer', minimum: 0 },
              ruleSetId: { type: 'string', const: LC_RULE_SET_ID },
              ruleSetVersion: { type: 'string', minLength: 1 },
              ruleSetStatus: { type: 'string', enum: [LC_RULE_SET_STATUS] },
              citedRuleIds: { type: 'array', items: { type: 'string' } },
              visualVerification: {
                type: 'object',
                properties: {
                  requested: { type: 'integer', minimum: 0 },
                  satisfied: { type: 'integer', minimum: 0 },
                  complete: { type: 'boolean' },
                },
                required: ['requested', 'satisfied', 'complete'],
                additionalProperties: false,
              },
            },
            required: [
              'filesSubmitted',
              'filesOcred',
              'filesWithoutOcrText',
              'totalOcrChars',
              'ruleSetId',
              'ruleSetVersion',
              'ruleSetStatus',
              'citedRuleIds',
              'visualVerification',
            ],
            additionalProperties: false,
          },
          humanSignOffRequired: { type: 'boolean', const: true },
          outstandingVisualChecks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { fileName: { type: 'string' }, purpose: { type: 'string' } },
              required: ['fileName', 'purpose'],
              additionalProperties: false,
            },
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
        required: [
          'resultVersion',
          'businessId',
          'businessVersion',
          'verdict',
          'recommendation',
          'totalDiscrepancies',
          'majorDiscrepancies',
          'minorDiscrepancies',
          'advisoryCount',
          'documentsPresent',
          'documentsMissing',
          'discrepancies',
          'summary',
          'report',
          'evidence',
          'humanSignOffRequired',
          'outstandingVisualChecks',
          'failedChildren',
        ],
        additionalProperties: false,
      },
      profileSchema: {
        type: 'object',
        properties: {
          ocrSlot: { type: 'string' },
          crosscheckSlot: { type: 'string' },
          reportSlot: { type: 'string' },
          maxConcurrency: { type: 'integer', minimum: 1, maximum: 8 },
        },
        additionalProperties: false,
      },
      connectorSlots: [
        {
          name: 'ocr',
          required: true,
          acceptedCapabilities: ['ocr', 'pdf-text', 'document-layout'],
        },
        {
          // Signatures, stamps, seals and endorsements. A separate slot from the OCR one
          // because reading a signature off a scan is a different capability from
          // transcribing text, and binding both to one provider would quietly downgrade
          // the visual pass to whatever the text engine happens to do.
          name: 'vision',
          required: true,
          acceptedCapabilities: ['vision', 'handwriting', 'document-layout'],
        },
        {
          name: 'crosscheck',
          required: true,
          acceptedCapabilities: ['chat-completion', 'structured-output'],
        },
        {
          name: 'report',
          required: true,
          acceptedCapabilities: ['chat-completion'],
        },
      ],
      artifactPolicy: {
        minFiles: 1,
        maxFiles: 50,
        acceptedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'application/octet-stream'],
      },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 8, timeoutSeconds: 3600 },
    },
  ],
};

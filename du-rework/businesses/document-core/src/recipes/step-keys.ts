/**
 * Stable step identifiers across all 6 actions and 31 variants.
 * Stable IDs ensure deterministic checkpoint resumption and idempotent recovery.
 */

export const STEP_KEYS = {
  INGEST: {
    VALIDATE: 'ingest:validate',
    PREPARE_SOURCE: 'ingest:prepare-source',
    EXECUTE_PARSE: 'ingest:execute-parse',
    EXECUTE_OCR: 'ingest:execute-ocr',
    EXECUTE_DIGITIZE: 'ingest:execute-digitize',
    EXECUTE_SPLIT: 'ingest:execute-split',
    NORMALIZE: 'ingest:normalize',
    FINALIZE: 'ingest:finalize',
  },
  EXTRACT: {
    VALIDATE: 'extract:validate',
    PREPARE_SOURCE: 'extract:prepare-source',
    BUILD_PROMPT: 'extract:build-prompt',
    CONNECTOR_INFERENCE: 'extract:connector-inference',
    VALIDATE_SCHEMA: 'extract:validate-schema',
    FINALIZE: 'extract:finalize',
  },
  ANALYZE: {
    VALIDATE: 'analyze:validate',
    PREPARE_SOURCE: 'analyze:prepare-source',
    BUILD_PROMPT: 'analyze:build-prompt',
    CONNECTOR_INFERENCE: 'analyze:connector-inference',
    FACT_CHECK_EXTRACT_CLAIMS: 'analyze:fact-check-extract-claims',
    FACT_CHECK_VERIFY_CLAIMS: 'analyze:fact-check-verify-claims',
    SUMMARIZE_EVAL_INFERENCE: 'analyze:summarize-eval-inference',
    VALIDATE_FINDINGS: 'analyze:validate-findings',
    FINALIZE: 'analyze:finalize',
  },
  TRANSFORM: {
    VALIDATE: 'transform:validate',
    PREPARE_SOURCE: 'transform:prepare-source',
    EXECUTE_LOCAL_CONVERT: 'transform:execute-local-convert',
    EXECUTE_TRANSLATE: 'transform:execute-translate',
    EXECUTE_REWRITE: 'transform:execute-rewrite',
    EXECUTE_REDACT: 'transform:execute-redact',
    EXECUTE_TEMPLATE: 'transform:execute-template',
    VERIFY: 'transform:verify',
    FINALIZE: 'transform:finalize',
  },
  GENERATE: {
    VALIDATE: 'generate:validate',
    PREPARE_SOURCE: 'generate:prepare-source',
    BUILD_PROMPT: 'generate:build-prompt',
    CONNECTOR_INFERENCE: 'generate:connector-inference',
    VALIDATE_FORMAT: 'generate:validate-format',
    FINALIZE: 'generate:finalize',
  },
  COMPARE: {
    VALIDATE: 'compare:validate',
    PREPARE_SOURCES: 'compare:prepare-sources',
    EXECUTE_DIFF: 'compare:execute-diff',
    EXECUTE_SEMANTIC: 'compare:execute-semantic',
    EXECUTE_VERSION: 'compare:execute-version',
    NORMALIZE_REFERENCES: 'compare:normalize-references',
    FINALIZE: 'compare:finalize',
  },
  DISBURSEMENT: {
    CLASSIFY: 'disbursement:classify:v1',
    EXTRACT: 'disbursement:extract:v1',
    APPROVAL: 'disbursement:approval:v1',
    CROSSCHECK: 'disbursement:crosscheck:v1',
    REPORT: 'disbursement:report:v1',
  },
} as const;

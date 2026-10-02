import {
  LEGACY_WORKFLOW_ENDPOINT_SLUG,
  legacyAccepted,
  legacyOperationView,
  legacyProgressPercent,
  parseLegacySubmission,
} from '../src/legacy-facade';
import { LC_DEFAULT_RULE_SET_VERSION } from '../src/rules/rule-registry';
import { LC_CHECKER_INPUT_VERSION } from '../src/types';
import type { LcCheckerResult } from '../src/lc-checker';

const FILES = ['invoice.pdf', 'bill-of-lading.pdf'];
const ARTIFACTS = ['art-1', 'art-2'];

function submit(overrides: {
  process?: string | null;
  fileNames?: readonly string[];
  fields?: Record<string, string>;
  artifactIds?: readonly string[];
}) {
  return parseLegacySubmission({
    fields: {
      process: overrides.process === undefined ? 'lc-checker' : overrides.process,
      fileNames: overrides.fileNames ?? FILES,
      fields: overrides.fields ?? {},
    },
    artifactIds: overrides.artifactIds ?? ARTIFACTS,
  });
}

const RESULT = {
  resultVersion: 'lc-checker-result-v1',
  businessId: 'lc-checker',
  businessVersion: '1.0.0',
  verdict: 'DISCREPANT',
  recommendation: 'REJECT',
  totalDiscrepancies: 1,
  majorDiscrepancies: 1,
  minorDiscrepancies: 0,
  advisoryCount: 0,
  documentsPresent: ['Commercial Invoice'],
  documentsMissing: ['Insurance Certificate'],
  discrepancies: [],
  summary: 'The bill of lading lacks a compliant on-board notation.',
  report: '# Bao cao kiem tra chung tu LC',
  evidence: {
    filesSubmitted: 2,
    filesOcred: 2,
    filesWithoutOcrText: [],
    totalOcrChars: 900,
    ruleSetId: 'lc-rules-base',
    ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
    ruleSetStatus: 'PROVISIONAL',
    citedRuleIds: ['PROC-3.2'],
    visualVerification: { requested: 2, attached: 2, complete: true },
  },
  humanSignOffRequired: true,
  failedChildren: [],
} as unknown as LcCheckerResult;

describe('P9-02 legacy facade', () => {
  it('maps a well-formed legacy submission onto the versioned business input', () => {
    const parsed = submit({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.businessInput.inputVersion).toBe(LC_CHECKER_INPUT_VERSION);
    expect(parsed.businessInput.artifactIds).toEqual(ARTIFACTS);
    expect(parsed.businessInput.fileNames).toEqual(FILES);
    expect(parsed.businessInput.ruleSetVersion).toBe(LC_DEFAULT_RULE_SET_VERSION);
    expect(parsed.businessInput.failurePolicy).toBe('fail-closed');
    expect(parsed.businessInput.requireEncryptedEvidence).toBe(true);
  });

  it('keeps the legacy endpoint slug, because it is the compatibility key', () => {
    expect(LEGACY_WORKFLOW_ENDPOINT_SLUG).toBe('workflows:lc-checker');
  });

  it('returns the legacy 400 for a missing process', () => {
    const parsed = submit({ process: null });
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problem.status).toBe(400);
    expect(parsed.problem.title).toBe('Missing Parameter');
    expect(parsed.problem.type).toBe('https://dugate.vn/errors/missing-parameter');
  });

  it('returns the legacy 404 for a process this facade does not serve', () => {
    const parsed = submit({ process: 'doc-compare' });
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problem.status).toBe(404);
    expect(parsed.problem.detail).toContain('doc-compare');
  });

  it('returns the legacy 400 for a submission with no files', () => {
    const parsed = submit({ fileNames: [], artifactIds: [] });
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problem.title).toBe('Missing Files');
  });

  it('refuses a file count that does not match the uploaded artifacts', () => {
    const parsed = submit({ artifactIds: ['art-1'] });
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problem.status).toBe(400);
    expect(parsed.problem.detail).toContain('1 for 2 files');
  });

  it('refuses the legacy apiKeyId form field instead of borrowing the oldest ADMIN key', () => {
    const parsed = submit({ fields: { apiKeyId: 'dg_attacker' } });
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problem.status).toBe(400);
    expect(parsed.problem.title).toBe('Invalid Profile API Key');
    expect(parsed.problem.detail).toContain('never from the request body');
  });

  it('refuses every identity field the legacy would have honoured', () => {
    for (const field of ['api_key_id', 'apiKey', 'userId', 'tenantId', 'role', 'adminToken']) {
      const parsed = submit({ fields: { [field]: 'x' } });
      expect(parsed.ok).toBe(false);
    }
  });

  it('rejects a legacy variable that is not a valid business value', () => {
    const parsed = submit({ fields: { failurePolicy: 'best-effort' } });
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.problem.title).toBe('Invalid Workflow Variables');
    expect(parsed.problem.detail).toContain('failurePolicy');
  });

  it('accepts the legacy tuning variables', () => {
    const parsed = submit({
      fields: { maxConcurrency: '6', failurePolicy: 'continue-on-partial', requireEncryptedEvidence: 'false' },
    });
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.businessInput.maxConcurrency).toBe(6);
    expect(parsed.businessInput.failurePolicy).toBe('continue-on-partial');
    expect(parsed.businessInput.requireEncryptedEvidence).toBe(false);
  });

  it('builds the legacy 202 acceptance with Operation-Location', () => {
    const accepted = legacyAccepted('op-123');
    expect(accepted.status).toBe(202);
    expect(accepted.headers['Operation-Location']).toBe('/api/v1/operations/op-123');
    expect(accepted.body.name).toBe('operations/op-123');
    expect(accepted.body.done).toBe(false);
    expect(accepted.body.metadata).toEqual({
      state: 'RUNNING',
      workflow: 'lc-checker',
      progress_percent: 0,
      progress_message: 'Initializing workflow...',
    });
  });

  it('reports a running operation as not done', () => {
    const view = legacyOperationView({
      operationId: 'op-123',
      state: 'RUNNING',
      progressPercent: 40,
      progressMessage: 'Examining',
    });
    expect(view['done']).toBe(false);
    expect(view['name']).toBe('operations/op-123');
    expect(view['output']).toBeUndefined();
  });

  it('publishes the report and verdict on a completed operation, for an existing client', () => {
    const view = legacyOperationView({
      operationId: 'op-123',
      state: 'DONE',
      progressPercent: 100,
      progressMessage: 'LC checking report ready',
      result: RESULT,
    });
    expect(view['done']).toBe(true);
    expect(view['output']).toBe('# Bao cao kiem tra chung tu LC');
    expect(view['outputContent']).toContain('on-board notation');
    expect(view['verdict']).toBe('DISCREPANT');
    expect(view['recommendation']).toBe('REJECT');
    expect(view['ruleSetVersion']).toBe(LC_DEFAULT_RULE_SET_VERSION);
    expect(view['humanSignOffRequired']).toBe(true);
  });

  it('reports a failure as an RFC7807 problem, never as a completed empty result', () => {
    const view = legacyOperationView({
      operationId: 'op-123',
      state: 'ERROR',
      progressPercent: 35,
      progressMessage: 'failed',
      errorCode: 'COMPLIANCE_INVALID',
    });
    expect(view['done']).toBe(true);
    expect(view['output']).toBeUndefined();
    expect(view['error']).toMatchObject({ code: 'COMPLIANCE_INVALID' });
  });

  it('keeps the legacy progress bands so a polling client reads the same shape', () => {
    expect(legacyProgressPercent('ocr', 'start')).toBe(5);
    expect(legacyProgressPercent('ocr', 'end')).toBe(30);
    expect(legacyProgressPercent('compliance', 'start')).toBe(35);
    expect(legacyProgressPercent('compliance', 'end')).toBe(80);
    expect(legacyProgressPercent('report', 'start')).toBe(85);
    expect(legacyProgressPercent('report', 'end')).toBe(95);
    expect(legacyProgressPercent('report', 'done')).toBe(100);
    expect(legacyProgressPercent('unknown-stage', 'start')).toBe(50);
  });
});

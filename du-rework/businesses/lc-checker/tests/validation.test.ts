import { LcCheckerError } from '../src/errors';
import { LC_DEFAULT_RULE_SET_VERSION, hasRule } from '../src/rules/rule-registry';
import { parseCompliancePayload, validateComplianceResult } from '../src/validation';
import { compliantPayload, discrepantPayload } from './fakes';

const FENCE = String.fromCharCode(96).repeat(3);

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = compliantPayload();
  delete base['__ruleId'];
  return { ...base, ...overrides };
}

function expectInvalid(run: () => unknown): LcCheckerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LcCheckerError);
    expect((error as LcCheckerError).code).toBe('COMPLIANCE_INVALID');
    return error as LcCheckerError;
  }
  throw new Error('expected the validation to fail');
}

const ADVISORY = {
  id: 'D001',
  severity: 'ADVISORY',
  document: 'Packing List',
  field: 'seal number',
  issue: 'Seal number is illegible in the scan.',
  rule_id: 'MR-3',
  recommendation: 'Ask the presenter to confirm the seal number.',
};

const MAJOR = {
  id: 'D010',
  severity: 'MAJOR',
  document: 'Bill of Lading',
  field: 'on board notation',
  issue: 'No on-board date, vessel name or port of loading is stated.',
  rule_id: 'PROC-3.2',
  recommendation: 'Request a corrected bill of lading.',
};

describe('P9-02 compliance validation', () => {
  it('accepts a well-formed compliant result', () => {
    const result = validateComplianceResult(payload(), LC_DEFAULT_RULE_SET_VERSION);
    expect(result.verdict).toBe('COMPLIANT');
    expect(result.recommendation).toBe('ACCEPT');
    expect(result.ruleSetVersion).toBe(LC_DEFAULT_RULE_SET_VERSION);
  });

  it('accepts a well-formed discrepant result with a cited rule', () => {
    const result = validateComplianceResult(discrepantPayload(), LC_DEFAULT_RULE_SET_VERSION);
    expect(result.verdict).toBe('DISCREPANT');
    expect(result.majorDiscrepancies).toBe(1);
    expect(result.discrepancies[0]?.ruleId).toBe('PROC-3.2');
  });

  it('refuses a finding that cites a rule outside the rules base', () => {
    expect(hasRule('MADE-UP-RULE')).toBe(false);
    const bad = discrepantPayload();
    (bad['discrepancies'] as Array<Record<string, unknown>>)[0]!['rule_id'] = 'MADE-UP-RULE';
    const error = expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
    expect(error.message).toContain('MADE-UP-RULE');
  });

  it('refuses a finding with no rule at all', () => {
    const bad = discrepantPayload();
    delete (bad['discrepancies'] as Array<Record<string, unknown>>)[0]!['rule_id'];
    expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
  });

  it('recomputes the counts instead of trusting the declared ones', () => {
    expectInvalid(() => validateComplianceResult(payload({ advisory_count: 3 }), LC_DEFAULT_RULE_SET_VERSION));
    expectInvalid(() =>
      validateComplianceResult({ ...discrepantPayload(), total_discrepancies: 5 }, LC_DEFAULT_RULE_SET_VERSION)
    );
    expectInvalid(() =>
      validateComplianceResult({ ...discrepantPayload(), major_discrepancies: 0 }, LC_DEFAULT_RULE_SET_VERSION)
    );
  });

  it('refuses a COMPLIANT verdict that hides a MAJOR discrepancy', () => {
    const bad = { ...payload(), ...discrepantPayload(), verdict: 'COMPLIANT' };
    expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
  });

  it('refuses a COMPLIANT verdict that hides a MINOR discrepancy', () => {
    const bad = payload({
      verdict: 'COMPLIANT',
      total_discrepancies: 1,
      minor_discrepancies: 1,
      recommendation: 'RESERVE_FOR_REVIEW',
      discrepancies: [{ ...MAJOR, id: 'D011', severity: 'MINOR', rule_id: 'PROC-3.6' }],
    });
    const error = expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
    expect(error.message).toContain('VERDICT-COMPLIANT');
  });

  it('refuses a DISCREPANT verdict with nothing to be discrepant about', () => {
    expectInvalid(() => validateComplianceResult(payload({ verdict: 'DISCREPANT' }), LC_DEFAULT_RULE_SET_VERSION));
  });

  it('refuses REJECT without a MAJOR discrepancy', () => {
    const bad = payload({
      verdict: 'PENDING',
      total_discrepancies: 1,
      advisory_count: 1,
      recommendation: 'REJECT',
      discrepancies: [ADVISORY],
    });
    const error = expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
    expect(error.message).toContain('RECO-REJECT');
  });

  it('refuses RESERVE_FOR_REVIEW that would bury a MAJOR discrepancy', () => {
    const bad = { ...discrepantPayload(), recommendation: 'RESERVE_FOR_REVIEW' };
    const error = expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
    expect(error.message).toContain('RESERVE_FOR_REVIEW must not hide a MAJOR');
  });

  it('refuses duplicate discrepancy ids', () => {
    const bad = payload({
      verdict: 'PENDING',
      total_discrepancies: 2,
      advisory_count: 2,
      recommendation: 'RESERVE_FOR_REVIEW',
      discrepancies: [ADVISORY, { ...ADVISORY }],
    });
    expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
  });

  it('refuses an unknown severity', () => {
    const bad = payload({
      verdict: 'PENDING',
      total_discrepancies: 1,
      advisory_count: 1,
      recommendation: 'RESERVE_FOR_REVIEW',
      discrepancies: [{ ...ADVISORY, severity: 'CRITICAL' }],
    });
    expectInvalid(() => validateComplianceResult(bad, LC_DEFAULT_RULE_SET_VERSION));
  });

  it('refuses an unknown ruleset version before reading anything', () => {
    try {
      validateComplianceResult(payload(), 'ucp600-isbp821-v99');
      throw new Error('expected the validation to fail');
    } catch (error) {
      expect((error as LcCheckerError).code).toBe('RULESET_UNKNOWN');
    }
  });

  it('stamps the pinned ruleset version onto the result rather than the claimed one', () => {
    const claimed = { ...discrepantPayload(), ruleSetVersion: 'something-else' };
    const result = validateComplianceResult(claimed, LC_DEFAULT_RULE_SET_VERSION);
    expect(result.ruleSetVersion).toBe(LC_DEFAULT_RULE_SET_VERSION);
  });

  it('parses a markdown-fenced JSON payload, as the legacy parser tolerated', () => {
    const fenced = FENCE + 'json' + String.fromCharCode(10) + JSON.stringify(payload()) + String.fromCharCode(10) + FENCE;
    const parsed = parseCompliancePayload(fenced);
    expect(validateComplianceResult(parsed, LC_DEFAULT_RULE_SET_VERSION).verdict).toBe('COMPLIANT');
  });

  it('passes an already-structured payload straight through', () => {
    const parsed = parseCompliancePayload(payload());
    expect(validateComplianceResult(parsed, LC_DEFAULT_RULE_SET_VERSION).verdict).toBe('COMPLIANT');
  });

  it('refuses empty, non-string, non-object and non-JSON connector output', () => {
    expectInvalid(() => parseCompliancePayload(''));
    expectInvalid(() => parseCompliancePayload(null));
    expectInvalid(() => parseCompliancePayload(42));
    expectInvalid(() => parseCompliancePayload('this is not json'));
  });
});

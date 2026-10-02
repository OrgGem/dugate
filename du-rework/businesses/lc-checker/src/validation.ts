/**
 * Result validation.
 *
 * This is where P9-02's promise is kept. A model can return a fluent, confident, entirely
 * uncited examination, and the legacy workflow would have stored it as the verdict. Here
 * three things must hold before a result can be trusted:
 *
 *   1. every discrepancy cites a rule id that exists in the pinned rules base;
 *   2. the counts agree with the discrepancy array;
 *   3. the verdict and recommendation follow the rules the examiner was given
 *      (VERDICT-* and RECO-* in the registry), not the examiner's preference.
 *
 * A run that fails any of them is FAILED, not quietly repaired.
 */

import { LcCheckerError } from './errors';
import { getRule, getRuleSet } from './rules/rule-registry';
import type {
  DiscrepancySeverity,
  LcComplianceResult,
  LcDiscrepancy,
  LcRecommendation,
  LcScreenResult,
  LcVerdict,
  LcVisualDigest,
  LcVisualObservation,
  LcVisualRequest,
} from './types';

/**
 * Ceiling on the second pass. The screening pass may not ask for an unbounded amount of
 * inspection: each request is one document read, and the connector budget is real.
 */
export const MAX_VISUAL_REQUESTS = 24;

const VERDICTS: readonly LcVerdict[] = ['COMPLIANT', 'DISCREPANT', 'PENDING'];
const SEVERITIES: readonly DiscrepancySeverity[] = ['MAJOR', 'MINOR', 'ADVISORY'];
const RECOMMENDATIONS: readonly LcRecommendation[] = ['ACCEPT', 'REJECT', 'RESERVE_FOR_REVIEW'];

function fail(message: string): never {
  throw new LcCheckerError('COMPLIANCE_INVALID', message, true);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label + ' must be an object');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(label + ' must be a string');
  return value;
}

function asNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(label + ' must be a non-negative integer');
  }
  return value;
}

function asIndex(value: unknown, label: string, documentCount: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(label + ' must be a non-negative integer');
  }
  if (value >= documentCount) {
    fail(label + ' is ' + value + ' but only ' + documentCount + ' documents were submitted');
  }
  return value;
}

function asStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) fail(label + ' must be an array');
  return value.map((entry, index) => asString(entry, label + '[' + index + ']'));
}

/**
 * Normalise whatever the connector returned into a JSON value.
 *
 * A string is stripped of a markdown fence if one is present and then parsed; an
 * already-structured value is passed through. The legacy `parseDeep` tolerated a fence,
 * so that tolerance is unchanged. What is new is that a payload which is neither a
 * string nor an object is now a typed failure instead of a silently empty result.
 */
export function parseCompliancePayload(content: unknown): unknown {
  if (typeof content === 'object' && content !== null) {
    return content;
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    fail('The compliance port returned no content to parse');
  }
  let body = content.trim();
  const fence = '```';
  const firstFence = body.indexOf(fence);
  if (firstFence === 0) {
    const afterOpen = body.indexOf('\n');
    const lastFence = body.lastIndexOf(fence);
    if (afterOpen > 0 && lastFence > afterOpen) {
      body = body.slice(afterOpen + 1, lastFence).trim();
    }
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    fail('The compliance port returned content that is not valid JSON: ' + body.slice(0, 200));
  }
}

function validateDiscrepancy(raw: unknown, index: number, pinnedVersion: string): LcDiscrepancy {
  const record = asRecord(raw, 'discrepancies[' + index + ']');
  const id = asString(record['id'], 'discrepancies[' + index + '].id');
  const severity = asString(record['severity'], 'discrepancies[' + index + '].severity');
  if (!SEVERITIES.includes(severity as DiscrepancySeverity)) {
    fail('discrepancies[' + index + '].severity "' + severity + '" is not one of ' + SEVERITIES.join(', '));
  }
  const ruleId = asString(record['rule_id'] ?? record['ruleId'], 'discrepancies[' + index + '].rule_id');
  const rule = getRule(ruleId);
  if (!rule) {
    fail(
      'discrepancies[' +
        index +
        '] cites rule "' +
        ruleId +
        '" which does not exist in ruleset ' +
        pinnedVersion +
        '; a finding with no rule behind it is not evidence'
    );
  }
  return {
    id,
    severity: severity as DiscrepancySeverity,
    document: asString(record['document'], 'discrepancies[' + index + '].document'),
    field: asString(record['field'], 'discrepancies[' + index + '].field'),
    issue: asString(record['issue'], 'discrepancies[' + index + '].issue'),
    ruleId,
    recommendation: asString(record['recommendation'], 'discrepancies[' + index + '].recommendation'),
  };
}

function countBy(entries: readonly LcDiscrepancy[], severity: DiscrepancySeverity): number {
  return entries.filter((entry) => entry.severity === severity).length;
}

/**
 * Validate the screening pass.
 *
 * A visual request is a bill the platform pays for, so it has to name a document that
 * exists, say what it wants looked at, and cite a rule that exists. A pass that could ask
 * for an unbounded amount of inspection would be a hole in the connector budget, so the
 * ceiling is enforced here rather than trusted to the model.
 */
export function validateScreenResult(
  raw: unknown,
  pinnedRuleSetVersion: string,
  documentCount: number
): LcScreenResult {
  if (!getRuleSet(pinnedRuleSetVersion)) {
    throw new LcCheckerError('RULESET_UNKNOWN', 'Unknown LC ruleset version ' + pinnedRuleSetVersion);
  }
  const record = asRecord(raw, 'The screening result');

  const rawRequests = record['visual_requests'];
  if (!Array.isArray(rawRequests)) fail('visual_requests must be an array');
  if (rawRequests.length > MAX_VISUAL_REQUESTS) {
    fail(
      'visual_requests holds ' +
        rawRequests.length +
        ' entries, above the ceiling of ' +
        MAX_VISUAL_REQUESTS
    );
  }

  const seen = new Set<string>();
  const visualRequests: LcVisualRequest[] = rawRequests.map((entry, index) => {
    const item = asRecord(entry, 'visual_requests[' + index + ']');
    const documentIndex = asIndex(
      item['document_index'],
      'visual_requests[' + index + '].document_index',
      documentCount
    );
    const purpose = asString(item['purpose'], 'visual_requests[' + index + '].purpose').trim();
    if (purpose.length === 0) {
      fail('visual_requests[' + index + '].purpose must not be blank');
    }
    const rawRuleIds = item['rule_ids'];
    if (!Array.isArray(rawRuleIds) || rawRuleIds.length === 0) {
      fail('visual_requests[' + index + '].rule_ids must be a non-empty array');
    }
    const ruleIds = rawRuleIds.map((ruleId, ruleIndex) => {
      const label = 'visual_requests[' + index + '].rule_ids[' + ruleIndex + ']';
      const id = asString(ruleId, label);
      if (!getRule(id)) {
        fail(
          label +
            ' cites rule ' +
            id +
            ' which does not exist in ruleset ' +
            pinnedRuleSetVersion +
            '; a visual check with no rule behind it is not an examination'
        );
      }
      return id;
    });
    const key = documentIndex + '|' + purpose.toLowerCase();
    if (seen.has(key)) {
      fail('visual_requests[' + index + '] repeats a check already requested for document ' + documentIndex);
    }
    seen.add(key);
    return { documentIndex, purpose, ruleIds };
  });

  return {
    visualRequests,
    notes: asString(record['notes'] ?? '', 'notes'),
    ruleSetVersion: pinnedRuleSetVersion,
  };
}

/** Validate one visual digest returned by the second pass. */
export function validateVisualDigest(
  raw: unknown,
  expected: LcVisualRequest,
  fileName: string,
  documentCount: number
): LcVisualDigest {
  const record = asRecord(raw, 'The visual digest');
  const documentIndex = asIndex(record['document_index'], 'document_index', documentCount);
  if (documentIndex !== expected.documentIndex) {
    fail(
      'Visual digest is for document ' + documentIndex + ' but was requested for ' + expected.documentIndex
    );
  }
  const rawObservations = record['observations'];
  if (!Array.isArray(rawObservations) || rawObservations.length === 0) {
    fail('A visual digest must report at least one observation; an empty one settles nothing');
  }
  const observations: LcVisualObservation[] = rawObservations.map((entry, index) => {
    const item = asRecord(entry, 'observations[' + index + ']');
    const found = item['found'];
    if (typeof found !== 'boolean') {
      fail('observations[' + index + '].found must be a boolean; not-readable is not the same as not-present');
    }
    return {
      field: asString(item['field'], 'observations[' + index + '].field'),
      found,
      evidence: asString(item['evidence'] ?? '', 'observations[' + index + '].evidence'),
    };
  });
  return {
    documentIndex,
    fileName,
    purpose: expected.purpose,
    ruleIds: expected.ruleIds,
    observations,
  };
}

/**
 * Validate and normalise a compliance result against the pinned rules base.
 * Fails closed: anything unexpected is an error, never a defaulted field.
 */
export function validateComplianceResult(raw: unknown, pinnedRuleSetVersion: string): LcComplianceResult {
  const ruleSet = getRuleSet(pinnedRuleSetVersion);
  if (!ruleSet) {
    throw new LcCheckerError('RULESET_UNKNOWN', 'Unknown LC ruleset version "' + pinnedRuleSetVersion + '"');
  }

  const record = asRecord(raw, 'The compliance result');

  const verdict = asString(record['verdict'], 'verdict');
  if (!VERDICTS.includes(verdict as LcVerdict)) {
    fail('verdict "' + verdict + '" is not one of ' + VERDICTS.join(', '));
  }

  const rawDiscrepancies = record['discrepancies'];
  if (!Array.isArray(rawDiscrepancies)) fail('discrepancies must be an array');
  const discrepancies = rawDiscrepancies.map((entry, index) =>
    validateDiscrepancy(entry, index, pinnedRuleSetVersion)
  );

  const duplicate = new Set<string>();
  for (const entry of discrepancies) {
    if (duplicate.has(entry.id)) fail('Duplicate discrepancy id "' + entry.id + '"');
    duplicate.add(entry.id);
  }

  const major = countBy(discrepancies, 'MAJOR');
  const minor = countBy(discrepancies, 'MINOR');
  const advisory = countBy(discrepancies, 'ADVISORY');

  const declaredTotal = asNonNegativeInt(record['total_discrepancies'], 'total_discrepancies');
  if (declaredTotal !== discrepancies.length) {
    fail('total_discrepancies is ' + declaredTotal + ' but the array holds ' + discrepancies.length);
  }
  if (asNonNegativeInt(record['major_discrepancies'], 'major_discrepancies') !== major) {
    fail('major_discrepancies does not match the MAJOR entries in the array');
  }
  if (asNonNegativeInt(record['minor_discrepancies'], 'minor_discrepancies') !== minor) {
    fail('minor_discrepancies does not match the MINOR entries in the array');
  }
  if (asNonNegativeInt(record['advisory_count'], 'advisory_count') !== advisory) {
    fail('advisory_count does not match the ADVISORY entries in the array');
  }

  // VERDICT-COMPLIANT / VERDICT-DISCREPANT: the verdict must follow from the findings,
  // not the other way round. A COMPLIANT verdict over a MAJOR discrepancy is the exact
  // failure this business exists to prevent.
  const typedVerdict = verdict as LcVerdict;
  if (typedVerdict === 'COMPLIANT' && (major > 0 || minor > 0)) {
    fail('verdict COMPLIANT requires zero MAJOR and zero MINOR discrepancies (VERDICT-COMPLIANT)');
  }
  if (typedVerdict === 'DISCREPANT' && major === 0 && minor === 0) {
    fail('verdict DISCREPANT requires at least one MAJOR or MINOR discrepancy (VERDICT-DISCREPANT)');
  }

  const recommendation = asString(record['recommendation'], 'recommendation');
  if (!RECOMMENDATIONS.includes(recommendation as LcRecommendation)) {
    fail('recommendation "' + recommendation + '" is not one of ' + RECOMMENDATIONS.join(', '));
  }
  const typedRecommendation = recommendation as LcRecommendation;

  // RECO-REJECT: rejection follows a MAJOR. RECO-ACCEPT follows a clean examination.
  if (typedRecommendation === 'REJECT' && major === 0) {
    fail('recommendation REJECT requires at least one MAJOR discrepancy (RECO-REJECT)');
  }
  if (typedRecommendation === 'ACCEPT' && (major > 0 || minor > 0)) {
    fail('recommendation ACCEPT requires a COMPLIANT examination (RECO-ACCEPT)');
  }
  if (typedRecommendation === 'RESERVE_FOR_REVIEW' && major > 0) {
    fail('recommendation RESERVE_FOR_REVIEW must not hide a MAJOR discrepancy (RECO-REJECT)');
  }

  return {
    verdict: typedVerdict,
    totalDiscrepancies: declaredTotal,
    majorDiscrepancies: major,
    minorDiscrepancies: minor,
    advisoryCount: advisory,
    documentsPresent: asStringArray(record['documents_present'], 'documents_present'),
    documentsMissing: asStringArray(record['documents_missing'], 'documents_missing'),
    discrepancies,
    summary: asString(record['summary'], 'summary'),
    recommendation: typedRecommendation,
    ruleSetVersion: pinnedRuleSetVersion,
  };
}

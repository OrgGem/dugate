import { reviewModel, reviewValueAt, setReviewValue, validateReview } from '../../../apps/admin-web/src/features/operations/review-schema';

const schema = { type: 'object', additionalProperties: false, properties: {
  approved: { type: 'boolean' }, count: { type: 'integer', minimum: 1, maximum: 9 },
  decision: { type: 'string', enum: ['accept', 'reject'] }, note: { type: 'string', minLength: 2, maxLength: 5 },
  details: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string' } }, required: ['reason'] },
}, required: ['approved', 'count', 'decision'] };

test('guided review preserves false, numeric types and enums', () => {
  const model = reviewModel(schema);
  let value = setReviewValue({}, ['approved'], false);
  value = setReviewValue(value, ['count'], 2);
  value = setReviewValue(value, ['decision'], 'accept');
  expect(validateReview(model, JSON.stringify(value))).toEqual([]);
  expect(value).toEqual({ approved: false, count: 2, decision: 'accept' });
});
test('required, integer range, enum, unknown fields and string bounds are validated', () => {
  const model = reviewModel(schema);
  expect(validateReview(model, '{}')).toHaveLength(3);
  expect(validateReview(model, JSON.stringify({ approved: 'yes', count: 0, decision: 'invalid', note: 'x', unknown: 1 }))).toHaveLength(5);
  expect(validateReview(model, JSON.stringify({ approved: false, count: 1.5, decision: 'accept' }))).toEqual(['count must be integer.']);
});
test('nested optional objects activate required rules only when present', () => {
  const base = { approved: true, count: 2, decision: 'reject' };
  expect(validateReview(reviewModel(schema), JSON.stringify(base))).toEqual([]);
  expect(validateReview(reviewModel(schema), JSON.stringify({ ...base, details: {} }))).toEqual(['details.reason is required.']);
  const updated = setReviewValue(base, ['details', 'reason'], 'checked');
  expect(reviewValueAt(updated, ['details', 'reason'])).toBe('checked');
  expect(base).not.toHaveProperty('details');
  expect(validateReview(reviewModel(schema), JSON.stringify(updated))).toEqual([]);
});
test('unsupported schemas explicitly use JSON fallback and never discard values', () => {
  const advanced = reviewModel({ type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } } });
  expect(advanced.supported).toBe(false);
  expect(validateReview(advanced, '{invalid')).toEqual(['Enter valid JSON before submitting.']);
  expect(validateReview(advanced, '{"list":["a","b"]}')).toEqual([]);
  expect(reviewModel({ type: 'object', properties: { text: { type: 'string', pattern: 'a+' } } }).supported).toBe(false);
});
test('Unicode lengths count code points and field changes do not mutate other answers', () => {
  const model = reviewModel({ type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 1 } } });
  expect(validateReview(model, '{"text":"😀"}')).toEqual([]);
  const original = { text: 'a', approved: false };
  expect(setReviewValue(original, ['text'], undefined)).toEqual({ approved: false });
  expect(original.text).toBe('a');
});
test('unsafe property paths cannot mutate prototypes', () => {
  expect(() => setReviewValue({}, ['__proto__', 'polluted'], true)).toThrow();
  expect(reviewModel(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')).supported).toBe(false);
  expect({}).not.toHaveProperty('polluted');
});

import { usageCostState } from '../../../apps/admin-web/src/features/usage/cost-state';
test('unpriced zero cost never displays as final or free usage', () => {
  const result = usageCostState({ totals: { costMicrousd: 0, costStatus: 'unpriced' } });
  expect(result.label).toBe('Unpriced usage remains');
  expect(result.incomplete).toBe(true);
  expect(result.description).toContain('does not mean');
});
test('absent or invalid cost is unavailable with unknown completeness', () => {
  expect(usageCostState({})).toMatchObject({ label: 'Cost completeness unknown', knownCostUsd: null, incomplete: true });
  expect(usageCostState({ totals: { costMicrousd: -1 } }).knownCostUsd).toBeNull();
  expect(usageCostState({ totals: { costMicrousd: 1250000, costStatus: 'estimated' } })).toMatchObject({ label: 'Estimated net cost', knownCostUsd: 1.25, incomplete: true });
});

// BIZ-09: the cockpit's sample-time helper. Plain JS on purpose - admin-web runs
// `node --test` over *.test.mjs, and stripping applies to .ts/.mts only.
import assert from 'node:assert';
import test from 'node:test';
import { newest } from '../src/features/businesses/cockpit-sample-time.ts';

test('no rows yields null, not a fabricated now', () => {
  assert.strictEqual(newest([]), null);
});

test('rows with no timestamp at all stay null', () => {
  assert.strictEqual(newest([{ revision: 0 }, { revision: 3 }]), null);
});

test('the newest of the carried timestamps wins, whatever column it lives on', () => {
  const rows = [
    { updatedAt: '2026-10-01T08:00:00.000Z' },
    { observedAt: '2026-10-05T09:00:00.000Z' },
    { createdAt: '2026-10-03T07:00:00.000Z' },
  ];
  assert.strictEqual(newest(rows), '2026-10-05T09:00:00.000Z');
});

test('observedAt beats updatedAt on the same row (heartbeat is the observation)', () => {
  assert.strictEqual(
    newest([{ updatedAt: '2026-10-09T00:00:00.000Z', observedAt: '2026-10-02T00:00:00.000Z' }]),
    '2026-10-02T00:00:00.000Z',
  );
});

test('an explicit null timestamp is skipped, not treated as the newest', () => {
  assert.strictEqual(
    newest([{ updatedAt: null }, { updatedAt: '2026-10-04T00:00:00.000Z' }]),
    '2026-10-04T00:00:00.000Z',
  );
});

test('max is string comparison, so it is order-independent', () => {
  const a = '2026-10-02T00:00:00.000Z';
  const b = '2026-10-07T00:00:00.000Z';
  assert.strictEqual(newest([{ createdAt: b }, { createdAt: a }]), b);
  assert.strictEqual(newest([{ createdAt: a }, { createdAt: b }]), b);
});

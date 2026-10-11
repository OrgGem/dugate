import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupProfileListRows, keyProfileListRows, parseProfileListPage, profileRowIdentity } from '../src/features/profiles/state.ts';

const row = {
  tenantId: 'tenant-a',
  businessId: 'document-core',
  businessVersion: '1.2.0',
  profileName: 'default',
  revision: 3,
  status: 'ACTIVE',
  keyCount: 2,
  boundActions: ['extract'],
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
};

/** The scheme F2 replaced, kept here so every test pins ITS collision before asserting the fix. */
const previousKey = (r) => `${r.businessId}:${r.businessVersion}:${r.profileName}`;

describe('profile row identity — F2 unique keying', () => {
  it('premise: the previous joined key collides when a value contains the separator', () => {
    const first = { ...row, businessId: 'a', businessVersion: 'b', profileName: 'c:d' };
    const second = { ...row, businessId: 'a', businessVersion: 'b:c', profileName: 'd' };
    assert.equal(previousKey(first), 'a:b:c:d');
    assert.equal(previousKey(second), 'a:b:c:d', 'the old scheme cannot tell these apart: both tuples join to the same key');
  });

  it('the identity cannot be confused by a separator inside a value', () => {
    const first = { ...row, businessId: 'a', businessVersion: 'b', profileName: 'c:d' };
    const second = { ...row, businessId: 'a', businessVersion: 'b:c', profileName: 'd' };
    assert.notEqual(profileRowIdentity(first), profileRowIdentity(second));
  });

  it('premise + fix: tenantId participates, so a cross-tenant page cannot collide', () => {
    const a = { ...row, tenantId: 'tenant-a' };
    const b = { ...row, tenantId: 'tenant-b' };
    assert.equal(previousKey(a), previousKey(b), 'the old 3-field key dropped tenantId');
    assert.notEqual(profileRowIdentity(a), profileRowIdentity(b));
    assert.equal(profileRowIdentity(a), profileRowIdentity({ ...row, tenantId: 'tenant-a' }), 'identity is a pure function');
  });

  it('displayed-but-not-identifying fields do not change identity', () => {
    const base = profileRowIdentity(row);
    assert.notEqual(base, profileRowIdentity({ ...row, profileName: 'other' }));
    assert.notEqual(base, profileRowIdentity({ ...row, businessId: 'other' }));
    assert.notEqual(base, profileRowIdentity({ ...row, businessVersion: '9.9.9' }));
    assert.equal(base, profileRowIdentity({ ...row, revision: 99, status: 'DISABLED', keyCount: 0, boundActions: [] }),
      'revision/status/keyCount are projections, not identity');
  });
});

describe('keyProfileListRows — keys stay unique even when the wire repeats a row', () => {
  it('an identical row twice: the old key collided, the new keys do not', () => {
    assert.equal(previousKey(row), previousKey(row), 'premise: duplicates are indistinguishable to the old key');
    const keyed = keyProfileListRows([row, row]);
    assert.equal(keyed.length, 2);
    assert.equal(keyed[0].duplicateIndex, 0);
    assert.equal(keyed[1].duplicateIndex, 1);
    assert.notEqual(keyed[0].key, keyed[1].key);
    assert.equal(new Set(keyed.map((k) => k.key)).size, 2);
    assert.ok(keyed[1].key.startsWith(keyed[0].identity), 'the disambiguator extends the identity');
  });

  it('the page parser gates SHAPE, not duplicates — so keying is the only line of defence', () => {
    const page = parseProfileListPage({ items: [row, row, row], total: 3, limit: 10, nextCursor: null, prevCursor: null });
    assert.ok(page !== null, 'parseProfileListPage accepts the page');
    assert.equal(page.items.length, 3, 'premise of F2: the wire CAN deliver a duplicate');
    const keyed = keyProfileListRows(page.items);
    assert.equal(new Set(keyed.map((k) => k.key)).size, 3);
  });

  it('keys are stable across re-renders of the same input order (no remount churn)', () => {
    const rows = [row, { ...row, profileName: 'second' }, row];
    const first = keyProfileListRows(rows);
    const second = keyProfileListRows(rows);
    assert.deepEqual(second.map((k) => k.key), first.map((k) => k.key));
  });

  it('uniqueness holds across the WHOLE page, not only inside one business group', () => {
    const rows = [
      row,
      { ...row, businessId: 'lc-checker' },
      { ...row, tenantId: 'tenant-b' },
      { ...row, businessVersion: '1.3.0' },
      row,
    ];
    const keyed = keyProfileListRows(rows);
    assert.equal(keyed.length, 5);
    assert.equal(new Set(keyed.map((k) => k.key)).size, 5, 'no two rows can share a key');
    assert.equal(keyed[0].duplicateIndex, 0);
    assert.equal(keyed[4].duplicateIndex, 1, 'the 5th row repeats the 1st tuple');
  });

  it('an empty page produces no rows', () => {
    assert.deepEqual(keyProfileListRows([]), []);
    assert.deepEqual(groupProfileListRows([]), []);
  });
});

describe('groupProfileListRows — table view grouping', () => {
  it('group keys are unique and every row survives grouping exactly once', () => {
    const rows = [
      row,
      { ...row, businessVersion: '1.3.0' },
      { ...row, businessId: 'lc-checker' },
      row,
    ];
    const groups = groupProfileListRows(rows);
    const groupKeys = groups.map((g) => g.businessId);
    assert.equal(new Set(groupKeys).size, groupKeys.length, 'Fragment keys must be unique');
    assert.deepEqual([...groupKeys].sort(), ['document-core', 'lc-checker']);
    assert.equal(groups.reduce((n, g) => n + g.items.length, 0), rows.length, 'no row lost or duplicated by grouping');
    assert.equal(new Set(groups.flatMap((g) => g.items.map((i) => i.key))).size, rows.length);
    assert.deepEqual(groups.map((g) => g.businessId), ['document-core', 'lc-checker'], 'first-seen order is preserved');
  });

  it('rows keep their original reference for rendering, and the key is identity + occurrence', () => {
    const groups = groupProfileListRows([row]);
    assert.equal(groups[0].items[0].row, row);
    assert.equal(groups[0].items[0].key, profileRowIdentity(row) + '#0');
  });
});
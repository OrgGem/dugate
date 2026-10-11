import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProfileListPage } from '../src/features/profiles/state.ts';

const row = {
  tenantId: 'tenant-a',
  businessId: 'document-core',
  businessVersion: '1.2.0',
  profileName: 'default',
  revision: 3,
  status: 'ACTIVE',
  keyCount: 2,
  boundActions: ['extract', 'analyze'],
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
};

describe('parseProfileListPage', () => {
  it('parses metadata rows and pagination without exposing credentials', () => {
    const page = parseProfileListPage({ items: [row], total: 2, limit: 1, nextCursor: 'next', prevCursor: null });
    assert.deepEqual(page, { items: [row], total: 2, limit: 1, nextCursor: 'next', prevCursor: null });
    assert.equal('apiKey' in page.items[0], false);
  });

  it('accepts a valid empty result as a distinct empty state', () => {
    assert.deepEqual(parseProfileListPage({ items: [], total: 0, limit: 100, nextCursor: null, prevCursor: null }), {
      items: [], total: 0, limit: 100, nextCursor: null, prevCursor: null,
    });
  });

  it('rejects malformed rows and rows outside the selected tenant/business scope', () => {
    assert.equal(parseProfileListPage({ items: [{ ...row, keyCount: -1 }], total: 1, limit: 10, nextCursor: null, prevCursor: null }), null);
    assert.equal(parseProfileListPage({ items: [row], total: 1, limit: 10, nextCursor: null, prevCursor: null }, 'tenant-b'), null);
    assert.equal(parseProfileListPage({ items: [row], total: 1, limit: 10, nextCursor: null, prevCursor: null }, 'tenant-a', 'another-business'), null);
  });
});

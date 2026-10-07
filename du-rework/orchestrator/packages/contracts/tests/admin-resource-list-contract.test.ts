import {
  ADMIN_BUSINESS_LIST_QUERY_PARAMS,
  ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS,
  ADMIN_RESOURCE_LIST_SORT_DEFAULT,
  ADMIN_RESOURCE_LIST_SORT_VALUES,
  API_KEY_LIST_QUERY_PARAMS,
  AdminBusinessListQuerySchema,
  AdminBusinessVersionListQuerySchema,
  ApiKeyListQuerySchema,
  ListPageBaseSchema,
  decodeAdminResourceListSortCursor,
  encodeAdminResourceListSortCursor,
} from '../src/public-api';

describe('ADM-UX-02 sortable admin resource query contract', () => {
  it('publishes the same closed sort set on all three list shapes', () => {
    expect([...ADMIN_RESOURCE_LIST_SORT_VALUES]).toEqual([
      'createdAt:asc',
      'createdAt:desc',
      'updatedAt:asc',
      'updatedAt:desc',
    ]);
    expect(ADMIN_RESOURCE_LIST_SORT_DEFAULT).toBe('createdAt:desc');
    expect([...ADMIN_BUSINESS_LIST_QUERY_PARAMS]).toEqual(['limit', 'cursor', 'sort']);
    expect([...ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS]).toEqual(['limit', 'cursor', 'sort']);
    expect([...API_KEY_LIST_QUERY_PARAMS]).toEqual(['tenantId', 'limit', 'cursor', 'status', 'prefix', 'sort']);
  });

  it('accepts each advertised sort and rejects alternate spellings/fields', () => {
    for (const sort of ADMIN_RESOURCE_LIST_SORT_VALUES) {
      expect(AdminBusinessListQuerySchema.safeParse({ sort }).success).toBe(true);
      expect(AdminBusinessVersionListQuerySchema.safeParse({ sort }).success).toBe(true);
      expect(ApiKeyListQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(AdminBusinessListQuerySchema.safeParse({ sort: 'created_at:desc' }).success).toBe(false);
    expect(AdminBusinessVersionListQuerySchema.safeParse({ sort: 'updatedAt:sideways' }).success).toBe(false);
    expect(ApiKeyListQuerySchema.safeParse({ sort: 'id:asc' }).success).toBe(false);
    expect(AdminBusinessListQuerySchema.safeParse({ unknown: 'accepted?' }).success).toBe(false);
    expect(ListPageBaseSchema.safeParse({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: 200 }).success).toBe(true);
  });

  it('encodes a compact cursor with exact microsecond timestamp and sort binding', () => {
    const encoded = encodeAdminResourceListSortCursor({
      timestamp: '2026-09-28T06:00:00.123456Z',
      id: 'business-core',
      direction: 'next',
      sort: 'createdAt:asc',
    });
    expect(encoded.length).toBeLessThanOrEqual(128);
    expect(decodeAdminResourceListSortCursor(encoded)).toEqual({
      timestamp: '2026-09-28T06:00:00.123456Z',
      id: 'business-core',
      direction: 'next',
      sort: 'createdAt:asc',
    });
    expect(decodeAdminResourceListSortCursor(encoded + '!')).toBe(null);
  });
});

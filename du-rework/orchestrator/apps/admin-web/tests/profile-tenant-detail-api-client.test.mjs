import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminApiClient } from '../src/lib/api/client.ts';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('tenant-scoped Profile detail reads', () => {
  it('forwards selected tenant on detail reads while preserving the legacy unscoped call', async () => {
    const calls = [];
    const client = createAdminApiClient({
      basePath: '/admin/api',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init.method });
        return jsonResponse({});
      },
    });

    await client.getProfile('document-core', 'latest', 'named.profile', {
      tenantId: '00000000-0000-0000-0000-000000000001',
      profileId: '123e4567-e89b-42d3-a456-426614174000',
    });
    await client.getProfile('document-core', 'latest', 'named.profile');

    assert.deepEqual(calls, [
      {
        url: '/admin/api/profiles/document-core/latest/named.profile?tenantId=00000000-0000-0000-0000-000000000001&profileId=123e4567-e89b-42d3-a456-426614174000',
        method: 'GET',
      },
      { url: '/admin/api/profiles/document-core/latest/named.profile', method: 'GET' },
    ]);
  });
});

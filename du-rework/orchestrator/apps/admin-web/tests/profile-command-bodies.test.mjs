import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPublishBody,
  buildRollbackBody,
  buildUpsertBody,
} from '../src/features/profiles/command-bodies.ts';

describe('profile mutation command identity', () => {
  const detail = { revision: 0, apiKeyId: 'active-tenant-api-key' };

  it('sends the manifest action independently from the named resource URL', () => {
    assert.deepEqual(buildUpsertBody(detail, { enabled: true }, 'analyze'), {
      action: 'analyze',
      expectedRevision: 0,
      policy: { enabled: true },
      apiKey: { apiKeyId: 'active-tenant-api-key' },
    });
  });

  it('preserves action identity on publish and rollback', () => {
    const saved = { revision: 3, apiKeyId: 'active-tenant-api-key' };
    assert.deepEqual(buildPublishBody(saved, 'analyze'), {
      action: 'analyze',
      expectedRevision: 3,
      apiKey: { apiKeyId: 'active-tenant-api-key' },
    });
    assert.deepEqual(buildRollbackBody(saved, 2, 'analyze'), {
      action: 'analyze',
      targetRevision: 2,
      expectedRevision: 3,
      apiKey: { apiKeyId: 'active-tenant-api-key' },
    });
  });
});

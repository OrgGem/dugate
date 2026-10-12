import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOperationsQuery,
  operationsCursorIsStale,
  operationsPopulation,
} from '../src/features/operations/state.ts';
import { canReadIncidentLedger } from '../src/features/system-operations/state.ts';

const base = {
  limit: '100', state: 'FAILED', sort: 'updated_at:desc', tenantId: 'tenant-a', id: 'abc',
  business: 'Document Core', action: 'extract invoice', apiKey: 'shared key', profile: 'Invoice review',
  correlation: 'trace 7', provider: 'Azure OpenAI', model: 'gpt 4.1', usage: 'no-recorded-usage',
  reservation: 'unknown', attention: 'waiting-input', cursor: 'opaque-cursor',
  fromDate: '2026-10-01', toDate: '2026-10-11',
};

describe('ORV14 Operations server-triage UI', () => {
  it('sends the full search and exact recorded-usage semantics to the server', () => {
    assert.deepEqual(buildOperationsQuery(base), {
      limit: '100', sort: 'updated_at:desc', state: 'FAILED', tenant: 'tenant-a', id: 'abc',
      business: 'Document Core', action: 'extract invoice', apiKey: 'shared key', profile: 'Invoice review',
      correlation: 'trace 7', provider: 'Azure OpenAI', model: 'gpt 4.1', usage: 'no-recorded-usage',
      reservation: 'unknown', attention: 'waiting-input', cursor: 'opaque-cursor',
      from: '2026-10-01T00:00:00.000Z', to: '2026-10-11T23:59:59.999Z',
    });
  });

  it('invalidates paging when any population field changes', () => {
    const population = operationsPopulation(base);
    for (const [field, value] of [
      ['sort', 'deadline_at:asc'], ['business', 'other'], ['action', 'review'], ['apiKey', 'next key'],
      ['profile', 'other profile'], ['correlation', 'new trace'], ['provider', 'other provider'],
      ['model', 'other model'], ['usage', 'has-recorded-usage'], ['reservation', 'any'],
      ['attention', 'any'], ['fromDate', '2026-10-02'], ['toDate', '2026-10-10'], ['limit', '20'],
    ]) {
      const selected = operationsPopulation({ ...base, [field]: value });
      assert.notEqual(selected, population, `${field} changes the server result population`);
      assert.equal(operationsCursorIsStale('cursor', population, selected), true);
    }
  });

  it('hides incident ledger affordances for local USER sessions but keeps tenant operator and viewer read paths', () => {
    const session = (role, localUser = false) => ({ plane: 'oidc', role, localUser, displayName: 'presentation label', principal: { kind: 'tenant_operator', tenantId: 'tenant-a' }, scope: { kind: 'tenant', tenantId: 'tenant-a' } });
    assert.equal(canReadIncidentLedger(session('operator', true)), false);
    assert.equal(canReadIncidentLedger(session('operator')), true);
    assert.equal(canReadIncidentLedger(session('viewer')), true);
  });
});

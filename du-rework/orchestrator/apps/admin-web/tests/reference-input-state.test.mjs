import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendReferenceOptions,
  createReferenceRequestGate,
  filterReferenceOptions,
  referenceValueForScope,
} from '../src/components/ui/reference-input-state.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function commitIfCurrent(gate, ticket, scope, query, request, state) {
  const options = await request;
  if (gate.isCurrent(ticket, scope, query)) state.value = options;
}

describe('reference input async state', () => {
  it('does not let a slow earlier query overwrite the latest suggestions', async () => {
    const gate = createReferenceRequestGate();
    const oldRequest = deferred();
    const state = { value: [] };
    const oldTicket = gate.begin('tenant-a', 'old');
    const oldCommit = commitIfCurrent(gate, oldTicket, 'tenant-a', 'old', oldRequest.promise, state);

    const currentTicket = gate.begin('tenant-a', 'new');
    await commitIfCurrent(gate, currentTicket, 'tenant-a', 'new', Promise.resolve(['new-result']), state);
    oldRequest.resolve(['old-result']);
    await oldCommit;

    assert.deepEqual(state.value, ['new-result']);
  });

  it('rejects a previous tenant response after the scope changes', async () => {
    const gate = createReferenceRequestGate();
    const oldRequest = deferred();
    const state = { value: [] };
    const oldTicket = gate.begin('tenant-a', '');
    const oldCommit = commitIfCurrent(gate, oldTicket, 'tenant-a', '', oldRequest.promise, state);

    const currentTicket = gate.begin('tenant-b', '');
    await commitIfCurrent(gate, currentTicket, 'tenant-b', '', Promise.resolve(['tenant-b-row']), state);
    oldRequest.resolve(['tenant-a-row']);
    await oldCommit;

    assert.deepEqual(state.value, ['tenant-b-row']);
  });

  it('masks a value from an old scope while preserving manual input within its scope', () => {
    assert.equal(referenceValueForScope('secret-id-a', 'tenant-a', 'tenant-b'), '');
    assert.equal(referenceValueForScope('manual-id', 'tenant-a', 'tenant-a'), 'manual-id');
    assert.equal(referenceValueForScope('manual-id', null, null), 'manual-id');
  });

  it('filters visible metadata and merges later pages without duplicate IDs', () => {
    const firstPage = [
      { value: 'business-a', label: 'Alpha', description: 'ACTIVE registry row' },
      { value: 'business-b', label: 'Beta' },
    ];
    const nextPage = [
      { value: 'business-b', label: 'Beta current' },
      { value: 'business-c', label: 'Gamma' },
    ];

    assert.deepEqual(filterReferenceOptions(firstPage, 'active').map((option) => option.value), ['business-a']);
    assert.deepEqual(appendReferenceOptions(firstPage, nextPage), [
      firstPage[0],
      nextPage[0],
      nextPage[1],
    ]);
  });
});

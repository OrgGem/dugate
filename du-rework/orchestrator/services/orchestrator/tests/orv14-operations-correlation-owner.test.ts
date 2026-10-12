import { toOperationDetailWire } from '../src/modules/operations/mappers';

test('admin operation projection exposes the persisted correlation ID without changing public projection', () => {
  const row = {
    id: 'op-1',
    tenant_id: 'tenant-1',
    state: 'RUNNING',
    state_version: 4,
    correlation_id: 'corr-aops-05',
  };

  expect(toOperationDetailWire(row)).toMatchObject({
    correlationId: 'corr-aops-05',
    tenantId: 'tenant-1',
    stateVersion: 4,
  });
});

test('admin operation projection represents absent correlation IDs as null', () => {
  expect(toOperationDetailWire({ id: 'op-2', correlation_id: null })).toHaveProperty('correlationId', null);
});

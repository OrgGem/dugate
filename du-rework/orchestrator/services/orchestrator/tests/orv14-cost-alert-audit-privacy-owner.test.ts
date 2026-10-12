import { toAuditWire, type AuditRow } from '../src/modules/audit/audit';

const ROW: AuditRow = {
  id: 'audit-1',
  tenant_id: '11111111-1111-4111-8111-111111111111',
  actor: 'session:admin@example.test',
  action: 'cost.alert.binding',
  resource: 'budget:monthly@1',
  severity: 'info',
  correlation_id: null,
  created_at: new Date('2026-10-12T00:00:00.000Z'),
};

describe('ORV14 cost-alert audit actor privacy', () => {
  test('masks historical cost-alert session subjects, including UUID-shaped values', () => {
    const wire = toAuditWire(ROW);
    expect(wire.actor).toBe('Administrator session');
    expect(JSON.stringify(wire)).not.toContain('admin@example.test');

    const uuidSubject = toAuditWire({ ...ROW, actor: 'session:22222222-2222-4222-8222-222222222222' });
    expect(uuidSubject.actor).toBe('Administrator session');
  });

  test('keeps new opaque cost-alert identities and unrelated audit actors unchanged', () => {
    const opaque = 'oidc-principal:33333333-3333-4333-8333-333333333333';
    expect(toAuditWire({ ...ROW, actor: opaque }).actor).toBe(opaque);
    expect(toAuditWire({ ...ROW, action: 'profile_binding.bind' }).actor).toBe(ROW.actor);
  });
});

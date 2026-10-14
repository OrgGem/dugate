import { isTenantUuid } from '../src';

describe('isTenantUuid', () => {
  it('remains a callable type guard from the public barrel', () => {
    const candidate: unknown = '00000000-0000-0000-0000-000000000001';
    const tenantId: string | undefined = isTenantUuid(candidate) ? candidate : undefined;

    expect(typeof isTenantUuid).toBe('function');
    expect(tenantId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('accepts canonical UUID text without restricting version or variant nibbles', () => {
    expect(isTenantUuid('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(isTenantUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isTenantUuid('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')).toBe(true);
  });

  it('rejects values that are not exactly canonical UUID text', () => {
    for (const value of [
      null,
      undefined,
      42,
      '',
      ' 00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001 ',
      '00000000-0000-0000-0000-000000000001\n',
      '00000000000000000000000000000001',
      '00000000-0000-0000-0000-00000000000g',
      '00000000-0000-0000-0000-00000000001',
    ]) {
      expect(isTenantUuid(value)).toBe(false);
    }
  });
});

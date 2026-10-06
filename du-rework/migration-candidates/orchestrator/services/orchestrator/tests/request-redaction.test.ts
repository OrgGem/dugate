import { METADATA_ENVELOPE_VERSION } from '../src/modules/runtime/metadata-crypto';
import { RequestRedactionRulesSchema } from '@du/contracts';
import { redactRequestInput } from '../src/modules/operations/request-redaction';
import { buildAdminRequestInput, type AdminOperationDetailContext } from '../src/modules/operations/mappers';
import { parseRequestRedactionRules } from '../src/modules/profiles/policy';

const email = { pattern: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}', flags: 'i' };

describe('profile request privacy', () => {
  test('rejects invalid syntax, repeated/unsafe flags, unknown options and too many rules', () => {
    for (const rules of [[{ pattern: '(' }], [{ pattern: 'x', flags: 'ii' }], [{ pattern: 'x', flags: 'y' }],
      [{ pattern: 'x', extra: true }], Array.from({ length: 21 }, () => ({ pattern: 'x' }))]) {
      expect(RequestRedactionRulesSchema.safeParse(rules).success).toBe(false);
      expect(() => parseRequestRedactionRules(rules)).toThrow(expect.objectContaining({ status: 422 }));
    }
  });

  test('masks all nested matches and numeric values while keeping selected capture groups', async () => {
    const input = { emails: ['alice@example.com', 'BOB@EXAMPLE.COM'], phone: '0901234567', identity: 123456789, amount: 25 };
    const original = JSON.stringify(input);
    const view = await redactRequestInput(input, [email,
      { pattern: '(\\d{3})\\d{4}(\\d{3})', replacement: '$1****$2' },
      { pattern: '^\\d{9}$' }], 1000);
    expect(view.status).toBe('REDACTED');
    expect(view.data).toEqual({ emails: ['[REDACTED]', '[REDACTED]'], phone: '090****567', identity: '[REDACTED]', amount: 25 });
    expect(JSON.stringify(input)).toBe(original);
  });

  test('masks sensitive object keys as well as values', async () => {
    const view = await redactRequestInput({ 'alice@example.com': { note: 'contact bob@example.com' } }, [email], 1000);
    expect(JSON.stringify(view)).not.toMatch(/alice|bob/);
    expect(view.data).toEqual({ '[REDACTED]': { note: 'contact [REDACTED]' } });
  });

  test('terminates catastrophic regex evaluation while the HTTP event loop remains responsive', async () => {
    const pending = redactRequestInput({ text: 'a'.repeat(5000) + '!' }, [{ pattern: '^(a+)+$' }], 60);
    let responsive = false;
    await new Promise<void>(resolve => setTimeout(() => { responsive = true; resolve(); }, 10));
    expect(responsive).toBe(true);
    const view = await pending;
    expect(view.status).toBe('HIDDEN');
    expect(view.data).toBe('[REDACTED]');
  });

  test('hides oversized, excessively deep and replacement-expanded data', async () => {
    expect((await redactRequestInput({ text: 'S'.repeat(300000) }, [])).status).toBe('HIDDEN');
    let deep: unknown = 'PRIVATE';
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect((await redactRequestInput(deep, [])).status).toBe('HIDDEN');
    expect((await redactRequestInput({ text: 'x'.repeat(5000) }, [
      { pattern: '(?=.)', replacement: '*'.repeat(128) },
    ], 1000)).status).toBe('HIDDEN');
  });

  test('no-rule display is a copy with an explicit unconfigured status', async () => {
    const input = { text: 'visible', values: [1, 2] };
    const view = await redactRequestInput(input, []);
    expect(view.status).toBe('NO_RULES');
    expect(view.data).toEqual(input);
    expect(view.data).not.toBe(input);
  });

  function context(rows: Record<string, unknown>[]) {
    const query = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
    return { query, ctx: { db: { query }, runtime: {}, usage: {} } as unknown as AdminOperationDetailContext };
  }
  const operation = { id: 'op-1', tenant_id: 'tenant-a', profile_id: 'profile-a', profile_revision: 1,
    input_ref: { email: 'alice@example.com', account: 'ACCOUNT-SECRET', text: 'keep me' } };

  test('current profile rules protect historical input in addition to its pinned rules', async () => {
    const { ctx, query } = context([
      { is_pinned: true, is_current: false, request_redaction: [email] },
      { is_pinned: false, is_current: true, request_redaction: [{ pattern: 'ACCOUNT-SECRET' }] },
    ]);
    const view = await buildAdminRequestInput(ctx, operation);
    expect(view?.status).toBe('REDACTED');
    expect(view?.data).toEqual({ email: '[REDACTED]', account: '[REDACTED]', text: 'keep me' });
    expect(query.mock.calls[0]?.[1]).toEqual(['profile-a', 'tenant-a', 1]);
    expect(query.mock.calls[0]?.[0]).toContain('p.tenant_id = $2');
    expect(operation.input_ref.email).toBe('alice@example.com');
  });

  test.each([
    { rows: [] },
    { rows: [{ is_pinned: true, is_current: false, request_redaction: [] }] },
    { rows: [{ is_pinned: true, is_current: true, request_redaction: [{ pattern: '(' }] }] },
  ])('missing or corrupt policy never falls back to raw input: %j', async ({ rows }) => {
    const { ctx } = context(rows);
    const view = await buildAdminRequestInput(ctx, operation);
    expect(view?.status).toBe('HIDDEN');
    expect(JSON.stringify(view)).not.toContain('ACCOUNT-SECRET');
  });

  test('sealed metadata without a decrypt seam stays completely hidden', async () => {
    const { ctx } = context([]);
    const view = await buildAdminRequestInput(ctx, { ...operation, profile_id: null,
      input_ref: { version: METADATA_ENVELOPE_VERSION, algorithm: 'aes-256-gcm', ciphertext: 'PRIVATE', nonce: 'n', tag: 't', dek: {}, aad: 'a', keyRef: 'k' } });
    expect(view?.status).toBe('HIDDEN');
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
  });
  test('decrypts with the tenant/slot binding and masks before returning', async () => {
    const { ctx } = context([{ is_pinned: true, is_current: true, request_redaction: [email] }]);
    const readStored = jest.fn(async () => operation.input_ref);
    ctx.metadataCrypto = { readStored } as unknown as NonNullable<AdminOperationDetailContext['metadataCrypto']>;
    const view = await buildAdminRequestInput(ctx, { ...operation, input_ref: { sealed: true } });
    expect(readStored).toHaveBeenCalledWith({ sealed: true }, { tenantId: 'tenant-a', slot: 'operations.input_ref', refId: String(operation.id) }, true);
    expect(view?.data).toMatchObject({ email: '[REDACTED]' });
  });

  test('decrypt exceptions cannot expose ciphertext or partial plaintext', async () => {
    const { ctx } = context([{ is_pinned: true, is_current: true, request_redaction: [email] }]);
    ctx.metadataCrypto = { readStored: async () => { throw new Error('PRIVATE-PLAINTEXT'); } } as unknown as NonNullable<AdminOperationDetailContext['metadataCrypto']>;
    const view = await buildAdminRequestInput(ctx, { ...operation, input_ref: { ciphertext: 'PRIVATE-CIPHERTEXT' } });
    expect(view?.status).toBe('HIDDEN');
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
  });

});

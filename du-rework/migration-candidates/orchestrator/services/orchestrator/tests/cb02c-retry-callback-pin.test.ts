import type { PoolClient } from 'pg';
import { ProfileCallbackPolicySnapshotSchema } from '@du/contracts';
import { retryOperation } from '../src/modules/operations/retry';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const pin = {
  tenantId, profileRevision: 4,
  profileName: 'extract.invoice', businessId: 'document-core', businessVersion: '1.0.0', endpointKey: 'extract',
  policy: { version: 1, mode: 'notification_with_result', auth: {
    method: 'oauth2_client_credentials', grantType: 'client_credentials',
    tokenUrl: 'https://idp.example.com/token', clientId: 'client-1',
    clientSecretRef: { kind: 'managed-secret', ref: 'synthetic/callback' }, clientAuthMethod: 'client_secret_post',
  }, destination: { approvedOrigins: ['https://receiver.example.com'] } },
};

describe('CB-02c retry carries the original callback pin, never a current profile', () => {
  it.each([pin, null])('copies the callback policy from the original operation at its matching SQL column', async (originalPin) => {
    if (originalPin !== null) expect(ProfileCallbackPolicySnapshotSchema.safeParse(originalPin).success).toBe(true);
    const original: Record<string, unknown> = {
      id: operationId, tenant_id: tenantId, state: 'FAILED', root_task_id: taskId,
      input_ref: { document: 'synthetic' }, submit_artifacts: [], callback_policy: originalPin,
      business_id: 'document-core', business_version: '1.0.0', action: 'extract',
      profile_policy_snapshot: { marker: 'original-profile' }, prompt_revisions_pin: { marker: 'original-prompts' },
    };
    const statements: { sql: string; params: unknown[] }[] = [];
    let copied: Record<string, unknown> | undefined;
    const client = { query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT * FROM operations')) return { rows: [original], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM tasks')) return { rows: [{ id: taskId, payload_ref: original.input_ref, kind: 'root', max_attempts: 3 }], rowCount: 1 };
      if (sql.includes('WHERE retry_of=')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO operations')) {
        const match = sql.match(/INSERT INTO operations\s*\(([^)]+)\)\s*SELECT\s+([\s\S]+?)\s+FROM operations WHERE id=\$1/);
        if (!match) throw new Error('Retry INSERT SELECT shape missing');
        const columns = match[1]!.split(',').map((s) => s.trim());
        // CASE contains no commas. Each target column must line up with its SELECT expression.
        const expressions = match[2]!.split(',').map((s) => s.trim());
        expect(expressions).toHaveLength(columns.length);
        const index = columns.indexOf('callback_policy');
        expect(columns.slice(index - 1, index + 2)).toEqual(['profile_policy_snapshot', 'callback_policy', 'prompt_revisions_pin']);
        expect(expressions.slice(index - 1, index + 2)).toEqual(['profile_policy_snapshot', 'callback_policy', 'prompt_revisions_pin']);
        expect(params[0]).toBe(operationId);
        copied = Object.fromEntries(columns.map((column, i) => {
          const expression = expressions[i]!;
          return [column, /^\$\d+$/.test(expression) ? params[Number(expression.slice(1)) - 1] : original[expression]];
        }));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT payload FROM outbox')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO tasks') || sql.includes('INSERT INTO outbox')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected SQL: ' + sql);
    } } as unknown as PoolClient;
    const result = await retryOperation(client, operationId, tenantId);
    expect(result).toMatchObject({ state: 'ACCEPTED', retryOf: operationId, replayed: false });
    expect(result.operationId).not.toBe(operationId);
    expect(copied?.callback_policy).toEqual(originalPin);
    expect(copied?.profile_policy_snapshot).toEqual(original.profile_policy_snapshot);
    expect(copied?.prompt_revisions_pin).toEqual(original.prompt_revisions_pin);
    expect(statements.some((s) => /FROM profile_bindings|FROM profile_active_revisions/.test(s.sql))).toBe(false);
    expect(JSON.stringify(copied?.callback_policy)).not.toMatch(/"(?:secretValue|accessToken)"\s*:/);
  });
});

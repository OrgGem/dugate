import { PostgresInvocationLedger } from '../src/db/repository';
import { appendUsageEvent } from '../src/usage';
import type { SqlClient, SqlResult } from '../src/db/sql';
import type { LocalInvocationRequest } from '../src/types';
import type { ConnectorProviderTestEvidenceQuery } from '@du/contracts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const INVOCATION = '44444444-4444-4444-8444-444444444444';
const CONNECTOR = 'openai-primary';
type EvidenceOutboxEvent = NonNullable<ReturnType<typeof appendUsageEvent>>;

function query(): ConnectorProviderTestEvidenceQuery {
  return {
    tenantId: TENANT,
    operationId: OPERATION,
    taskId: TASK,
    invocationId: INVOCATION,
    connectorId: CONNECTOR,
    revision: 3,
  };
}

function costContext(attempt: number): NonNullable<LocalInvocationRequest['costContext']> {
  return {
    selectionState: 'DEFERRED',
    apiKeyId: null,
    profileId: null,
    profileRevision: null,
    businessId: 'document-core',
    businessVersion: '1.1.0',
    action: 'analyze',
    attempt,
    priceRevision: null,
    budgetReservationGroupId: '55555555-5555-4555-8555-555555555555',
    budgetPins: [],
  };
}

function localRequest(costContextValue?: LocalInvocationRequest['costContext']): LocalInvocationRequest {
  return {
    contractVersion: '1' as const,
    invocationId: INVOCATION,
    tenantId: TENANT,
    operationId: OPERATION,
    taskId: TASK,
    stepKey: 'admin-provider-test:invoice-check',
    bindingSlot: 'provider-test:invoice-check',
    input: { prompt: 'test' },
    deadlineAt: '2026-10-11T12:00:00.000Z',
    connectorId: CONNECTOR,
    connectorRevision: 3,
    adminPurpose: 'admin-provider-test' as const,
    ...(costContextValue === undefined ? {} : { costContext: costContextValue }),
  };
}

function persistedRow(state: string, result: unknown, request: LocalInvocationRequest = localRequest()) {
  return {
    invocation_id: INVOCATION,
    tenant_id: TENANT,
    operation_id: OPERATION,
    task_id: TASK,
    step_key: 'admin-provider-test:invoice-check',
    input_hash: 'sha256:test',
    request,
    state,
    result,
    error_code: null,
    provider_request_id: null,
    session_ref: null,
    next_poll_at: null,
    poll_lease_token: null,
    poll_lease_expires_at: null,
    quota_lease_key: null,
    quota_lease_id: null,
    quota_lease_expires_at: null,
    provider_poll_attempts: 0,
    state_version: '7',
    updated_at: '2026-10-11T11:59:00.000Z',
  };
}

function outboxEvent(): EvidenceOutboxEvent {
  return {
    eventId: `${INVOCATION}:1`,
    invocationId: INVOCATION,
    operationId: OPERATION,
    taskId: TASK,
    createdAt: '2026-10-11T11:59:00.000Z',
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      costMicrousd: 42,
      measurement: 'measured' as const,
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
    },
  };
}

function costControlledOutboxEvent(attempt: number) {
  const event = appendUsageEvent(INVOCATION, attempt, {
    inputTokens: 12,
    outputTokens: 8,
    costMicrousd: 42,
    measurement: 'measured',
    provider: 'openai',
    model: 'gpt-4o-2024-08-06',
  }, { operationId: OPERATION, taskId: TASK });
  if (!event) throw new Error('Expected provider-test usage event.');
  return event;
}

class EvidenceDb implements SqlClient {
  public constructor(
    private readonly row: ReturnType<typeof persistedRow> | undefined,
    private readonly outbox: EvidenceOutboxEvent = outboxEvent(),
  ) {}

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    if (text.includes('FROM connector_invocations')) {
      const [invocationId, tenantId, operationId, taskId] = parameters;
      const match = this.row
        && this.row.invocation_id === invocationId
        && this.row.tenant_id === tenantId
        && this.row.operation_id === operationId
        && this.row.task_id === taskId;
      return { rows: (match ? [this.row as unknown as Row] : []) };
    }
    if (text.includes('FROM connector_usage_outbox')) {
      const [eventId, invocationId] = parameters;
      return {
        rows: eventId === this.outbox.eventId && invocationId === this.outbox.invocationId
          ? [{ event_id: this.outbox.eventId, invocation_id: this.outbox.invocationId, payload: this.outbox, delivered_at: null } as unknown as Row]
          : [],
      };
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

describe('ORV14 source-bound provider-test recovery evidence', () => {
  it('proves recovery only from the exact successful ledger result and linked usage outbox event', async () => {
    const attempt = 2;
    const writerEvent = costControlledOutboxEvent(attempt);
    const db = new EvidenceDb(persistedRow('SUCCEEDED', {
      content: 'stored mapped answer',
      providerTestContentSanitized: true,
      providerStatusCode: 200,
      providerLatencyMs: 83,
      usage: { inputTokens: 12, outputTokens: 8, costMicrousd: 42, measurement: 'measured' },
    }, localRequest(costContext(attempt))), writerEvent);
    const ledger = new PostgresInvocationLedger(db, { legacyPlaintextReads: true });

    const evidence = await ledger.getProviderTestEvidence(query());

    expect(evidence).toMatchObject({
      state: 'SUCCEEDED',
      stateVersion: 7,
      recoveryReady: true,
      result: { content: 'stored mapped answer', contentSanitized: true, statusCode: 200, latencyMs: 83 },
      usageEvent: { eventId: writerEvent.eventId, inputTokens: 12, outputTokens: 8, costMicrousd: 42 },
    });
    expect(writerEvent.eventId).not.toBe(`${INVOCATION}:1`);
    expect(evidence?.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence?.result?.resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence?.usageEvent?.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('keeps UNKNOWN without persisted result and outbox proof unresolved', async () => {
    const db = new EvidenceDb(persistedRow('UNKNOWN', null));
    const ledger = new PostgresInvocationLedger(db, { legacyPlaintextReads: true });

    const evidence = await ledger.getProviderTestEvidence(query());

    expect(evidence).toMatchObject({ state: 'UNKNOWN', recoveryReady: false, result: null, usageEvent: null });
  });

  it('withholds legacy provider-test result content without a Connector redaction marker', async () => {
    const db = new EvidenceDb(persistedRow('SUCCEEDED', {
      content: 'unverified result may echo a credential',
      providerStatusCode: 200,
      usage: { inputTokens: 12, outputTokens: 8, costMicrousd: 42, measurement: 'measured' },
    }));
    const ledger = new PostgresInvocationLedger(db, { legacyPlaintextReads: true });

    const evidence = await ledger.getProviderTestEvidence(query());

    expect(evidence).toMatchObject({
      recoveryReady: true,
      result: { content: null, contentTruncated: false },
      usageEvent: { eventId: `${INVOCATION}:1` },
    });
    expect(JSON.stringify(evidence)).not.toContain('unverified result may echo a credential');
  });

  it('does not return evidence across the tenant fence or for a non-test invocation', async () => {
    const wrongTenantDb = new EvidenceDb({ ...persistedRow('SUCCEEDED', { content: 'answer' }), tenant_id: '99999999-9999-4999-8999-999999999999' });
    const wrongTenantLedger = new PostgresInvocationLedger(wrongTenantDb, { legacyPlaintextReads: true });
    expect(await wrongTenantLedger.getProviderTestEvidence(query())).toBeUndefined();

    const { adminPurpose: _adminPurpose, ...ordinaryRequest } = localRequest();
    const ordinaryDb = new EvidenceDb(persistedRow('SUCCEEDED', { content: 'answer' }, ordinaryRequest));
    const ordinaryLedger = new PostgresInvocationLedger(ordinaryDb, { legacyPlaintextReads: true });
    expect(await ordinaryLedger.getProviderTestEvidence(query())).toBeUndefined();
  });
});

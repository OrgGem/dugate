import {
  BusinessJobV1Schema,
  businessQueueName,
  isValidQueueName,
  jobIdForDelivery,
} from '../src';

describe('BusinessJobV1 wire contract (docs 09)', () => {
  const validJob = {
    contractVersion: '1',
    deliveryId: 'outbox-123',
    taskId: '6f9d0e8a-2b4c-4e6f-8a0b-1c2d3e4f5a6b',
    operationId: '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    kind: 'root',
    correlationId: 'corr-0123456789',
  };

  it('accepts a well-formed job', () => {
    const result = BusinessJobV1Schema.safeParse(validJob);
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const result = BusinessJobV1Schema.safeParse({ ...validJob, secretPrompt: 'leak me' });
    expect(result.success).toBe(false);
  });

  it('rejects contractVersion other than 1', () => {
    expect(BusinessJobV1Schema.safeParse({ ...validJob, contractVersion: '2' }).success).toBe(false);
  });

  it('serialization round-trip preserves strict equality', () => {
    const parsed = BusinessJobV1Schema.parse(validJob);
    const roundTripped = BusinessJobV1Schema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});

describe('queue naming (docs 05/09)', () => {
  it('derives exact-version queue name', () => {
    expect(businessQueueName('document-core', '1.0.0')).toBe('du-business-document-core-1.0.0');
    expect(businessQueueName('example-review', '2.1.3')).toBe('du-business-example-review-2.1.3');
  });

  it('validates queue name shape', () => {
    expect(isValidQueueName('du-business-document-core-1.0.0')).toBe(true);
    expect(isValidQueueName('du-business-document-core-1.0.0-rc.1')).toBe(true);
    expect(isValidQueueName('du-business-document-core-latest')).toBe(false); // no floating tags
    expect(isValidQueueName('arbitrary-queue')).toBe(false);
    expect(isValidQueueName('du-business-DocumentCore-1.0.0')).toBe(false); // slug must be lowercase
  });

  it('job IDs are deterministic from delivery ID (long-term dedup)', () => {
    expect(jobIdForDelivery('outbox-123')).toBe('du-outbox-123');
    expect(jobIdForDelivery('outbox-123')).toBe(jobIdForDelivery('outbox-123'));
    // BullMQ forbids ':' in custom job IDs; retry deliveryIds fold ':' to '-'.
    expect(jobIdForDelivery('task:retry:2')).toBe('du-task-retry-2');
    expect(jobIdForDelivery('task:retry:2')).not.toContain(':');
  });
});
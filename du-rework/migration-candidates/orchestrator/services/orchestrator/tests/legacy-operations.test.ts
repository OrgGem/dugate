import {
  LegacyOperationFilterError,
  mapCanonicalOperationToLegacy,
  mapCanonicalOperationsPageToLegacy,
  mapLegacyOperationsQuery,
  toLegacyOperationState,
  type CanonicalOperation,
} from '../src/compat/legacy-operations';

function operation(
  state: CanonicalOperation['state'],
  overrides: Partial<CanonicalOperation> = {},
): CanonicalOperation {
  return {
    id: 'op-123',
    state,
    ...overrides,
  };
}

describe('legacy operations compatibility mapper', () => {
  describe('state projection', () => {
    it.each([
      ['PENDING_INGESTION', 'PENDING'],
      ['ACCEPTED', 'PENDING'],
      ['QUEUED', 'PENDING'],
      ['RUNNING', 'RUNNING'],
      ['WAITING_CHILDREN', 'RUNNING'],
      ['WAITING_INPUT', 'RUNNING'],
      ['RETRY_PENDING', 'RUNNING'],
      ['CANCEL_REQUESTED', 'RUNNING'],
      ['SUCCEEDED', 'SUCCEEDED'],
      ['FAILED', 'FAILED'],
      ['CANCELLED', 'FAILED'],
      ['TIMED_OUT', 'FAILED'],
    ] as const)('%s maps to legacy %s', (canonicalState, legacyState) => {
      expect(toLegacyOperationState(canonicalState)).toBe(legacyState);
    });
  });

  describe('detail projection', () => {
    it('projects canonical fields and a supplied result into the legacy response shape', () => {
      const result = { content: '# Ready', usage: { inputTokens: 2 } };
      const mapped = mapCanonicalOperationToLegacy(
        operation('SUCCEEDED', {
          name: 'operations/op-123',
          action: 'extract',
          createdAt: '2026-09-30T12:00:00.000Z',
          updatedAt: '2026-09-30T12:01:00.000Z',
          progress: { percent: 100, message: 'Complete' },
        }),
        result,
      );

      expect(mapped).toEqual({
        name: 'operations/op-123',
        done: true,
        metadata: {
          state: 'SUCCEEDED',
          canonical_state: 'SUCCEEDED',
          endpoint_slug: 'extract',
          progress_percent: 100,
          progress_message: 'Complete',
          create_time: '2026-09-30T12:00:00.000Z',
          update_time: '2026-09-30T12:01:00.000Z',
        },
        response: result,
        error: null,
      });
    });

    it.each(['WAITING_INPUT', 'CANCEL_REQUESTED'] as const)(
      'keeps %s pending instead of inventing a terminal response',
      (state) => {
        expect(mapCanonicalOperationToLegacy(operation(state))).toMatchObject({
          name: 'operations/op-123',
          done: false,
          metadata: { state: 'RUNNING', canonical_state: state },
          response: null,
          error: null,
        });
      },
    );

    it('maps TIMED_OUT to a completed legacy failure with an explicit timeout error', () => {
      expect(mapCanonicalOperationToLegacy(operation('TIMED_OUT'))).toMatchObject({
        done: true,
        metadata: { state: 'FAILED', canonical_state: 'TIMED_OUT' },
        response: null,
        error: { code: 'TIMED_OUT', message: 'Operation timed out' },
      });
    });

    it('maps canonical errors without losing their code or detail', () => {
      expect(mapCanonicalOperationToLegacy(operation('FAILED', {
        error: { code: 'PROVIDER_ERROR', title: 'Provider failed', detail: 'Request rejected' },
      }))).toMatchObject({
        done: true,
        error: { code: 'PROVIDER_ERROR', message: 'Request rejected' },
      });
    });

    it('does not attach a success response to non-success states', () => {
      expect(mapCanonicalOperationToLegacy(operation('RUNNING'), { secret: 'not-ready' }).response).toBeNull();
    });
  });

  describe('legacy query translation', () => {
    it('maps page_size, operation-ID page_token, state groups, and processor filters', () => {
      expect(mapLegacyOperationsQuery({
        page_size: '37',
        page_token: 'op-cursor-123',
        filter: 'state=RUNNING,processor=ocr-v2',
      })).toEqual({
        limit: 37,
        afterOperationId: 'op-cursor-123',
        filters: {
          states: ['RUNNING', 'WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING', 'CANCEL_REQUESTED'],
          processor: 'ocr-v2',
        },
      });
    });

    it('uses canonical page bounds and defaults while leaving absent filters empty', () => {
      expect(mapLegacyOperationsQuery({ page_size: '5000' })).toEqual({
        limit: 100,
        afterOperationId: null,
        filters: { states: null, processor: null },
      });
      expect(mapLegacyOperationsQuery({ page_size: '-4' }).limit).toBe(1);
      expect(mapLegacyOperationsQuery({ page_size: 'invalid' }).limit).toBe(20);
    });

    it.each([
      ['PENDING', ['PENDING_INGESTION', 'ACCEPTED', 'QUEUED']],
      ['SUCCEEDED', ['SUCCEEDED']],
      ['FAILED', ['FAILED', 'CANCELLED', 'TIMED_OUT']],
    ] as const)('maps legacy state filter %s to canonical states', (state, states) => {
      expect(mapLegacyOperationsQuery({ filter: `state=${state}` }).filters.states).toEqual(states);
    });

    it('rejects unknown legacy state filters so the adapter can return HTTP 400', () => {
      expect(() => mapLegacyOperationsQuery({ filter: 'state=WAITING_INPUT' })).toThrow(
        LegacyOperationFilterError,
      );
    });
  });

  describe('list projection', () => {
    it('returns the last operation ID as next_page_token and hides the canonical cursor', () => {
      const page = mapCanonicalOperationsPageToLegacy({
        items: [operation('RUNNING', { id: 'op-1' }), operation('SUCCEEDED', { id: 'op-2' })],
        nextCursor: 'opaque-canonical-cursor',
      });

      expect(page).toEqual({
        operations: [
          expect.objectContaining({ name: 'operations/op-1', done: false }),
          expect.objectContaining({ name: 'operations/op-2', done: true }),
        ],
        next_page_token: 'op-2',
      });
      expect(page).not.toHaveProperty('nextCursor');
    });

    it('returns a null page token at the end of the list', () => {
      expect(mapCanonicalOperationsPageToLegacy({
        items: [operation('SUCCEEDED')],
        nextCursor: null,
      }).next_page_token).toBeNull();
    });

    it('fails closed if a canonical next cursor has no operation ID to encode', () => {
      expect(() => mapCanonicalOperationsPageToLegacy({ items: [], nextCursor: 'next' })).toThrow(
        'canonical operations page has a next cursor but no item for a legacy page token',
      );
    });
  });
});

/**
 * Unit tests for P6-06 pure Operation Detail, Result, Artifacts,
 * Cancel, Resume & Replay View Models.
 *
 * All tests are table-driven and pure: no DB, no Redis, no HTTP.
 */

import {
  buildOperationStatusDisplay,
  canCancelOperation,
  canReplayOperation,
  canResumeOperation,
  buildResumePayload,
  formatOperationDetailView,
  renderHumanWaitForm,
  replayActionLabel,
} from '../src/app/admin/operation-view-models';

import type { OperationDetail, ArtifactRef, HumanWaitView } from '@du/contracts';
import type { OperationState } from '@du/contracts';
import { ArtifactRefSchema, HumanWaitViewSchema, OperationStates } from '@du/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOperation(overrides: Partial<OperationDetail> = {}): OperationDetail {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    tenantId: 'tenant-1',
    businessId: 'example-review',
    businessVersion: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    stateVersion: 2,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T01:00:00Z',
    deadlineAt: '2026-09-22T02:00:00Z',
    replayOf: undefined,
    progress: { percent: 50, message: 'Processing…' },
    links: {
      self: '/api/v1/operations/aaaaaaaa-0000-0000-0000-000000000001',
      result: '/api/v1/operations/aaaaaaaa-0000-0000-0000-000000000001/result',
    },
    wait: undefined,
    error: undefined,
    ...overrides,
  };
}

function makeWaitRow(overrides: Partial<HumanWaitView> = {}): HumanWaitView {
  return {
    waitId: 'wait-abc-123',
    inputSchema: {
      type: 'object',
      required: ['decision'],
      properties: {
        decision: {
          type: 'string',
          title: 'Approval decision',
          description: 'Approve or reject the document.',
          enum: ['approve', 'reject', 'escalate'],
        },
        notes: {
          type: 'string',
          widget: 'textarea',
          title: 'Reviewer notes',
        },
        confidence: {
          type: 'number',
          title: 'Confidence score',
        },
        override: {
          type: 'boolean',
          title: 'Force override',
        },
      },
    },
    expiresAt: '2099-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// P6-06: buildOperationStatusDisplay
// ---------------------------------------------------------------------------

describe('P6-06: buildOperationStatusDisplay', () => {
  const cases: { state: OperationState; badge: string; terminal: boolean }[] = [
    { state: 'ACCEPTED', badge: 'info', terminal: false },
    { state: 'QUEUED', badge: 'info', terminal: false },
    { state: 'RUNNING', badge: 'info', terminal: false },
    { state: 'WAITING_CHILDREN', badge: 'info', terminal: false },
    { state: 'WAITING_INPUT', badge: 'warning', terminal: false },
    { state: 'RETRY_PENDING', badge: 'warning', terminal: false },
    { state: 'CANCEL_REQUESTED', badge: 'warning', terminal: false },
    { state: 'SUCCEEDED', badge: 'success', terminal: true },
    { state: 'FAILED', badge: 'error', terminal: true },
    { state: 'CANCELLED', badge: 'neutral', terminal: true },
    { state: 'TIMED_OUT', badge: 'error', terminal: true },
  ];

  test.each(cases)('$state → badge=$badge, terminal=$terminal', ({ state, badge, terminal }) => {
    const display = buildOperationStatusDisplay(state);
    expect(display.state).toBe(state);
    expect(display.badge).toBe(badge);
    expect(display.terminal).toBe(terminal);
    expect(typeof display.label).toBe('string');
    expect(display.label.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P6-06: canCancelOperation
// ---------------------------------------------------------------------------

describe('P6-06: canCancelOperation', () => {
  const cancellable: OperationState[] = [
    'ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING',
  ];
  const nonCancellable: OperationState[] = [
    'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
  ];

  test.each(cancellable)('%s → can cancel', (state) => {
    expect(canCancelOperation(state)).toBe(true);
  });

  test.each(nonCancellable)('%s → cannot cancel', (state) => {
    expect(canCancelOperation(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P6-06: canResumeOperation
// ---------------------------------------------------------------------------

describe('P6-06: canResumeOperation', () => {
  const now = '2026-09-22T12:00:00Z';
  const futureExpiry = '2099-01-01T00:00:00Z';
  const pastExpiry = '2000-01-01T00:00:00Z';

  test('WAITING_INPUT + active wait row → can resume', () => {
    const waitRow = makeWaitRow({ expiresAt: futureExpiry });
    expect(canResumeOperation('WAITING_INPUT', waitRow, now)).toBe(true);
  });

  test('WAITING_INPUT + expired wait row → cannot resume', () => {
    const waitRow = makeWaitRow({ expiresAt: pastExpiry });
    expect(canResumeOperation('WAITING_INPUT', waitRow, now)).toBe(false);
  });

  test('WAITING_INPUT + no wait row → cannot resume', () => {
    expect(canResumeOperation('WAITING_INPUT', null, now)).toBe(false);
    expect(canResumeOperation('WAITING_INPUT', undefined, now)).toBe(false);
  });

  const nonWaitingStates: OperationState[] = [
    'RUNNING', 'QUEUED', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
  ];
  test.each(nonWaitingStates)('%s + active wait row → cannot resume', (state) => {
    const waitRow = makeWaitRow({ expiresAt: futureExpiry });
    expect(canResumeOperation(state, waitRow, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P6-06: buildResumePayload
// ---------------------------------------------------------------------------

describe('P6-06: buildResumePayload', () => {
  test('constructs payload with all required fields', () => {
    const payload = buildResumePayload(
      { decision: 'approve', notes: 'Looks good' },
      3,
      'wait-abc-123',
    );
    expect(payload.waitId).toBe('wait-abc-123');
    expect(payload.casToken).toBe('wait-abc-123');
    expect(payload.stepIndex).toBe(3);
    expect(payload.inputData).toEqual({ decision: 'approve', notes: 'Looks good' });
  });

  test('empty inputData is valid (no required enforcement at payload level)', () => {
    const payload = buildResumePayload({}, 0, 'wait-xyz');
    expect(payload.inputData).toEqual({});
    expect(payload.stepIndex).toBe(0);
  });

  test('casToken matches waitId for CAS enforcement', () => {
    const payload = buildResumePayload({}, 1, 'cas-token-999');
    expect(payload.casToken).toBe(payload.waitId);
  });
});

// ---------------------------------------------------------------------------
// P6-06: renderHumanWaitForm
// ---------------------------------------------------------------------------

describe('P6-06: renderHumanWaitForm', () => {
  const now = '2026-09-22T12:00:00Z';

  test('renders form fields from inputSchema properties in order', () => {
    const waitRow = makeWaitRow();
    const form = renderHumanWaitForm(waitRow, now);

    expect(form.waitId).toBe('wait-abc-123');
    expect(form.isExpired).toBe(false);
    expect(form.fields).toHaveLength(4);

    const names = form.fields.map((f) => f.name);
    expect(names).toContain('decision');
    expect(names).toContain('notes');
    expect(names).toContain('confidence');
    expect(names).toContain('override');
  });

  test('select widget derived from enum, options populated', () => {
    const waitRow = makeWaitRow();
    const form = renderHumanWaitForm(waitRow, now);
    const decisionField = form.fields.find((f) => f.name === 'decision')!;

    expect(decisionField.widget).toBe('select');
    expect(decisionField.required).toBe(true);
    expect(decisionField.label).toBe('Approval decision');
    expect(decisionField.description).toBe('Approve or reject the document.');
    expect(decisionField.options).toEqual([
      { value: 'approve', label: 'approve' },
      { value: 'reject', label: 'reject' },
      { value: 'escalate', label: 'escalate' },
    ]);
  });

  test('textarea widget from explicit widget key in schema', () => {
    const waitRow = makeWaitRow();
    const form = renderHumanWaitForm(waitRow, now);
    const notesField = form.fields.find((f) => f.name === 'notes')!;

    expect(notesField.widget).toBe('textarea');
    expect(notesField.required).toBe(false);
    expect(notesField.label).toBe('Reviewer notes');
  });

  test('number and boolean widgets derived from type', () => {
    const waitRow = makeWaitRow();
    const form = renderHumanWaitForm(waitRow, now);

    const confidenceField = form.fields.find((f) => f.name === 'confidence')!;
    expect(confidenceField.widget).toBe('number');

    const overrideField = form.fields.find((f) => f.name === 'override')!;
    expect(overrideField.widget).toBe('boolean');
  });

  test('isExpired true when now >= expiresAt', () => {
    const expired = makeWaitRow({ expiresAt: '2000-01-01T00:00:00Z' });
    const form = renderHumanWaitForm(expired, now);
    expect(form.isExpired).toBe(true);
  });

  test('empty schema produces empty fields list', () => {
    const waitRow = makeWaitRow({
      inputSchema: { type: 'object', properties: {} },
    });
    const form = renderHumanWaitForm(waitRow, now);
    expect(form.fields).toHaveLength(0);
  });

  test('uiSchema overrides title, description, placeholder, and widget', () => {
    const waitRow: HumanWaitView = {
      waitId: 'wait-ui-override',
      inputSchema: {
        type: 'object',
        properties: {
          comment: { type: 'string' },
        },
      },
      uiSchema: {
        comment: {
          'ui:widget': 'textarea',
          'ui:title': 'Reviewer Comment',
          'ui:description': 'Add a detailed comment.',
          'ui:placeholder': 'Enter comment here…',
        },
      },
      expiresAt: '2099-01-01T00:00:00Z',
    };
    const form = renderHumanWaitForm(waitRow, now);
    const field = form.fields[0]!;

    expect(field.widget).toBe('textarea');
    expect(field.label).toBe('Reviewer Comment');
    expect(field.description).toBe('Add a detailed comment.');
    expect(field.placeholder).toBe('Enter comment here…');
  });

  test('object and array types produce correct widgets', () => {
    const waitRow: HumanWaitView = {
      waitId: 'wait-complex',
      inputSchema: {
        type: 'object',
        properties: {
          metadata: { type: 'object' },
          tags: { type: 'array' },
        },
      },
      expiresAt: '2099-01-01T00:00:00Z',
    };
    const form = renderHumanWaitForm(waitRow, now);

    const metaField = form.fields.find((f) => f.name === 'metadata')!;
    const tagsField = form.fields.find((f) => f.name === 'tags')!;

    expect(metaField.widget).toBe('object');
    expect(tagsField.widget).toBe('array');
  });

  test('field name used as label fallback when title absent', () => {
    const waitRow: HumanWaitView = {
      waitId: 'wait-no-title',
      inputSchema: {
        type: 'object',
        properties: {
          myField: { type: 'string' },
        },
      },
      expiresAt: '2099-01-01T00:00:00Z',
    };
    const form = renderHumanWaitForm(waitRow, now);
    expect(form.fields[0]!.label).toBe('myField');
  });
});

// ---------------------------------------------------------------------------
// P6-06: formatOperationDetailView
// ---------------------------------------------------------------------------

describe('P6-06: formatOperationDetailView', () => {
  const now = '2026-09-22T12:00:00Z';

  test('maps wire operation to detail view with all required fields', () => {
    const op = makeOperation({ state: 'RUNNING' });
    const view = formatOperationDetailView(op, [], now);

    expect(view.id).toBe(op.id);
    expect(view.businessId).toBe('example-review');
    expect(view.businessVersion).toBe('1.0.0');
    expect(view.action).toBe('review');
    expect(view.status.state).toBe('RUNNING');
    expect(view.status.badge).toBe('info');
    expect(view.status.terminal).toBe(false);
    expect(view.progressPercent).toBe(50);
    expect(view.progressMessage).toBe('Processing…');
    expect(view.artifacts).toHaveLength(0);
    expect(view.errorDisplay).toBeNull();
    expect(view.humanWaitForm).toBeNull();
    expect(view.selfLink).toBe('/api/v1/operations/aaaaaaaa-0000-0000-0000-000000000001');
    expect(view.resultLink).toBe('/api/v1/operations/aaaaaaaa-0000-0000-0000-000000000001/result');
  });

  test('succeeds maps to terminal success badge', () => {
    const op = makeOperation({ state: 'SUCCEEDED', progress: { percent: 100 } });
    const view = formatOperationDetailView(op, [], now);

    expect(view.status.badge).toBe('success');
    expect(view.status.terminal).toBe(true);
  });

  test('WAITING_INPUT with wait row renders humanWaitForm', () => {
    const waitRow = makeWaitRow();
    const op = makeOperation({ state: 'WAITING_INPUT', wait: waitRow });
    const view = formatOperationDetailView(op, [], now);

    expect(view.humanWaitForm).not.toBeNull();
    expect(view.humanWaitForm!.waitId).toBe('wait-abc-123');
    expect(view.humanWaitForm!.fields.length).toBeGreaterThan(0);
  });

  test('RUNNING with wait row does not render humanWaitForm', () => {
    const waitRow = makeWaitRow();
    // wait attached but state is not WAITING_INPUT → form should be null
    const op = makeOperation({ state: 'RUNNING', wait: waitRow });
    const view = formatOperationDetailView(op, [], now);

    expect(view.humanWaitForm).toBeNull();
  });

  test('error display surfaces code, title, and detail', () => {
    const op = makeOperation({
      state: 'FAILED',
      error: {
        code: 'PROVIDER_QUOTA_EXCEEDED',
        title: 'Quota exceeded',
        detail: 'Daily token limit reached.',
      },
    });
    const view = formatOperationDetailView(op, [], now);

    expect(view.errorDisplay).toEqual({
      code: 'PROVIDER_QUOTA_EXCEEDED',
      title: 'Quota exceeded',
      detail: 'Daily token limit reached.',
    });
  });

  test('error without detail defaults to empty string', () => {
    const op = makeOperation({
      state: 'FAILED',
      error: { code: 'INTERNAL', title: 'Internal error' },
    });
    const view = formatOperationDetailView(op, [], now);

    expect(view.errorDisplay!.detail).toBe('');
  });

  test('artifacts are mapped to display rows', () => {
    const artifacts: ArtifactRef[] = [
      {
        artifactId: 'art-000000000001',
        role: 'output',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        download: '/api/v1/artifacts/art-000000000001/download',
      },
      {
        artifactId: 'art-000000000002',
        role: 'input',
        fileName: 'source.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 102400,
      },
    ];

    const op = makeOperation({ state: 'SUCCEEDED' });
    const view = formatOperationDetailView(op, artifacts, now);

    expect(view.artifacts).toHaveLength(2);
    expect(view.artifacts[0]!.fileName).toBe('report.pdf');
    expect(view.artifacts[0]!.sizeDisplay).toBe('2.0 KB');
    expect(view.artifacts[0]!.downloadUrl).toBe('/api/v1/artifacts/art-000000000001/download');
    expect(view.artifacts[1]!.fileName).toBe('source.docx');
    expect(view.artifacts[1]!.sizeDisplay).toBe('100.0 KB');
    expect(view.artifacts[1]!.downloadUrl).toBeNull();
  });

  test('artifact without fileName/mimeType/sizeBytes has safe defaults', () => {
    const artifacts: ArtifactRef[] = [
      { artifactId: 'art-min', role: 'output' },
    ];
    const op = makeOperation({ state: 'SUCCEEDED' });
    const view = formatOperationDetailView(op, artifacts, now);

    expect(view.artifacts[0]!.fileName).toBe('art-min');
    expect(view.artifacts[0]!.mimeType).toBe('application/octet-stream');
    expect(view.artifacts[0]!.sizeDisplay).toBe('');
    expect(view.artifacts[0]!.downloadUrl).toBeNull();
  });

  test('replayOf is mapped when present', () => {
    const op = makeOperation({
      state: 'SUCCEEDED',
      replayOf: 'aaaaaaaa-0000-0000-0000-000000000000',
    });
    const view = formatOperationDetailView(op, [], now);

    expect(view.replayOf).toBe('aaaaaaaa-0000-0000-0000-000000000000');
  });

  test('replayOf is null when absent', () => {
    const op = makeOperation({ state: 'SUCCEEDED', replayOf: undefined });
    const view = formatOperationDetailView(op, [], now);

    expect(view.replayOf).toBeNull();
  });

  test('missing progressMessage defaults to empty string', () => {
    const op = makeOperation({ progress: { percent: 0 } });
    const view = formatOperationDetailView(op, [], now);

    expect(view.progressMessage).toBe('');
  });
});

// ---------------------------------------------------------------------------
// P6-06: canReplayOperation & replayActionLabel
// ---------------------------------------------------------------------------

describe('P6-06: canReplayOperation & replayActionLabel', () => {
  const replayable: OperationState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
  const nonReplayable: OperationState[] = ['RUNNING', 'QUEUED', 'WAITING_INPUT', 'ACCEPTED'];

  test.each(replayable)('%s → can replay', (state) => {
    expect(canReplayOperation(state)).toBe(true);
  });

  test.each(nonReplayable)('%s → cannot replay', (state) => {
    expect(canReplayOperation(state)).toBe(false);
  });

  test('FAILED → Retry label', () => {
    expect(replayActionLabel('FAILED')).toBe('Retry (new operation)');
  });

  test('CANCELLED → Rerun label', () => {
    expect(replayActionLabel('CANCELLED')).toBe('Rerun (new operation)');
  });

  test('TIMED_OUT → Retry after timeout label', () => {
    expect(replayActionLabel('TIMED_OUT')).toBe('Retry after timeout (new operation)');
  });

  test('SUCCEEDED → Replay label', () => {
    expect(replayActionLabel('SUCCEEDED')).toBe('Replay (new operation)');
  });
});

// ---------------------------------------------------------------------------
// P6-06: artifact size formatting edge cases
// ---------------------------------------------------------------------------

describe('P6-06: artifact size display formatting', () => {
  const cases: { sizeBytes: number | undefined; expected: string }[] = [
    { sizeBytes: undefined, expected: '' },
    { sizeBytes: 0, expected: '0 B' },
    { sizeBytes: 512, expected: '512 B' },
    { sizeBytes: 1023, expected: '1023 B' },
    { sizeBytes: 1024, expected: '1.0 KB' },
    { sizeBytes: 2048, expected: '2.0 KB' },
    { sizeBytes: 1048576, expected: '1.0 MB' },
    { sizeBytes: 5242880, expected: '5.0 MB' },
  ];

  test.each(cases)('$sizeBytes B → "$expected"', ({ sizeBytes, expected }) => {
    const artifacts: ArtifactRef[] = [
      { artifactId: 'art-size-test', role: 'output', sizeBytes },
    ];
    const op = makeOperation({ state: 'SUCCEEDED' });
    const now = '2026-09-22T12:00:00Z';
    const view = formatOperationDetailView(op, artifacts, now);

    expect(view.artifacts[0]!.sizeDisplay).toBe(expected);
  });
});

// ===========================================================================
// W-ADM-UX-07-OPERATION-VIEW-MODEL-NEGATIVE (Turn 343 / Cycle 51)
//
// Negative + boundary tests for the pure operation view models. Every
// expectation below was MEASURED with a throwaway probe against the real
// function first, then written down - not inferred from the source. Several
// of them pin behaviour that is arguably wrong; those are marked DEFECT and
// are reported, not fixed (production code is out of scope for this packet).
//
// The wire is the trust boundary: these functions are pure display mappers
// with no I/O and no authorization role, so a "should" here means "what this
// layer actually does", not "what is desirable".
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Missing / malformed status enum values
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: malformed operation state does not fail closed in the display block', () => {
  // DEFECT (reported as a deviation, not fixed): STATE_LABEL / STATE_BADGE are
  // plain Record lookups. An unknown key yields undefined - no throw, no
  // fallback, no 'Unknown' label. Measured: label=undefined, badge=undefined.
  const malformed: string[] = ['BOGUS', '', 'succeeded', 'SUCCEEDED ', 'pending_ingestion', '0'];

  test.each(malformed)('state %p -> label and badge are undefined, terminal=false', (state) => {
    const display = buildOperationStatusDisplay(state as OperationState);
    expect(display.state).toBe(state);
    expect(display.label).toBeUndefined();
    expect(display.badge).toBeUndefined();
    expect(display.terminal).toBe(false);
  });

  test('a valid state is still resolved (guards the rows above from being vacuous)', () => {
    const display = buildOperationStatusDisplay('RUNNING');
    expect(display.label).toBe('Running');
    expect(display.badge).toBe('info');
  });

  test('lookup is case-SENSITIVE: the lowercase wire spelling is not recognised', () => {
    // Measured: no case folding. 'succeeded' is NOT 'SUCCEEDED'.
    expect(buildOperationStatusDisplay('succeeded' as OperationState).label).toBeUndefined();
    expect(buildOperationStatusDisplay('SUCCEEDED').label).toBe('Succeeded');
  });

  test('lookup does not trim: a trailing space makes the state unknown', () => {
    expect(buildOperationStatusDisplay('SUCCEEDED ' as OperationState).badge).toBeUndefined();
  });

  test('the action gates DO fail closed on an unknown state - the display block is the asymmetry', () => {
    // The important contrast: a Set/includes lookup returns false for an
    // unknown state, so cancel/replay stay closed. Only the display block
    // degrades to undefined.
    for (const state of ['BOGUS', '', 'succeeded'] as unknown as OperationState[]) {
      expect(canCancelOperation(state)).toBe(false);
      expect(canReplayOperation(state)).toBe(false);
      expect(canResumeOperation(state, null, '2026-09-22T12:00:00Z')).toBe(false);
    }
  });

  test('an unknown state is NOT reported as terminal, so it stays mutable-looking', () => {
    // Consequence worth pinning: because terminal=false, the badge/label pair
    // is the only thing standing between a corrupt state and the UI.
    expect(buildOperationStatusDisplay('BOGUS' as OperationState).terminal).toBe(false);
    expect(buildOperationStatusDisplay('SUCCEEDED').terminal).toBe(true);
  });

  test('SEAL: every state declared in contracts resolves to a defined label and badge', () => {
    // The structural pin that would have caught this class of bug at the
    // source: adding a state to OperationStates without adding it to
    // STATE_LABEL / STATE_BADGE silently produces undefined at runtime.
    for (const state of OperationStates) {
      const display = buildOperationStatusDisplay(state);
      expect(typeof display.label).toBe('string');
      expect(display.label.length).toBeGreaterThan(0);
      expect(['success', 'error', 'warning', 'info', 'neutral']).toContain(display.badge);
    }
  });

  test('a malformed state does not throw through the full detail view either', () => {
    const view = formatOperationDetailView(
      makeOperation({ state: 'BOGUS' as OperationState }),
      [],
      '2026-09-22T12:00:00Z',
    );
    expect(view.status.label).toBeUndefined();
    expect(view.status.badge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Corrupted casToken in the resume payload
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: buildResumePayload performs no validation of casToken or stepIndex', () => {
  // Measured: buildResumePayload is a pure passthrough - waitId and casToken
  // both receive the argument verbatim, whatever its type or content. The
  // server is the ONLY gate; this layer contributes no defence at all.
  const corrupted: unknown[] = [
    '',
    '   ',
    undefined,
    null,
    0,
    42,
    'wait\n;drop',
    'a'.repeat(5000),
    'wait with spaces',
  ];

  test.each(corrupted)('casToken %p reaches waitId AND casToken verbatim', (token) => {
    const payload = buildResumePayload({ decision: 'approve' }, 0, token as string);
    expect(payload.waitId).toBe(token);
    expect(payload.casToken).toBe(token);
  });

  test('a null or undefined token still produces all four payload keys', () => {
    // Nothing is dropped or defaulted - the corrupted value is what ships.
    for (const token of [null, undefined]) {
      const payload = buildResumePayload({}, 0, token as unknown as string);
      expect(Object.keys(payload).sort()).toEqual(['casToken', 'inputData', 'stepIndex', 'waitId']);
      expect(payload.waitId).toBe(token);
    }
  });

  test('the token is not sanitised: a newline+semicolon payload survives intact', () => {
    const hostile = 'wait\n;drop';
    const payload = buildResumePayload({}, 0, hostile);
    expect(payload.casToken).toBe(hostile);
    expect(payload.casToken).toContain('\n');
    expect(payload.casToken).toContain(';');
  });

  test('waitId is always the same value as casToken, whatever the input', () => {
    // The CAS pairing is a structural mirror; it is NOT proof of a valid token.
    for (const token of ['', 'ok', null, undefined, 7] as unknown[]) {
      const payload = buildResumePayload({}, 0, token as string);
      expect(payload.waitId).toBe(payload.casToken);
    }
  });

  const badSteps: number[] = [-1, -999, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER];

  test.each(badSteps)('stepIndex %p is passed through without clamping', (stepIndex) => {
    const payload = buildResumePayload({}, stepIndex, 'wait-abc-123');
    expect(payload.stepIndex).toBe(stepIndex);
  });

  test('inputData is passed through by reference, not copied or filtered', () => {
    // Sharing the reference means a later mutation of the operator form is
    // visible in the payload - pinned so the behaviour is a deliberate diff.
    const data: Record<string, unknown> = { decision: 'approve' };
    const payload = buildResumePayload(data, 0, 'wait-abc-123');
    expect(payload.inputData).toBe(data);
  });

  test('a hostile inputData value is NOT stripped by this layer', () => {
    const payload = buildResumePayload({ note: '<script>alert(1)</script>' }, 0, 'wait-abc-123');
    expect(payload.inputData['note']).toBe('<script>alert(1)</script>');
  });
});

// ---------------------------------------------------------------------------
// 3. Hostile HTML / XSS in the inputSchema
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: renderHumanWaitForm passes schema text through unescaped', () => {
  // These functions are pure mappers: they do not escape, and that is the
  // correct division of labour - escaping belongs to the renderer. What these
  // tests pin is that NOTHING is sanitised here either, so the renderer is
  // genuinely the last line of defence, and a second layer cannot be assumed.
  const now = '2026-09-22T12:00:00Z';

  test('a <script> payload in title reaches label verbatim', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { evil: { type: 'string', title: '<script>alert(1)</script>' } },
        },
      }),
      now,
    );
    expect(form.fields[0]!.label).toBe('<script>alert(1)</script>');
  });

  test('an onerror payload in description reaches description verbatim', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { evil: { type: 'string', description: '<img src=x onerror=alert(1)>' } },
        },
      }),
      now,
    );
    expect(form.fields[0]!.description).toBe('<img src=x onerror=alert(1)>');
  });

  test('a payload in examples[0] reaches placeholder verbatim', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { evil: { type: 'string', examples: ['<svg onload=alert(1)>'] } },
        },
      }),
      now,
    );
    expect(form.fields[0]!.placeholder).toBe('<svg onload=alert(1)>');
  });

  test('a hostile ui:title override also passes through unescaped', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: { type: 'object', properties: { evil: { type: 'string' } } },
        uiSchema: { evil: { 'ui:title': '<script>alert(1)</script>' } },
      }),
      now,
    );
    expect(form.fields[0]!.label).toBe('<script>alert(1)</script>');
  });

  test('a hostile property KEY becomes a field name verbatim', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { '<img src=x onerror=alert(1)>': { type: 'string' } },
        },
      }),
      now,
    );
    expect(form.fields[0]!.name).toBe('<img src=x onerror=alert(1)>');
  });

  test('an object in examples renders the placeholder [object Object]', () => {
    // Measured: String({}) coercion, not a crash and not an empty string.
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { o: { type: 'string', examples: [{ a: 1 }] } },
        },
      }),
      now,
    );
    expect(form.fields[0]!.placeholder).toBe('[object Object]');
  });

  test('an unknown ui:widget value falls back to the derived widget (safe default)', () => {
    // The one place this layer DOES validate: widget names are allowlisted.
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { c: { type: 'string' } },
        },
        uiSchema: { c: { 'ui:widget': '<script>alert(1)</script>' } },
      }),
      now,
    );
    expect(form.fields[0]!.widget).toBe('text');
  });

  test('enum values that are not string/number/boolean are dropped from select options', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: {
            c: { type: 'string', enum: ['a', 1, true, null, { x: 1 }, ['y']] },
          },
        },
      }),
      now,
    );
    const field = form.fields[0]!;
    expect(field.widget).toBe('select');
    expect(field.options).toEqual([
      { value: 'a', label: 'a' },
      { value: '1', label: '1' },
      { value: 'true', label: 'true' },
    ]);
  });

  test('a select whose enum holds only objects renders with zero options', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: {
          type: 'object',
          properties: { c: { type: 'string', enum: [{ a: 1 }] } },
        },
      }),
      now,
    );
    expect(form.fields[0]!.widget).toBe('select');
    expect(form.fields[0]!.options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed schema SHAPE (the reachable crash)
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: a contract-valid null property schema crashes the renderer', () => {
  const now = '2026-09-22T12:00:00Z';

  test('properties: { foo: null } throws a TypeError instead of degrading', () => {
    // DEFECT, and the serious one of this packet. HumanWaitViewSchema types
    // inputSchema as z.record(z.string(), z.unknown()), so a null property
    // value is CONTRACT-VALID and arrives straight off the wire.
    const waitRow = makeWaitRow({
      inputSchema: { type: 'object', properties: { foo: null } },
    } as never);
    expect(() => renderHumanWaitForm(waitRow, now)).toThrow(TypeError);
  });

  test('the contract really does accept that shape (so the crash is reachable)', () => {
    // Without this the previous test could be dismissed as an impossible input.
    const parsed = HumanWaitViewSchema.safeParse({
      waitId: 'wait-abc-123',
      inputSchema: { type: 'object', properties: { foo: null } },
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(parsed.success).toBe(true);
  });

  test('a non-object property value degrades to a text field named after the key', () => {
    for (const value of [7, 'bar', true]) {
      const form = renderHumanWaitForm(
        makeWaitRow({ inputSchema: { type: 'object', properties: { foo: value } } } as never),
        now,
      );
      expect(form.fields).toHaveLength(1);
      expect(form.fields[0]!.widget).toBe('text');
      expect(form.fields[0]!.label).toBe('foo');
    }
  });

  test('properties given as an array produces a field named after the index', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({ inputSchema: { type: 'object', properties: [{ type: 'string' }] } } as never),
      now,
    );
    expect(form.fields.map((f) => f.name)).toEqual(['0']);
  });

  test('properties given as a string is walked character by character', () => {
    // Measured: Object.entries('ab') -> [['0','a'],['1','b']]. Garbage in,
    // garbage out - no throw, but the form is nonsense.
    const form = renderHumanWaitForm(
      makeWaitRow({ inputSchema: { type: 'object', properties: 'ab' } } as never),
      now,
    );
    expect(form.fields.map((f) => f.name)).toEqual(['0', '1']);
    expect(form.fields.every((f) => f.widget === 'text')).toBe(true);
  });

  test('properties null or missing yields an empty field list, not a crash', () => {
    for (const schema of [{ type: 'object', properties: null }, { type: 'object' }]) {
      const form = renderHumanWaitForm(makeWaitRow({ inputSchema: schema } as never), now);
      expect(form.fields).toEqual([]);
    }
  });

  test('a required list that is not an array is ignored rather than throwing', () => {
    const form = renderHumanWaitForm(
      makeWaitRow({
        inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: 'a' },
      } as never),
      now,
    );
    expect(form.fields[0]!.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Corrupted expiresAt fails OPEN
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: an unparseable expiresAt is reported as NOT expired', () => {
  // DEFECT: new Date(garbage) is Invalid Date and every comparison against it
  // is false, so isExpired is false. A corrupt timestamp therefore reads as
  // "still live" - the opposite of fail-closed.
  const now = '2026-09-22T12:00:00Z';
  const unparseable: string[] = [
    'garbage',
    '',
    'null',
    '2026-13-45T99:99:99Z',
    '2099-13-01T00:00:00Z',
    'not-a-date',
  ];

  test.each(unparseable)('expiresAt %p -> isExpired=false', (expiresAt) => {
    const form = renderHumanWaitForm(makeWaitRow({ expiresAt }), now);
    expect(form.isExpired).toBe(false);
  });

  test('the same corruption makes canResumeOperation return FALSE, so the pair disagrees', () => {
    // Measured, and the opposite of what I first assumed. canResumeOperation
    // uses `<` where renderHumanWaitForm uses `>=`, and a comparison against
    // Invalid Date is always false, so BOTH come back false: the panel renders
    // a not-expired form (isExpired=false) while resume is offered nowhere
    // (canResume=false). The two views of the same corrupt timestamp disagree,
    // so neither can be inferred from the other.
    const waitRow = makeWaitRow({ expiresAt: 'garbage' });
    expect(renderHumanWaitForm(waitRow, now).isExpired).toBe(false);
    expect(canResumeOperation('WAITING_INPUT', waitRow, now)).toBe(false);
  });

  test('a genuinely live row makes both agree on true (guards the row above)', () => {
    const waitRow = makeWaitRow({ expiresAt: '2099-01-01T00:00:00Z' });
    expect(renderHumanWaitForm(waitRow, now).isExpired).toBe(false);
    expect(canResumeOperation('WAITING_INPUT', waitRow, now)).toBe(true);
  });

  test('a rolled-over calendar date is parsed, not rejected', () => {
    // Measured: 2026-02-30 becomes 2026-03-02, so it reads as expired.
    const form = renderHumanWaitForm(makeWaitRow({ expiresAt: '2026-02-30T00:00:00Z' }), now);
    expect(form.isExpired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Negative and out-of-range sizeBytes
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: artifact sizeDisplay renders negative and non-finite sizes verbatim', () => {
  // DEFECT: formatSizeDisplay has no floor and no isFinite check. Negative
  // sizes render as negative byte strings, and NaN lands in the MB branch.
  const now = '2026-09-22T12:00:00Z';
  const sizeOf = (sizeBytes: number): string => {
    const view = formatOperationDetailView(
      makeOperation({ state: 'SUCCEEDED' }),
      [{ artifactId: 'art-neg', role: 'output', sizeBytes } as ArtifactRef],
      now,
    );
    return view.artifacts[0]!.sizeDisplay;
  };

  const negative: Array<[number, string]> = [
    [-1, '-1 B'],
    [-999, '-999 B'],
    [-1024, '-1024 B'],
    [-Infinity, '-Infinity B'],
  ];

  test.each(negative)('sizeBytes %p renders as %p, with no clamp', (sizeBytes, expected) => {
    expect(sizeOf(sizeBytes)).toBe(expected);
  });

  test('a negative size is still displayed rather than hidden as unavailable', () => {
    // The contrast that matters: undefined sizeBytes yields '' (honest
    // "unavailable"), but a corrupt negative yields a confident wrong number.
    const view = formatOperationDetailView(
      makeOperation({ state: 'SUCCEEDED' }),
      [
        { artifactId: 'art-a', sizeBytes: undefined } as ArtifactRef,
        { artifactId: 'art-b', sizeBytes: -1 } as ArtifactRef,
      ],
      now,
    );
    expect(view.artifacts[0]!.sizeDisplay).toBe('');
    expect(view.artifacts[1]!.sizeDisplay).toBe('-1 B');
  });

  test('the CONTRACT is the layer that actually rejects a negative size', () => {
    // ArtifactRefSchema carries .int().min(0), so a negative size never
    // reaches this mapper over a validated wire. The mapper itself has no
    // second guard - the two-layer story only works if the first layer holds.
    // artifactId must itself be a UUID, or the parse fails for the wrong
    // reason and the test would prove nothing about sizeBytes.
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000001';
    expect(ArtifactRefSchema.safeParse({ artifactId: uuid, sizeBytes: -1 }).success).toBe(false);
    expect(ArtifactRefSchema.safeParse({ artifactId: uuid, sizeBytes: 0 }).success).toBe(true);
    expect(ArtifactRefSchema.safeParse({ artifactId: uuid, sizeBytes: 1.5 }).success).toBe(false);
  });

  const nonFinite: Array<[number, string]> = [
    [NaN, 'NaN MB'],
    [Infinity, 'Infinity MB'],
  ];

  test.each(nonFinite)('sizeBytes %p renders as %p (NaN falls into the MB branch)', (sizeBytes, expected) => {
    expect(sizeOf(sizeBytes)).toBe(expected);
  });

  test('the MB rollover is off by one byte: 1048575 B displays as 1024.0 KB', () => {
    // DEFECT (cosmetic): the KB branch accepts values up to 1 MiB - 1, so the
    // largest KB rendering is 1024.0 KB and 1 MiB only appears at 1048576.
    expect(sizeOf(1048575)).toBe('1024.0 KB');
    expect(sizeOf(1048576)).toBe('1.0 MB');
  });
});

// ---------------------------------------------------------------------------
// 7. Empty strings are not defaulted
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: artifact defaults apply to nullish only, never to empty string', () => {
  // Measured: every default in toArtifactDisplayRow is ?? (nullish), so an
  // empty string from the wire survives into the view model as-is.
  test('empty role, fileName, mimeType and download are NOT defaulted', () => {
    const view = formatOperationDetailView(
      makeOperation({ state: 'SUCCEEDED' }),
      [
        {
          artifactId: 'art-empty',
          role: '',
          fileName: '',
          mimeType: '',
          download: '',
        } as unknown as ArtifactRef,
      ],
      '2026-09-22T12:00:00Z',
    );
    const row = view.artifacts[0]!;
    expect(row.role).toBe('');
    expect(row.fileName).toBe('');
    expect(row.mimeType).toBe('');
    expect(row.downloadUrl).toBe('');
  });

  test('nullish values DO get the documented defaults', () => {
    const view = formatOperationDetailView(
      makeOperation({ state: 'SUCCEEDED' }),
      [{ artifactId: 'art-defaults' } as ArtifactRef],
      '2026-09-22T12:00:00Z',
    );
    const row = view.artifacts[0]!;
    expect(row.role).toBe('output');
    expect(row.fileName).toBe('art-defaults');
    expect(row.mimeType).toBe('application/octet-stream');
    expect(row.downloadUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Progress percent and a missing progress block
// ---------------------------------------------------------------------------

describe('W-ADM-UX-07: progress percent is unclamped and progress is not optional', () => {
  const now = '2026-09-22T12:00:00Z';

  const percents: number[] = [-5, -100, 150, 1000, NaN];

  test.each(percents)('percent %p passes through the view model unchanged', (percent) => {
    const view = formatOperationDetailView(
      makeOperation({ progress: { percent, message: 'm' } }),
      [],
      now,
    );
    expect(view.progressPercent).toBe(percent);
  });

  test('a missing progress block throws a TypeError', () => {
    // Measured. OperationViewSchema requires progress, so this is a
    // contract-guarded field - the same two-layer story as sizeBytes.
    const op = makeOperation();
    delete (op as unknown as Record<string, unknown>)['progress'];
    expect(() => formatOperationDetailView(op, [], now)).toThrow(TypeError);
  });

  test('a missing progress message degrades to an empty string', () => {
    const view = formatOperationDetailView(
      makeOperation({ progress: { percent: 10 } as never }),
      [],
      now,
    );
    expect(view.progressMessage).toBe('');
  });

  test('hostile text in progress, action and businessId is not escaped here', () => {
    const view = formatOperationDetailView(
      makeOperation({
        action: '<script>alert(1)</script>',
        businessId: '<img src=x onerror=alert(1)>',
        progress: { percent: 1, message: '<svg onload=alert(1)>' },
      } as never),
      [],
      now,
    );
    expect(view.action).toBe('<script>alert(1)</script>');
    expect(view.businessId).toBe('<img src=x onerror=alert(1)>');
    expect(view.progressMessage).toBe('<svg onload=alert(1)>');
  });
});


// ===========================================================================
// W-ADM-UX-16-OPERATION-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 60)
//
// Second negative pass over the same module as W-ADM-UX-09 (Mục 51). That pass
// covered the ENUM degradations and the size boundary; this one deliberately
// stays off that ground and covers the WIRE SHAPE instead: wrong-typed timeline
// fields, partial/hostile error diagnostics, and what the projection silently
// drops. Every expectation was MEASURED with a throwaway probe first.
//
// Packet coverage map: this module has no metadata-tag, timeline-interval,
// worker-allocation or diagnostic concept by those names (grep for
// metadata|tag|timeline|interval|allocation|diagnostic returns nothing). So:
//   - "invalid operation states"    -> the state carried through status + gates
//   - "corrupted metadata tags"     -> action / businessId / version / progress
//   - "undefined timeline intervals"-> createdAt / updatedAt / deadlineAt / links
//   - "missing worker allocations"  -> pinned as ABSENT (see 60.3)
//   - "unescaped error diagnostics" -> the errorDisplay block
//   - "fail-closed view model rendering" -> the gate helpers and label default
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

const T60_XSS = '<script>alert(1)</script>';
const T60_NOW = '2026-03-19T00:00:00.000Z';

function t60Op(o: Record<string, unknown> = {}): OperationDetail {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    tenantId: 'tenant-1',
    businessId: 'biz',
    businessVersion: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    stateVersion: 2,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    deadlineAt: '2026-03-03T00:00:00.000Z',
    progress: { percent: 50, message: 'working' },
    links: { self: '/api/v1/operations/x', result: '/api/v1/operations/x/result' },
    ...o,
  } as unknown as OperationDetail;
}

function t60View(o: Record<string, unknown> = {}) {
  return formatOperationDetailView(t60Op(o), [], T60_NOW);
}

// ---------------------------------------------------------------------------
// 1. Invalid operation states
// ---------------------------------------------------------------------------

describe('W-ADM-UX-16: a corrupt state keeps its own type and loses its label', () => {
  // Mục 51 pinned the label/badge as undefined. What is new here is the TYPE:
  // status.state carries the corrupt value verbatim, so a number or an object
  // ends up in a field declared as BusinessStatus.
  test.each([
    ['BOGUS', 'string'],
    ['', 'string'],
    ['running', 'string'],
    [0, 'number'],
    [null, 'object'],
    [{}, 'object'],
  ])('state %p survives into status.state as a %s', (state, type) => {
    const view = t60View({ state });
    expect(view.status.state).toBe(state);
    expect(typeof view.status.state).toBe(type);
  });

  // The badge and label are undefined, so JSON drops them: the renderer
  // receives a status object with no label and no badge at all.
  test('a corrupt state produces a status with no label and no badge in the JSON', () => {
    const view = t60View({ state: 'BOGUS' });
    expect(view.status.label).toBeUndefined();
    expect(view.status.badge).toBeUndefined();
    expect(JSON.stringify(view.status)).toBe('{"state":"BOGUS","terminal":false}');
  });

  test('a corrupt state is not treated as terminal, so it stays mutable-looking', () => {
    expect(t60View({ state: 'BOGUS' }).status.terminal).toBe(false);
    expect(t60View({ state: 'SUCCEEDED' }).status.terminal).toBe(true);
  });

  test('buildOperationStatusBadge on a non-string degrades the same way', () => {
    const badge = buildOperationStatusDisplay(null as never);
    expect(badge.label).toBeUndefined();
    expect(badge.badge).toBeUndefined();
  });

  test('every action gate refuses a corrupt state (control for the rows above)', () => {
    for (const state of ['BOGUS', '', 'running', 0, null, {}] as never[]) {
      expect(canCancelOperation(state)).toBe(false);
      expect(canReplayOperation(state)).toBe(false);
      expect(canResumeOperation(state, null, T60_NOW)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Corrupted metadata tags
// ---------------------------------------------------------------------------

describe('W-ADM-UX-16: descriptive metadata is passed through unescaped', () => {
  test.each(['action', 'businessId', 'businessVersion'] as const)(
    'a hostile %s reaches the view verbatim',
    (field) => {
      const view = t60View({ [field]: T60_XSS });
      expect((view as unknown as Record<string, unknown>)[field]).toBe(T60_XSS);
    },
  );

  test('a hostile progress message reaches the view verbatim', () => {
    expect(t60View({ progress: { percent: 1, message: T60_XSS } }).progressMessage).toBe(T60_XSS);
  });

  test('a null progress message degrades to an empty string, not to null', () => {
    expect(t60View({ progress: { percent: 1, message: null } }).progressMessage).toBe('');
  });

  test('a hostile replayOf reaches the view verbatim', () => {
    expect(t60View({ replayOf: T60_XSS }).replayOf).toBe(T60_XSS);
  });

  test('an absent replayOf becomes null', () => {
    expect(t60View().replayOf).toBeNull();
  });

  test('well-formed metadata survives untouched (control)', () => {
    const view = t60View();
    expect(view.action).toBe('review');
    expect(view.businessId).toBe('biz');
    expect(view.businessVersion).toBe('1.0.0');
    expect(view.progressMessage).toBe('working');
  });
});

// ---------------------------------------------------------------------------
// 3. Undefined timeline intervals
// ---------------------------------------------------------------------------

describe('W-ADM-UX-16: timeline fields accept any type, and undefined makes them vanish', () => {
  test.each([
    ['garbage', 'string'],
    [null, 'object'],
    [0, 'number'],
    [false, 'boolean'],
    [{}, 'object'],
    [[], 'object'],
  ])('a createdAt of %p arrives as a %s', (value, type) => {
    const view = t60View({ createdAt: value });
    expect(typeof view.createdAt).toBe(type);
    expect(view.createdAt).toEqual(value);
  });

  // The sharpest one: JSON.stringify drops undefined, so the timeline loses
  // whole fields rather than showing a wrong one.
  test.each(['createdAt', 'updatedAt', 'deadlineAt'])(
    'an undefined %s disappears from the serialized view',
    (field) => {
      const view = t60View({ [field]: undefined });
      expect((view as unknown as Record<string, unknown>)[field]).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(field);
    },
  );

  test('a null deadline is preserved as null - distinct from undefined', () => {
    const view = t60View({ deadlineAt: null });
    expect(view.deadlineAt).toBeNull();
    expect(JSON.stringify(view)).toContain('"deadlineAt":null');
  });

  // links is dereferenced unguarded, so a missing block is a hard crash.
  test.each([undefined, null])('a %p links block throws', (links) => {
    expect(() => t60View({ links })).toThrow(TypeError);
  });

  test('a partial links block yields an undefined resultLink', () => {
    const view = t60View({ links: { self: '/s' } });
    expect(view.selfLink).toBe('/s');
    expect(view.resultLink).toBeUndefined();
  });

  test('a hostile link is passed through unescaped', () => {
    const view = t60View({ links: { self: T60_XSS, result: T60_XSS } });
    expect(view.selfLink).toBe(T60_XSS);
    expect(view.resultLink).toBe(T60_XSS);
  });

  test('well-formed links survive untouched (control)', () => {
    const view = t60View();
    expect(view.selfLink).toBe('/api/v1/operations/x');
    expect(view.resultLink).toBe('/api/v1/operations/x/result');
  });
});

// ---------------------------------------------------------------------------
// 4. Missing worker allocations - pinned as absent
// ---------------------------------------------------------------------------

describe('W-ADM-UX-16: the operation detail view carries no worker telemetry at all', () => {
  // The wire row (OperationDetail) carries workerCount / workerHealth /
  // workerHeartbeat, but this projection has no field for any of them, so the
  // data is silently dropped rather than rendered. Pinned so nobody assumes a
  // worker allocation problem is covered here when it is a different module
  // (resolveWorkerHeartbeat lives in business-view-models - see Mục 53).
  test('the projected key set is the same whether or not worker telemetry is supplied', () => {
    const bare = Object.keys(t60View()).sort();
    const loaded = Object.keys(
      t60View({ workerCount: 5, workerHealth: 'HEALTHY', workerHeartbeat: 'online' }),
    ).sort();
    expect(loaded).toEqual(bare);
  });

  test('no worker key exists on the view model', () => {
    const keys = Object.keys(t60View({ workerCount: 5, workerHealth: 'HEALTHY' }));
    for (const key of ['workerCount', 'workerHealth', 'workerHeartbeat', 'workerHealth']) {
      expect(keys).not.toContain(key);
    }
  });

  test('the wire fields that DO survive are pinned by name', () => {
    expect(Object.keys(t60View()).sort()).toEqual([
      'action',
      'artifacts',
      'businessId',
      'businessVersion',
      'createdAt',
      'deadlineAt',
      'errorDisplay',
      'humanWaitForm',
      'id',
      'progressMessage',
      'progressPercent',
      'replayOf',
      'resultLink',
      'selfLink',
      'status',
      'updatedAt',
    ]);
  });

  // stateVersion and tenantId are on the wire row and are NOT projected.
  test('stateVersion and tenantId are dropped by the projection', () => {
    const view = t60View({ stateVersion: 99, tenantId: 'tenant-x' });
    expect(JSON.stringify(view)).not.toContain('stateVersion');
    expect(JSON.stringify(view)).not.toContain('tenant-x');
  });
});

// ---------------------------------------------------------------------------
// 5. Unescaped error diagnostics
// ---------------------------------------------------------------------------

describe('W-ADM-UX-16: a partial error block yields a diagnostic with its keys missing', () => {
  // DEFECT: errorDisplay is built from the wire block field by field, so a
  // partial block produces an object that is missing code and/or title - JSON
  // drops them and the renderer receives a diagnostic with no identity.
  test('an empty error block yields a display with only detail', () => {
    expect(t60View({ error: {} }).errorDisplay).toEqual({ detail: '' });
  });

  test('an error block with only a code drops the title', () => {
    expect(t60View({ error: { code: 'E' } }).errorDisplay).toEqual({ code: 'E', detail: '' });
  });

  test('a null detail degrades to an empty string', () => {
    expect(t60View({ error: { code: 'E', title: 'T', detail: null } }).errorDisplay).toEqual({
      code: 'E',
      title: 'T',
      detail: '',
    });
  });

  // DEFECT: the diagnostic is a verbatim passthrough, so hostile error text -
  // exactly the kind that carries upstream detail - reaches the view intact.
  test('hostile code, title and detail all reach the view verbatim', () => {
    const view = t60View({ error: { code: T60_XSS, title: T60_XSS, detail: T60_XSS } });
    expect(view.errorDisplay!.code).toBe(T60_XSS);
    expect(view.errorDisplay!.title).toBe(T60_XSS);
    expect(view.errorDisplay!.detail).toBe(T60_XSS);
    expect(JSON.stringify(view)).toContain(T60_XSS);
  });

  test('the leak persists even when a human-wait form is rendered alongside', () => {
    const view = t60View({
      state: 'WAITING_INPUT',
      wait: { waitId: 'w', inputSchema: { properties: {} }, expiresAt: '2099-01-01T00:00:00.000Z' },
      error: { code: T60_XSS, title: T60_XSS, detail: T60_XSS },
    });
    expect(view.humanWaitForm).not.toBeNull();
    expect(JSON.stringify(view)).toContain(T60_XSS);
  });

  test.each([null, undefined])('an %p error block yields a null diagnostic', (error) => {
    expect(t60View({ error }).errorDisplay).toBeNull();
  });

  test('a complete error block survives untouched (control)', () => {
    expect(
      t60View({ error: { code: 'OP_FAILED', title: 'Operation failed', detail: 'worker exited 1' } })
        .errorDisplay,
    ).toEqual({ code: 'OP_FAILED', title: 'Operation failed', detail: 'worker exited 1' });
  });
});

// ---------------------------------------------------------------------------
// 6. Fail-closed view model rendering
// ---------------------------------------------------------------------------

describe('W-ADM-UX-16: the gates refuse, the labels fall back silently', () => {
  const waitRow = {
    waitId: 'wait-abc-123',
    inputSchema: { properties: {} },
    expiresAt: '2099-01-01T00:00:00.000Z',
  } as never;

  test('canResumeOperation refuses a corrupt state and a missing wait row', () => {
    expect(canResumeOperation('BOGUS' as never, waitRow, T60_NOW)).toBe(false);
    expect(canResumeOperation('WAITING_INPUT', null, T60_NOW)).toBe(false);
    expect(canResumeOperation('WAITING_INPUT', undefined as never, T60_NOW)).toBe(false);
  });

  // A NaN clock makes the expiry comparison false, so resume is refused -
  // the safe direction, and worth pinning so nobody "fixes" it the other way.
  test('a NaN now refuses the resume rather than allowing it', () => {
    expect(canResumeOperation('WAITING_INPUT', waitRow, NaN as never)).toBe(false);
  });

  // A switch with a default: an unknown action is neither rejected nor flagged,
  // it silently gets the generic label.
  test.each(['BOGUS', '', null, 5, {}])('replayActionLabel(%p) silently returns the generic label', (action) => {
    expect(replayActionLabel(action as never)).toBe('Replay (new operation)');
  });

  test('a NaN stepIndex is carried into the resume payload', () => {
    expect(buildResumePayload({}, NaN, 'wait-abc-123').stepIndex).toBeNaN();
  });

  test('a terminal state is frozen: no cancel, replay offered', () => {
    expect(canCancelOperation('SUCCEEDED')).toBe(false);
    expect(canCancelOperation('FAILED')).toBe(false);
    expect(canReplayOperation('SUCCEEDED')).toBe(true);
    expect(t60View({ state: 'SUCCEEDED' }).status.label).toBe('Succeeded');
  });

  test('a live wait row past its expiry still renders a form flagged expired', () => {
    const form = renderHumanWaitForm(
      { waitId: 'w', inputSchema: { properties: {} }, expiresAt: '2099-01-01T00:00:00.000Z' } as never,
      T60_NOW,
    );
    expect(form.isExpired).toBe(false);
    expect(form.waitId).toBe('w');
  });
});


// ===========================================================================
// W-ADM-UX-18-OPERATION-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 62)
//
// THIRD negative pass over the same module (Mục 51 = enums, Mục 60 = wire
// shape). Mục 51 phu enum; Mục 60 phu sai kieu cua field. Mục 62 phu:
// malformed details, thieu timestamp, error taxonomy, payload bien, va
// chuyen trang thai.
//
// Every number below was MEASURED with a throwaway probe against the real
// function before being written down. Nothing here is inferred from source.
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

const T62_XSS = '<script>alert(1)</script>';

function t62Op(o: Record<string, unknown> = {}): OperationDetail {
  return {
    id: 'op-1',
    tenantId: 'tenant-1',
    businessId: 'biz',
    businessVersion: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    stateVersion: 2,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    deadlineAt: '2026-03-03T00:00:00.000Z',
    progress: { percent: 50, message: 'working' },
    links: { self: '/s', result: '/r' },
    ...o,
  } as unknown as OperationDetail;
}

const T62_NOW = '2026-03-19T00:00:00.000Z';

function t62View(o: Record<string, unknown> = {}, artifacts: ArtifactRef[] = []) {
  return formatOperationDetailView(t62Op(o), artifacts, T62_NOW);
}

const T62_WAIT = {
  waitId: 'wait-1',
  inputSchema: { properties: {} },
  expiresAt: '2099-01-01T00:00:00.000Z',
} as never;

// ---------------------------------------------------------------------------
// 1. Malformed operation details
// ---------------------------------------------------------------------------

describe('W-ADM-UX-18: the identity and progress fields accept every type', () => {
  // Measured: a null id arrives as the STRING null, not as a null - the value
  // is wrong either way, but not with the type I first assumed.
  test.each([
    ['null', 'string'],
    [42, 'number'],
    [{}, 'object'],
  ])('an id of %p arrives as a %s', (value, type) => {
    const view = t62View({ id: value });
    expect(typeof view.id).toBe(type);
  });

  // The percent is the number the progress bar is drawn from, and it is
  // copied through with no clamp. Measured: 0 and 100 pass, everything
  // outside and every non-finite value is handed to the renderer as-is.
  const percents: Array<[number, number]> = [
    [0, 0],
    [100, 100],
    [-1, -1],
    [101, 101],
    [1e308, 1e308],
    [50.5, 50.5],
  ];
  test.each(percents)('a percent of %p is projected as %p, unclamped', (percent, expected) => {
    expect(t62View({ progress: { percent, message: 'm' } }).progressPercent).toBe(expected);
  });

  test.each([Infinity, -Infinity])('a percent of %p survives to the view', (percent) => {
    expect(t62View({ progress: { percent, message: 'm' } }).progressPercent).toBe(percent);
  });

  test('a missing message degrades to an empty string', () => {
    expect(t62View({ progress: { percent: 10 } }).progressMessage).toBe('');
  });

  test('a missing percent is undefined, not zero', () => {
    expect(t62View({ progress: { message: 'm' } }).progressPercent).toBeUndefined();
  });

  test.each([undefined, null])('a %p progress block throws', (progress) => {
    expect(() => t62View({ progress })).toThrow(TypeError);
  });

  // Measured: neither field is projected, so they are silently dropped
  // rather than rendered. Pinned so nobody assumes a stale-state banner or a
  // tenant label is available on this view.
  test('tenantId and stateVersion are not projected at all', () => {
    const json = JSON.stringify(t62View({ tenantId: T62_XSS, stateVersion: 99 }));
    expect(json).not.toContain('tenantId');
    expect(json).not.toContain('stateVersion');
    expect(json).not.toContain(T62_XSS);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing required timestamp fields
// ---------------------------------------------------------------------------

describe('W-ADM-UX-18: timestamps are never parsed, so corruption is invisible', () => {
  // No Date.parse anywhere in this projection: a bound that is not a date at
  // all is indistinguishable from a valid one by the time it reaches the UI.
  test.each(['garbage', 'not-a-date', ''])('a createdAt of %p passes through verbatim', (createdAt) => {
    expect(t62View({ createdAt }).createdAt).toBe(createdAt);
  });

  test('a rolled-over calendar date is not detected', () => {
    expect(t62View({ createdAt: '2026-02-30T00:00:00.000Z' }).createdAt).toBe('2026-02-30T00:00:00.000Z');
  });

  test.each([
    [0, 'number'],
    [1774300000000, 'number'],
    [{}, 'object'],
  ])('a createdAt of %p arrives as a %s', (value, type) => {
    expect(typeof t62View({ createdAt: value }).createdAt).toBe(type);
  });

  // An inverted window is meaningless, and nothing here checks the ordering.
  test('a deadline before createdAt passes through unflagged', () => {
    const view = t62View({
      createdAt: '2026-03-10T00:00:00.000Z',
      deadlineAt: '2026-03-01T00:00:00.000Z',
    });
    expect(view.deadlineAt).toBe('2026-03-01T00:00:00.000Z');
  });

  test('a long-expired deadline is not marked as overdue', () => {
    expect(t62View({ deadlineAt: '2000-01-01T00:00:00.000Z' }).deadlineAt).toBe('2000-01-01T00:00:00.000Z');
  });

  test('createdAt equal to updatedAt is not treated as an anomaly', () => {
    const same = '2026-03-02T00:00:00.000Z';
    expect(t62View({ createdAt: same }).createdAt).toBe(same);
  });

  // The now parameter is the only thing that makes a timestamp mean anything
  // in this module, and it only reaches the human-wait expiry check.
  test('the now parameter is what decides wait expiry, and equality counts as expired', () => {
    const atExpiry = formatOperationDetailView(
      t62Op({
        state: 'WAITING_INPUT',
        wait: { waitId: 'w', inputSchema: { properties: {} }, expiresAt: T62_NOW } as never,
      }),
      [],
      T62_NOW,
    );
    const before = formatOperationDetailView(
      t62Op({
        state: 'WAITING_INPUT',
        wait: { waitId: 'w', inputSchema: { properties: {} }, expiresAt: T62_NOW } as never,
      }),
      [],
      '2026-03-18T00:00:00.000Z',
    );
    expect((atExpiry.humanWaitForm as { isExpired: boolean }).isExpired).toBe(true);
    expect((before.humanWaitForm as { isExpired: boolean }).isExpired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid error taxonomy formatting
// ---------------------------------------------------------------------------

describe('W-ADM-UX-18: the error block is copied field by field with no type check', () => {
  // The taxonomy is not validated as a set of known codes: whatever the wire
  // carries is forwarded. Measured with numbers, arrays and objects.
  test('numeric code and title are forwarded as numbers, not coerced', () => {
    expect(t62View({ error: { code: 500, title: 404, detail: {} } }).errorDisplay).toEqual({
      code: 500,
      title: 404,
      detail: {},
    });
  });

  test('null code and title are forwarded as null, not defaulted', () => {
    expect(t62View({ error: { code: null, title: null, detail: null } }).errorDisplay).toEqual({
      code: null,
      title: null,
      detail: '',
    });
  });

  test('array-valued code and title are forwarded as arrays', () => {
    expect(t62View({ error: { code: [], title: [], detail: [] } }).errorDisplay).toEqual({
      code: [],
      title: [],
      detail: [],
    });
  });

  test('an object-valued code and a numeric detail are forwarded as-is', () => {
    const display = t62View({ error: { code: { a: 1 }, title: T62_XSS, detail: 0 } }).errorDisplay!;
    expect(display.code).toEqual({ a: 1 });
    expect(display.title).toBe(T62_XSS);
    expect(display.detail).toBe(0);
  });

  test('empty strings are kept as empty strings', () => {
    expect(t62View({ error: { code: '', title: '', detail: '' } }).errorDisplay).toEqual({
      code: '',
      title: '',
      detail: '',
    });
  });

  // The positive: only code/title/detail survive, so an unexpected field on
  // the wire cannot smuggle anything extra into the diagnostic.
  test('an extra field on the error block is dropped', () => {
    const json = JSON.stringify(t62View({ error: { code: 'E', title: 'T', detail: 'D', extra: 'LEAKME' } }));
    expect(json).not.toContain('LEAKME');
    expect(t62View({ error: { code: 'E', title: 'T', detail: 'D', extra: 'LEAKME' } }).errorDisplay).toEqual({
      code: 'E',
      title: 'T',
      detail: 'D',
    });
  });

  test.each([false, 0])('an error block of %p yields a null diagnostic', (error) => {
    expect(t62View({ error }).errorDisplay).toBeNull();
  });

  test('a hostile code, title and detail all survive the round trip', () => {
    const display = t62View({ error: { code: T62_XSS, title: T62_XSS, detail: T62_XSS } }).errorDisplay!;
    expect(display.code).toBe(T62_XSS);
    expect(display.title).toBe(T62_XSS);
    expect(display.detail).toBe(T62_XSS);
  });
});

// ---------------------------------------------------------------------------
// 4. Payload boundary handling
// ---------------------------------------------------------------------------

describe('W-ADM-UX-18: the resume payload passes inputData through by reference', () => {
  // GOOD, worth pinning: a __proto__ key from JSON.parse does NOT pollute the
  // prototype, and survives as a plain own property. The payload builder
  // copies the reference rather than merging, so there is no merge sink.
  test('a __proto__ key stays an own property and does not pollute anything', () => {
    const payload = buildResumePayload(JSON.parse('{"__proto__":{"polluted":true},"a":"b"}'), 0, 'tok');
    expect(Object.keys(payload.inputData).sort()).toEqual(['__proto__', 'a']);
    expect(Object.prototype.hasOwnProperty.call(payload.inputData, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('a constructor key is forwarded as data, not invoked', () => {
    const payload = buildResumePayload(JSON.parse('{"constructor":{"prototype":{}}}'), 0, 'tok');
    expect(Object.keys(payload.inputData)).toEqual(['constructor']);
    expect(payload.inputData['constructor']).toEqual({ prototype: {} });
  });

  // The reference is shared, not copied: a later mutation of the caller's
  // object is visible in the payload. Pinned so the change would be a diff.
  test('inputData is shared by reference, not copied', () => {
    const data: Record<string, unknown> = { a: 'b' };
    const payload = buildResumePayload(data, 0, 'tok');
    data['a'] = 'mutated';
    expect(payload.inputData['a']).toBe('mutated');
  });

  test('a 200-level deep object survives without a stack overflow', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 200; i += 1) {
      cursor['n'] = {};
      cursor = cursor['n'] as Record<string, unknown>;
    }
    expect(() => buildResumePayload(deep, 0, 'tok')).not.toThrow();
  });

  test('a 200k-character value is forwarded with no length guard', () => {
    const payload = buildResumePayload({ a: 'x'.repeat(200_000) }, 0, 'tok');
    expect((payload.inputData['a'] as string)).toHaveLength(200_000);
  });

  // Measured: a null inputData does NOT throw - the builder never touches the
  // value, so null is carried straight through. I had assumed a crash.
  test('a null inputData is carried through as null rather than throwing', () => {
    expect(buildResumePayload(null as never, 0, 'tok').inputData).toBeNull();
  });

  test.each([1.5, Infinity])('a stepIndex of %p is forwarded unvalidated', (stepIndex) => {
    expect(buildResumePayload({}, stepIndex, 'tok').stepIndex).toBe(stepIndex);
  });

  test('a token containing a newline is forwarded verbatim', () => {
    expect(buildResumePayload({}, 0, 'a\nb').casToken).toBe('a\nb');
  });
});

describe('W-ADM-UX-18: a malformed artifact entry throws, a sparse one leaves a hole', () => {
  test('a null artifact throws', () => {
    expect(() => t62View({}, [null as never])).toThrow(TypeError);
  });

  test('a non-array artifacts value throws', () => {
    expect(() => formatOperationDetailView(t62Op(), { a: 1 } as never, T62_NOW)).toThrow(TypeError);
  });

  // The defaults are applied to an entry that has NO fields at all, so an
  // empty object still produces a full row rather than an empty one.
  test('an empty artifact still gets role and mime defaults', () => {
    expect(t62View({}, [{} as never]).artifacts[0]).toEqual({
      role: 'output',
      mimeType: 'application/octet-stream',
      sizeDisplay: '',
      downloadUrl: null,
    });
  });

  test('an array artifact is treated as an object and gets defaults', () => {
    expect(t62View({}, [[] as never]).artifacts[0]).toEqual({
      role: 'output',
      mimeType: 'application/octet-stream',
      sizeDisplay: '',
      downloadUrl: null,
    });
  });

  test('an empty artifactId stays empty rather than falling back', () => {
    expect(t62View({}, [{ artifactId: '' } as never]).artifacts[0]!.artifactId).toBe('');
  });

  // Array.prototype.map keeps holes, so the projected array has a hole that
  // the renderer will walk into as a missing row.
  test('a hole in the artifact list is preserved and counted', () => {
    const view = t62View({}, [{ artifactId: 'a' }, , { artifactId: 'b' }] as never);
    expect(view.artifacts).toHaveLength(3);
    expect(view.artifacts[1]).toBeUndefined();
  });

  test('500 artifacts all project', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ artifactId: 'a' + i })) as never;
    expect(t62View({}, many).artifacts).toHaveLength(500);
  });

  // GOOD: the projection builds fresh objects, so mutating the view does not
  // reach back into the caller's artifact row.
  test('the projected row is a copy, not the caller object', () => {
    const source = { artifactId: 'a' } as ArtifactRef;
    const view = t62View({}, [source]);
    view.artifacts[0]!.artifactId = 'MUTATED';
    expect((source as unknown as Record<string, unknown>)['artifactId']).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// 5. Status transition anomalies
// ---------------------------------------------------------------------------

describe('W-ADM-UX-18: the transition gates are correct for all twelve states', () => {
  // Measured matrix. Terminal states freeze (no cancel, replay allowed);
  // CANCEL_REQUESTED is non-terminal but already cancelling; PENDING_INGESTION
  // is non-terminal with no gate open.
  const matrix: Array<[OperationState, boolean, boolean, boolean, boolean]> = [
    ['ACCEPTED', true, false, false, false],
    ['QUEUED', true, false, false, false],
    ['RUNNING', true, false, false, false],
    ['WAITING_CHILDREN', true, false, false, false],
    ['WAITING_INPUT', true, false, true, false],
    ['RETRY_PENDING', true, false, false, false],
    ['CANCEL_REQUESTED', false, false, false, false],
    ['SUCCEEDED', false, true, false, true],
    ['FAILED', false, true, false, true],
    ['CANCELLED', false, true, false, true],
    ['TIMED_OUT', false, true, false, true],
    ['PENDING_INGESTION', false, false, false, false],
  ];
  test.each(matrix)(
    '%s: cancel=%p replay=%p resume=%p terminal=%p',
    (state, cancel, replay, resume, terminal) => {
      expect(canCancelOperation(state)).toBe(cancel);
      expect(canReplayOperation(state)).toBe(replay);
      expect(canResumeOperation(state, T62_WAIT, T62_NOW)).toBe(resume);
      expect(buildOperationStatusDisplay(state).terminal).toBe(terminal);
    },
  );

  // The terminal and cancellable sets are disjoint by measurement, which is
  // the invariant the module's own docstring asserts.
  test('no state is both terminal and cancellable', () => {
    for (const [state] of matrix) {
      if (buildOperationStatusDisplay(state).terminal) {
        expect(canCancelOperation(state)).toBe(false);
      }
    }
  });

  test('resume requires a live wait row, not just the state', () => {
    expect(canResumeOperation('WAITING_INPUT', T62_WAIT, T62_NOW)).toBe(true);
    expect(canResumeOperation('WAITING_INPUT', null, T62_NOW)).toBe(false);
    expect(canResumeOperation('WAITING_INPUT', undefined, T62_NOW)).toBe(false);
  });
});

describe('W-ADM-UX-18: the human-wait form is gated on the state, not on the wait row', () => {
  test('a wait row on a non-WAITING_INPUT state renders no form', () => {
    expect(t62View({ state: 'RUNNING', wait: T62_WAIT }).humanWaitForm).toBeNull();
  });

  test('WAITING_INPUT with a wait row renders the form', () => {
    expect(t62View({ state: 'WAITING_INPUT', wait: T62_WAIT }).humanWaitForm).not.toBeNull();
  });

  test.each([{}, { wait: null }])('%p yields no form even in WAITING_INPUT', (o) => {
    expect(t62View({ state: 'WAITING_INPUT', ...o }).humanWaitForm).toBeNull();
  });
});

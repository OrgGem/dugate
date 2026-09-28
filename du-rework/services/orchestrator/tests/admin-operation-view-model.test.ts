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

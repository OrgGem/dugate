import {
  canTransition,
  canTransitionTask,
  isTerminalOperationState,
  isTerminalTaskState,
  OPERATION_TRANSITIONS,
  TASK_TRANSITIONS,
  OperationStates,
  TaskStates,
} from '../src';

describe('operation state machine (docs 04)', () => {
  it('terminal states have no outgoing transitions', () => {
    for (const s of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) {
      expect(OPERATION_TRANSITIONS[s]).toEqual([]);
      expect(isTerminalOperationState(s)).toBe(true);
    }
  });

  it('ACCEPTED → QUEUED and ACCEPTED → RUNNING allowed (lost dispatch ACK)', () => {
    expect(canTransition('ACCEPTED', 'QUEUED')).toBe(true);
    expect(canTransition('ACCEPTED', 'RUNNING')).toBe(true);
  });

  it('RUNNING fans out to wait/retry/terminal states', () => {
    expect(canTransition('RUNNING', 'WAITING_CHILDREN')).toBe(true);
    expect(canTransition('RUNNING', 'WAITING_INPUT')).toBe(true);
    expect(canTransition('RUNNING', 'RETRY_PENDING')).toBe(true);
    expect(canTransition('RUNNING', 'SUCCEEDED')).toBe(true);
  });

  it('join satisfaction re-queues: WAITING_CHILDREN → QUEUED', () => {
    expect(canTransition('WAITING_CHILDREN', 'QUEUED')).toBe(true);
  });

  it('resume re-queues: WAITING_INPUT → QUEUED', () => {
    expect(canTransition('WAITING_INPUT', 'QUEUED')).toBe(true);
  });

  it('cancel from any non-terminal state, then CANCELLED only', () => {
    for (const s of OperationStates) {
      if (isTerminalOperationState(s) || s === 'CANCEL_REQUESTED') continue;
      expect(canTransition(s, 'CANCEL_REQUESTED')).toBe(true);
    }
    expect(canTransition('CANCEL_REQUESTED', 'CANCELLED')).toBe(true);
    expect(canTransition('CANCEL_REQUESTED', 'SUCCEEDED')).toBe(false);
  });

  it('forbidden transitions are rejected', () => {
    expect(canTransition('SUCCEEDED', 'RUNNING')).toBe(false);
    expect(canTransition('QUEUED', 'SUCCEEDED')).toBe(false); // must run first
    expect(canTransition('FAILED', 'QUEUED')).toBe(false); // no resume of terminal
    expect(canTransition('ACCEPTED', 'ACCEPTED')).toBe(false);
  });

  it('every state appears in the transition table', () => {
    for (const s of OperationStates) {
      expect(OPERATION_TRANSITIONS).toHaveProperty(s);
    }
  });
});

describe('task state machine (docs 04)', () => {
  it('terminal tasks have no outgoing transitions', () => {
    for (const s of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      expect(TASK_TRANSITIONS[s]).toEqual([]);
      expect(isTerminalTaskState(s)).toBe(true);
    }
  });

  it('READY → RUNNING via claim; RUNNING → RETRY_PENDING; retry re-runs', () => {
    expect(canTransitionTask('READY', 'RUNNING')).toBe(true);
    expect(canTransitionTask('RUNNING', 'RETRY_PENDING')).toBe(true);
    expect(canTransitionTask('RETRY_PENDING', 'RUNNING')).toBe(true);
  });

  it('task cannot skip READY → SUCCEEDED', () => {
    expect(canTransitionTask('READY', 'SUCCEEDED')).toBe(false);
  });

  it('every task state appears in the transition table', () => {
    for (const s of TaskStates) {
      expect(TASK_TRANSITIONS).toHaveProperty(s);
    }
  });
});
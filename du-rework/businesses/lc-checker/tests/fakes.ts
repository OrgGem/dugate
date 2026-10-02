import type { TaskContext, TaskDisposition } from '@du/worker-sdk';
import { createHash } from 'node:crypto';

import { LC_DEFAULT_RULE_SET_VERSION } from '../src/rules/rule-registry';
import { LC_CHECKER_INPUT_VERSION } from '../src/types';

export function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputVersion: LC_CHECKER_INPUT_VERSION,
    artifactIds: ['art-invoice', 'art-bl'],
    fileNames: ['invoice.pdf', 'bill-of-lading.pdf'],
    ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
    maxConcurrency: 4,
    failurePolicy: 'fail-closed',
    requireEncryptedEvidence: true,
    ...overrides,
  };
}

export interface VisualRequestFixture {
  readonly document_index: number;
  readonly purpose: string;
  readonly rule_ids: readonly string[];
}

export function screenPayload(requests: readonly VisualRequestFixture[] = []): Record<string, unknown> {
  return {
    notes: 'The text settles the description; the endorsement cannot be read from text.',
    visual_requests: requests,
  };
}

export function digestPayload(documentIndex: number, found: boolean): Record<string, unknown> {
  return {
    document_index: documentIndex,
    observations: [
      { field: 'shipper endorsement', found, evidence: found ? 'Signed on the reverse, page 3.' : 'No endorsement found.' },
    ],
  };
}

/** A compliance payload the validator accepts: internally consistent and fully cited. */
export function compliantPayload(): Record<string, unknown> {
  return {
    verdict: 'COMPLIANT',
    total_discrepancies: 0,
    major_discrepancies: 0,
    minor_discrepancies: 0,
    advisory_count: 0,
    documents_present: ['Commercial Invoice', 'Bill of Lading'],
    documents_missing: [],
    discrepancies: [],
    summary: 'The document set conforms to the credit terms.',
    recommendation: 'ACCEPT',
  };
}

export function discrepantPayload(): Record<string, unknown> {
  return {
    verdict: 'DISCREPANT',
    total_discrepancies: 1,
    major_discrepancies: 1,
    minor_discrepancies: 0,
    advisory_count: 0,
    documents_present: ['Commercial Invoice'],
    documents_missing: ['Insurance Certificate'],
    discrepancies: [
      {
        id: 'D001',
        severity: 'MAJOR',
        document: 'Bill of Lading',
        field: 'on board notation',
        issue: 'No on-board date, vessel name or port of loading is stated.',
        rule_id: 'PROC-3.2',
        recommendation: 'Request a corrected bill of lading.',
      },
    ],
    summary: 'The bill of lading lacks a compliant on-board notation.',
    recommendation: 'REJECT',
  };
}

export interface Harness {
  readonly ctx: TaskContext;
  readonly ocrCalls: string[];
  readonly visionCalls: Array<{ purpose: string; rules: unknown }>;
  readonly screenCallCount: () => number;
  readonly adjudicateCalls: Array<{ digests: number; outstanding: number }>;
  readonly reportCallCount: () => number;
  readonly spawnCalls: Array<{ taskKeys: string[]; kinds: string[]; continuationRef: string }>;
  readonly progressCount: () => number;
  /** Times a step.run returned a stored checkpoint instead of executing the turn. */
  readonly replayCount: () => number;
  /** Persisted machine state written between deliveries, newest last. */
  readonly savedStates: () => string[];
}

export interface HarnessOptions {
  readonly input?: Record<string, unknown>;
  readonly joinSummary?: Record<string, string>;
  readonly screen?: Record<string, unknown>;
  readonly digests?: Record<number, Record<string, unknown>>;
  readonly adjudicate?: Record<string, unknown>;
  readonly ocrText?: string;
  readonly reportText?: string;
  readonly artifactBytes?: number;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const ocrCalls: string[] = [];
  const visionCalls: Array<{ purpose: string; rules: unknown }> = [];
  const adjudicateCalls: Array<{ digests: number; outstanding: number }> = [];
  const spawnCalls: Array<{ taskKeys: string[]; kinds: string[]; continuationRef: string }> = [];
  let screenCalls = 0;
  let reportCalls = 0;
  let progressCalls = 0;
  let replayed = 0;
  const checkpoints = new Map<string, unknown>();
  const stateArtifacts = new Map<string, string>();

  const input: Record<string, unknown> = { ...(options.input ?? validInput()) };
  if (options.joinSummary) {
    input['joinSummary'] = options.joinSummary;
  }

  const screen = options.screen ?? screenPayload([
    { document_index: 1, purpose: 'Is the bill of lading endorsed on the reverse?', rule_ids: ['PROC-3.8'] },
  ]);
  const digests = options.digests ?? { 1: digestPayload(1, true) };
  const adjudicate = options.adjudicate ?? compliantPayload();

  const ctx = {
    taskId: 'task-1',
    operationId: 'op-lc-1',
    tenantId: '22222222-2222-2222-2222-222222222222',
    businessId: 'lc-checker',
    businessVersion: '1.0.0',
    action: 'lc-checker',
    kind: 'lc-checker',
    taskKey: 'root',
    attempt: 1,
    leaseEpoch: 1,
    deadlineAt: null,
    signal: new AbortController().signal,
    cancelRequested: false,
    input,
    connectorBindings: { ocr: 'ocr@1', vision: 'vision@1', crosscheck: 'reasoning@1', report: 'reasoning@1' },
    step: {
      run: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
        const key = stepKey + '|' + inputHash;
        const stored = checkpoints.get(key);
        if (stored !== undefined) {
          replayed += 1;
          return stored as T;
        }
        const value = await fn();
        checkpoints.set(key, value);
        return value;
      },
      peek: async (stepKey: string) => (checkpoints.has(stepKey) ? ({ stepKey } as never) : null),
    },
    spawn: {
      spawnAndWait: async (
        children: Array<{ taskKey: string; kind: string }>,
        _joinPolicy: string,
        continuationRef: string
      ): Promise<TaskDisposition> => {
        spawnCalls.push({
          taskKeys: children.map((child) => child.taskKey),
          kinds: children.map((child) => child.kind),
          continuationRef,
        });
        return { kind: 'waiting-children' };
      },
    },
    wait: { waitForInput: async () => ({ kind: 'waiting-input', waitId: 'w' }) as TaskDisposition },
    progress: {
      report: async (): Promise<void> => {
        progressCalls += 1;
      },
    },
    artifacts: {
      read: async (artifactId: string) => Buffer.from(stateArtifacts.get(artifactId) ?? '', 'utf8'),
      readWithMetadata: async (artifactId: string) => {
        const persisted = stateArtifacts.get(artifactId);
        if (persisted === undefined) {
          // Only the persisted state artifact can legitimately be absent. A submitted
          // document always exists, so a miss there would be a harness bug being masked.
          if (artifactId.startsWith('lc-checker-state-')) {
            throw new Error('no such artifact ' + artifactId);
          }
          const bytes = Buffer.alloc(options.artifactBytes ?? 1024, 0x41);
          return {
            buffer: bytes,
            filename: artifactId + '.pdf',
            mimeType: 'application/pdf',
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            storageVersionId: 'v1',
            grantExpiresAt: null,
          };
        }
        const buffer = Buffer.from(persisted, 'utf8');
        return {
          buffer,
          filename: artifactId,
          mimeType: 'application/json',
          sizeBytes: buffer.length,
          sha256: sha256(buffer),
          storageVersionId: 'v1',
          grantExpiresAt: null,
        };
      },
      write: async (content: Buffer | string, fileName: string) => {
        const text = typeof content === 'string' ? content : content.toString('utf8');
        if (fileName.startsWith('lc-checker-state-')) {
          stateArtifacts.set(fileName, text);
          return { artifactId: fileName, role: 'intermediate' };
        }
        const sizeBytes = options.artifactBytes ?? 1024;
        const buffer = Buffer.alloc(Math.max(sizeBytes, 1), 0x41);
        void buffer;
        return { artifactId: '33333333-3333-3333-3333-333333333333', role: 'output', sizeBytes };
      },
    },
    connector: {
      invoke: async (slot: string, invocationInput: { prompt?: string; artifacts?: unknown[] }) => {
        if (slot === 'ocr') {
          ocrCalls.push((invocationInput.artifacts?.length ?? 0).toString());
          return { invocationId: 'i', state: 'SUCCEEDED', result: { content: options.ocrText ?? 'OCR TEXT' } };
        }
        if (slot === 'vision') {
          const prompt = String(invocationInput.prompt ?? '');
          const documentIndex = /document_index: (\d+)/.exec(prompt)?.[1];
          visionCalls.push({ purpose: prompt, rules: null });
          const index = Number(documentIndex ?? 0);
          const digest = digests[index] ?? digestPayload(index, false);
          return { invocationId: 'i', state: 'SUCCEEDED', result: { content: JSON.stringify(digest) } };
        }
        if (slot === 'crosscheck') {
          const prompt = String(invocationInput.prompt ?? '');
          if (prompt.includes('ADJUDICATION pass')) {
            adjudicateCalls.push({
              digests: (prompt.match(/VISUAL INSPECTION: /g) ?? []).length,
              outstanding: prompt.includes('UNSATISFIED VISUAL CHECKS') ? 1 : 0,
            });
            return { invocationId: 'i', state: 'SUCCEEDED', result: { content: JSON.stringify(adjudicate) } };
          }
          screenCalls += 1;
          return { invocationId: 'i', state: 'SUCCEEDED', result: { content: JSON.stringify(screen) } };
        }
        reportCalls += 1;
        return {
          invocationId: 'i',
          state: 'SUCCEEDED',
          result: { content: options.reportText ?? '# Bao cao kiem tra chung tu LC' },
        };
      },
    },
    checkpoints: () => [],
    grantFor: async () => ({}) as never,
  } as unknown as TaskContext;

  return {
    ctx,
    ocrCalls,
    visionCalls,
    screenCallCount: () => screenCalls,
    adjudicateCalls,
    reportCallCount: () => reportCalls,
    spawnCalls,
    progressCount: () => progressCalls,
    replayCount: () => replayed,
    savedStates: () => [...stateArtifacts.values()],
  };
}

export function ocrJoinEntry(fileName: string, text: string): string {
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify({ kind: 'ocr', fileName, text }), 'utf8').toString('base64');
}

export function digestJoinEntry(documentIndex: number, found: boolean): string {
  return (
    'data:application/json;base64,' + Buffer.from(JSON.stringify(digestPayload(documentIndex, found)), 'utf8').toString('base64')
  );
}

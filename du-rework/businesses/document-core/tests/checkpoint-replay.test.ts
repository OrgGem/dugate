import { StepCheckpointManager } from '../src/pipelines/step-checkpoint';
import { documentCoreHandlers } from '../src/worker';
import { TaskContext, StepCheckpointRecord } from '../src/types/context';
import { STEP_KEYS } from '../src/recipes/step-keys';

describe('Checkpoint Replay & Output Integrity (WORKLOAD-REBALANCE-04, P5-04)', () => {
  function createReplayContext(existingCheckpoints?: Map<string, StepCheckpointRecord>) {
    const checkpoints = existingCheckpoints ?? new Map<string, StepCheckpointRecord>();
    const artifacts = new Map<string, Buffer>();

    const counters = {
      connectorInvocations: 0,
      artifactWrites: 0,
      stepCallbackExecutions: 0,
    };

    const ctx: TaskContext = {
      taskId: 'task-replay-001',
      operationId: 'op-replay-001',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      tenantId: 'tenant-test',
      signal: new AbortController().signal,
      artifacts: {
        read: async (id: string) => {
          const buf = artifacts.get(id);
          if (!buf) throw new Error(`Artifact ${id} not found`);
          return buf;
        },
        write: async (content: Buffer | string, fileName: string, mimeType: string) => {
          counters.artifactWrites++;
          const id = `art-${counters.artifactWrites}`;
          const buf = typeof content === 'string' ? Buffer.from(content) : content;
          artifacts.set(id, buf);
          return {
            artifactId: id,
            role: 'output',
            fileName,
            mimeType,
            sizeBytes: buf.byteLength,
            hashSha256: 'sha256:fake',
          };
        },
      },
      connector: {
        invoke: async (slot, payload) => {
          counters.connectorInvocations++;
          // Generate realistic provider response depending on payload
          const task = (payload as any)?.task || '';
          if (task.includes('extract')) {
            return {
              invocationId: `inv-${counters.connectorInvocations}`,
              status: 'SUCCESS',
              data: {
                invoiceNumber: 'INV-2026-999',
                supplier: 'Acme Global Services Inc',
                total: '$50,000.00',
                date: '2026-09-20',
                lineItems: Array.from({ length: 40 }, (_, i) => ({
                  item: `Engineering Deliverable Part #${i + 1}`,
                  amount: 1250,
                  description: `Detailed engineering work package description item ${i + 1} with extensive metadata`,
                })),
              },
            };
          }

          if (task.includes('transform') || task.includes('translate')) {
            // Generate >3000 chars per chunk to test non-truncation (>6000 chars total)
            const paragraph = 'This is a high-volume translated technical specification paragraph detailing system operations and protocols. ';
            const longText = paragraph.repeat(30);
            return {
              invocationId: `inv-${counters.connectorInvocations}`,
              status: 'SUCCESS',
              rawText: longText,
              data: longText,
            };
          }

          return {
            invocationId: `inv-${counters.connectorInvocations}`,
            status: 'SUCCESS',
            data: { result: 'default' },
          };
        },
      },
      step: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
        const existing = checkpoints.get(stepKey);
        if (existing && existing.inputHash === inputHash) {
          // Replay without executing callback
          return existing.output as T;
        }

        counters.stepCallbackExecutions++;
        const output = await fn();
        checkpoints.set(stepKey, {
          stepKey,
          inputHash,
          output,
          savedAt: new Date().toISOString(),
        });
        return output;
      },
      getCheckpoint: async (stepKey: string) => {
        return checkpoints.get(stepKey) ?? null;
      },
    };

    return { ctx, checkpoints, artifacts, counters };
  }

  test('P5-04: executeWithCheckpoint restores complete output without re-executing callback on replay', async () => {
    const { ctx, checkpoints, counters } = createReplayContext();
    const payload = { query: 'test-query', docId: 42 };

    // Run 1: First execution
    const longOutputString = 'CHUNK-DATA-'.repeat(600); // 6600 characters
    expect(longOutputString.length).toBeGreaterThan(5000);

    const result1 = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      'test-step-long',
      payload,
      async () => {
        return { content: longOutputString, length: longOutputString.length };
      }
    );

    expect(result1.content).toBe(longOutputString);
    expect(result1.content.length).toBe(6600);
    expect(counters.stepCallbackExecutions).toBe(1);
    expect(checkpoints.has('test-step-long')).toBe(true);

    // Run 2: Replay with identical input
    const result2 = await StepCheckpointManager.executeWithCheckpoint<{ content: string; length: number }>(
      ctx,
      'test-step-long',
      payload,
      async () => {
        throw new Error('Callback MUST NOT be called on replay!');
      }
    );

    // Call count remains 1 (no re-execution)
    expect(counters.stepCallbackExecutions).toBe(1);
    // Full output restored completely (>5000 characters intact)
    expect(result2.content).toBe(longOutputString);
    expect(result2.content.length).toBe(6600);
    expect(result2.content).not.toContain('... [truncated]');
  });

  test('P5-04: InputHash mismatch triggers re-execution when input changes', async () => {
    const { ctx, counters } = createReplayContext();

    await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      'step-versioned',
      { version: 1 },
      async () => ({ data: 'v1' })
    );
    expect(counters.stepCallbackExecutions).toBe(1);

    // Call again with different input payload
    const resultV2 = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      'step-versioned',
      { version: 2 },
      async () => ({ data: 'v2' })
    );

    expect(counters.stepCallbackExecutions).toBe(2);
    expect(resultV2.data).toBe('v2');
  });

  test('P5-04: validateFullOutputIntegrity rejects truncated outputs', () => {
    expect(() => {
      StepCheckpointManager.validateFullOutputIntegrity('Some long result... [truncated]');
    }).toThrow(/Checkpoint integrity failure/);

    expect(() => {
      StepCheckpointManager.validateFullOutputIntegrity({
        nested: { text: 'Some long text that was cut off... [truncated]' },
      });
    }).toThrow(/Checkpoint integrity failure/);

    // Clean long text passes without error
    expect(() => {
      StepCheckpointManager.validateFullOutputIntegrity({
        nested: { text: 'A'.repeat(10000) },
      });
    }).not.toThrow();
  });

  test('P5-04: Multi-step pipeline replay avoids repeating provider calls for completed steps', async () => {
    const { ctx, checkpoints, counters, artifacts } = createReplayContext();

    // Step 1 already completed in previous run
    const promptPayload = {
      type: 'invoice',
      promptText: 'Extract invoice information from document.',
      documentSnippet: 'Invoice 123 from Acme Global',
    };
    const step1Key = STEP_KEYS.EXTRACT.BUILD_PROMPT;
    const step1InputHash = StepCheckpointManager.computeInputHash({
      type: 'invoice',
      textLength: promptPayload.documentSnippet.length,
      fields: undefined,
    });
    checkpoints.set(step1Key, {
      stepKey: step1Key,
      inputHash: step1InputHash,
      output: promptPayload,
      savedAt: new Date().toISOString(),
    });

    // Step 2 (inference) already completed in previous run
    const step2Key = STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE;
    const step2InputHash = StepCheckpointManager.computeInputHash({ promptHash: StepCheckpointManager.computeInputHash(promptPayload) });
    const cachedProviderData = {
      invoiceNumber: 'INV-2026-CACHED',
      supplier: 'Acme Cached Supplies Inc',
      total: '$99,999.00',
    };
    checkpoints.set(step2Key, {
      stepKey: step2Key,
      inputHash: step2InputHash,
      output: cachedProviderData,
      savedAt: new Date().toISOString(),
    });

    // Execute extract handler — it should replay steps 1 & 2 without calling connector!
    const disposition = await documentCoreHandlers['extract']!(ctx, {
      type: 'invoice',
      text: 'Invoice 123 from Acme Global',
    });

    expect(disposition.kind).toBe('completed');
    // Connector invocations MUST BE 0 because Step 2 was replayed from checkpoint!
    expect(counters.connectorInvocations).toBe(0);

    // Final artifact written
    expect(counters.artifactWrites).toBe(1);
    const writtenRef = (disposition as any).resultRef.replace('artifact://', '');
    const finalBuffer = artifacts.get(writtenRef);
    expect(finalBuffer).toBeDefined();

    const envelope = JSON.parse(finalBuffer!.toString('utf8'));
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.data.invoiceNumber).toBe('INV-2026-CACHED');
    expect(envelope.data.supplier).toBe('Acme Cached Supplies Inc');
  });

  test('P5-04: Large payload (>5000 chars) preserves complete content across checkpoint replay', async () => {
    const { ctx, checkpoints, counters, artifacts } = createReplayContext();

    const longDoc = 'Sentence in technical manual discussing fault-tolerant distributed consensus. '.repeat(80);
    expect(longDoc.length).toBeGreaterThan(5000);

    // Run transform action
    const disposition = await documentCoreHandlers['transform']!(ctx, {
      variant: 'translate',
      targetLanguage: 'Spanish',
      text: longDoc,
    });

    expect(disposition.kind).toBe('completed');
    // Chunking divides >5000 chars into 2 chunks -> 2 invocations
    expect(counters.connectorInvocations).toBe(2);
    expect(counters.artifactWrites).toBe(1);

    const resultArtId = (disposition as any).resultRef.replace('artifact://', '');
    const result1Json = JSON.parse(artifacts.get(resultArtId)!.toString('utf8'));
    expect(result1Json.data.transformedText.length).toBeGreaterThan(5000);
    expect(result1Json.data.transformedText).not.toContain('... [truncated]');

    // Now replay the same action on the same context where checkpoints are recorded
    const replayDisposition = await documentCoreHandlers['transform']!(ctx, {
      variant: 'translate',
      targetLanguage: 'Spanish',
      text: longDoc,
    });

    expect(replayDisposition.kind).toBe('completed');
    // Provider calls MUST NOT increase on replay (still 2)
    expect(counters.connectorInvocations).toBe(2);
  });
});

import { TaskContext } from '../types/context';
import { BusinessExecutionError } from '../types/results';
import { LeaseLostError } from '@du/worker-sdk';

/**
 * StepCheckpointManager handles durable checkpoints with strict guarantees:
 * 1. Full step output is preserved (>500 chars intact, zero truncation).
 * 2. Idempotent resumption: if step output exists for stable stepKey, returns cached result without re-executing.
 * 3. Fencing: ensures clean state isolation and verifies cancellation/lease-loss at boundaries.
 */
export class StepCheckpointManager {
  /**
   * Asserts that context has not been cancelled or fenced by lease loss.
   */
  public static assertActive(ctx: TaskContext): void {
    if (ctx.signal?.aborted) {
      if (ctx.signal.reason === 'cancel' || (ctx as any).cancelRequested) {
        throw new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false);
      }
      throw new LeaseLostError(ctx.taskId);
    }
  }

  /**
   * Executes step callback with durable checkpointing.
   * If checkpoint already exists, returns persisted output directly without re-invoking provider or saving.
   */
  public static async executeWithCheckpoint<T>(
    ctx: TaskContext,
    stepKey: string,
    inputPayload: unknown,
    fn: () => Promise<T>
  ): Promise<T> {
    // 1. Boundary check before starting step
    this.assertActive(ctx);

    const inputHash = this.computeInputHash(inputPayload);

    // 2. Check if step previously succeeded (idempotent replay)
    const existing = await ctx.getCheckpoint(stepKey);
    if (existing && existing.inputHash === inputHash && existing.output !== null && existing.output !== undefined) {
      // Step already completed with identical input hash -> return full cached output directly
      return existing.output as T;
    }

    // 3. Execute through TaskContext.step facade to ensure runtime persistence
    const result = await ctx.step<T>(stepKey, inputHash, async () => {
      this.assertActive(ctx);
      const output = await fn();
      this.assertActive(ctx);
      // Ensure output is non-truncated
      this.validateFullOutputIntegrity(output);
      return output;
    });

    return result;
  }

  /**
   * Validate that step output was not truncated.
   */
  public static validateFullOutputIntegrity(output: unknown): void {
    if (typeof output === 'string') {
      if (output.endsWith('... [truncated]')) {
        throw new Error('Checkpoint integrity failure: Step output was truncated.');
      }
    } else if (output && typeof output === 'object') {
      const serialized = JSON.stringify(output);
      if (serialized.includes('... [truncated]')) {
        throw new Error('Checkpoint integrity failure: Serialized step output contains truncation.');
      }
    }
  }

  public static computeInputHash(payload: unknown): string {
    const json = JSON.stringify(payload ?? null);
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return `hash-${Math.abs(hash).toString(16)}`;
  }
}

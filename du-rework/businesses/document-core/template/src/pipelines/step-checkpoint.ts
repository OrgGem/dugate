import { TaskContext } from '../types/context';
import { BusinessExecutionError } from '../types/results';
import { LeaseLostError } from '@du/worker-sdk';
import type { SealedArtifact } from '@du/worker-sdk';

/**
 * StepCheckpointManager handles durable checkpoints with strict guarantees:
 * 1. Full step output is preserved (>500 chars intact, zero truncation).
 * 2. Idempotent resumption: if step output exists for stable stepKey, returns cached result without re-executing.
 * 3. Fencing: ensures clean state isolation and verifies cancellation/lease-loss at boundaries.
 */
export class StepCheckpointManager {
  /**
   * W-ENC-04-SEAM: marker on a checkpoint payload that is stored SEALED. It is
   * the only thing that distinguishes a sealed record from a legacy plaintext
   * one, and it is what lets a replay stay transparent: a checkpoint written
   * before encryption was switched on still opens, byte for byte.
   */
  private static readonly SEALED_MARKER = '__duEncryptedCheckpoint' as const;

  /** Checkpoint payloads are bound to this synthetic artifact identity. */
  private static binding(stepKey: string): { artifactId: string; purpose: 'intermediate' } {
    return { artifactId: `checkpoint:${stepKey}`, purpose: 'intermediate' };
  }

  /**
   * Fail closed when a deployment REQUIRES encryption but the worker was started
   * without a seam. Called before the step body runs, so a required-but-missing
   * seam never gets as far as persisting a plaintext checkpoint.
   */
  public static assertEncryptionAvailable(ctx: TaskContext, required: boolean): void {
    if (required && !ctx.crypto) {
      throw new BusinessExecutionError(
        'Checkpoint encryption is required but this worker has no crypto seam configured',
        'ENCRYPTION_UNAVAILABLE',
        false
      );
    }
  }

  /**
   * Store form for a checkpoint output: sealed when a seam is present, the
   * original value otherwise. With no seam this returns the value UNCHANGED,
   * so the opt-in contract is a real no-op rather than an encryption-shaped
   * wrapper that would break every existing replay test.
   */
  private static async toStoredForm(ctx: TaskContext, stepKey: string, output: unknown): Promise<unknown> {
    if (!ctx.crypto) return output;
    const bytes = Buffer.from(JSON.stringify(output ?? null), 'utf8');
    const sealed = await ctx.crypto.seal(bytes, this.binding(stepKey));
    return {
      [StepCheckpointManager.SEALED_MARKER]: 1,
      artifactId: `checkpoint:${stepKey}`,
      sealed,
    };
  }

  /** Inverse of toStoredForm; passes a legacy plaintext record straight through. */
  private static async fromStoredForm(ctx: TaskContext, stored: unknown): Promise<unknown> {
    if (!stored || typeof stored !== 'object') return stored;
    const record = stored as Record<string, unknown>;
    if (record[StepCheckpointManager.SEALED_MARKER] !== 1) return stored;
    if (!ctx.crypto) {
      throw new BusinessExecutionError(
        'Checkpoint is sealed but this worker has no crypto seam to open it',
        'ENCRYPTION_UNAVAILABLE',
        false
      );
    }
    const sealed = record.sealed as SealedArtifact;
    const plaintext = await ctx.crypto.open(sealed, this.binding(String(record.artifactId ?? '').replace(/^checkpoint:/, '')));
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as unknown;
  }

  /** True when a stored checkpoint payload is a sealed envelope. */
  public static isSealedRecord(stored: unknown): boolean {
    return Boolean(
      stored && typeof stored === 'object' && (stored as Record<string, unknown>)[StepCheckpointManager.SEALED_MARKER] === 1
    );
  }

  /**
   * Asserts that context has not been cancelled or fenced by lease loss.
   */
  public static assertActive(ctx: TaskContext): void {
    if (ctx.signal?.aborted) {
      const isCancelRequested = 'cancelRequested' in ctx && Boolean((ctx as { cancelRequested?: unknown }).cancelRequested);
      if (ctx.signal.reason === 'cancel' || isCancelRequested) {
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
    fn: () => Promise<T>,
    options: { requireEncryption?: boolean } = {}
  ): Promise<T> {
    // 0. Encryption policy is settled BEFORE the step body can produce a byte.
    this.assertEncryptionAvailable(ctx, options.requireEncryption === true);

    // 1. Boundary check before starting step
    this.assertActive(ctx);

    const inputHash = this.computeInputHash(inputPayload);

    // 2. Check if step previously succeeded (idempotent replay)
    const existing = await ctx.getCheckpoint(stepKey);
    if (existing && existing.inputHash === inputHash && existing.output !== null && existing.output !== undefined) {
      // Step already completed with identical input hash -> return full cached output directly
      return (await this.fromStoredForm(ctx, existing.output)) as T;
    }

    // 3. Execute through TaskContext.step facade to ensure runtime persistence
    const stored = await ctx.step<unknown>(stepKey, inputHash, async () => {
      this.assertActive(ctx);
      const output = await fn();
      this.assertActive(ctx);
      // Ensure output is non-truncated
      this.validateFullOutputIntegrity(output);
      // W-ENC-04-SEAM: what PERSISTS is the sealed form; the caller still gets
      // the plaintext value back, so business code is unaffected either way.
      return this.toStoredForm(ctx, stepKey, output);
    });

    return (await this.fromStoredForm(ctx, stored)) as T;
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

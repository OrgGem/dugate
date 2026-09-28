import { randomUUID } from 'node:crypto';
import type { TestIsolationContext } from '../namespace';

/**
 * Isolated In-Memory Runtime Stub (P1-05)
 *
 * Implements the full Worker Runtime protocol entirely in memory.
 * Emulates lease tracking, heartbeat renewal, step checkpointing, and terminal reporting
 * partitioned by TestIsolationContext.
 */

export interface StubTaskState {
  taskId: string;
  taskKey: string;
  status: 'PENDING' | 'RUNNING' | 'WAITING_CHILDREN' | 'WAITING_INPUT' | 'COMPLETED' | 'FAILED';
  leaseEpoch: number;
  leaseExpiresAt: number;
  checkpoints: Map<string, { stepKey: string; inputHash: string; output: unknown }>;
  result?: unknown;
  error?: unknown;
}

export class InMemoryRuntimeStub {
  private readonly tasks = new Map<string, StubTaskState>();

  public constructor(public readonly ctx: TestIsolationContext) {}

  public registerTask(task: {
    taskId?: string;
    taskKey?: string;
    status?: StubTaskState['status'];
    leaseEpoch?: number;
    leaseDurationMs?: number;
  }): StubTaskState {
    const taskId = task.taskId ?? randomUUID();
    const state: StubTaskState = {
      taskId,
      taskKey: task.taskKey ?? `task-${taskId.slice(0, 8)}`,
      status: task.status ?? 'PENDING',
      leaseEpoch: task.leaseEpoch ?? 1,
      leaseExpiresAt: Date.now() + (task.leaseDurationMs ?? 60_000),
      checkpoints: new Map(),
    };
    this.tasks.set(taskId, state);
    return state;
  }

  public getTask(taskId: string): StubTaskState | undefined {
    return this.tasks.get(taskId);
  }

  public async claimTask(taskId: string, workerInstanceId: string, leaseDurationMs = 30_000): Promise<{
    claimed: boolean;
    leaseEpoch?: number;
    leaseExpiresAt?: number;
    error?: string;
  }> {
    const task = this.tasks.get(taskId);
    if (!task) return { claimed: false, error: 'TASK_NOT_FOUND' };
    if (task.status !== 'PENDING' && task.leaseExpiresAt > Date.now()) {
      return { claimed: false, error: 'TASK_ALREADY_LEASED' };
    }

    task.status = 'RUNNING';
    task.leaseEpoch += 1;
    task.leaseExpiresAt = Date.now() + leaseDurationMs;

    return {
      claimed: true,
      leaseEpoch: task.leaseEpoch,
      leaseExpiresAt: task.leaseExpiresAt,
    };
  }

  public async heartbeat(taskId: string, leaseEpoch: number, extendMs = 30_000): Promise<{
    acknowledged: boolean;
    leaseExpiresAt?: number;
    error?: string;
  }> {
    const task = this.tasks.get(taskId);
    if (!task) return { acknowledged: false, error: 'TASK_NOT_FOUND' };
    if (task.leaseEpoch !== leaseEpoch) {
      return { acknowledged: false, error: 'LEASE_LOST' };
    }

    task.leaseExpiresAt = Date.now() + extendMs;
    return { acknowledged: true, leaseExpiresAt: task.leaseExpiresAt };
  }

  public async saveStep(
    taskId: string,
    leaseEpoch: number,
    stepKey: string,
    inputHash: string,
    output: unknown,
  ): Promise<{ saved: boolean; replayed: boolean; error?: string }> {
    const task = this.tasks.get(taskId);
    if (!task) return { saved: false, replayed: false, error: 'TASK_NOT_FOUND' };
    if (task.leaseEpoch !== leaseEpoch) return { saved: false, replayed: false, error: 'LEASE_LOST' };

    const existing = task.checkpoints.get(stepKey);
    if (existing) {
      if (existing.inputHash === inputHash) {
        return { saved: true, replayed: true };
      }
      return { saved: false, replayed: false, error: 'STEP_HASH_MISMATCH' };
    }

    task.checkpoints.set(stepKey, { stepKey, inputHash, output });
    return { saved: true, replayed: false };
  }

  public async reportTask(
    taskId: string,
    leaseEpoch: number,
    disposition: { status: 'COMPLETED' | 'FAILED'; result?: unknown; error?: unknown },
  ): Promise<{ acknowledged: boolean; error?: string }> {
    const task = this.tasks.get(taskId);
    if (!task) return { acknowledged: false, error: 'TASK_NOT_FOUND' };
    if (task.leaseEpoch !== leaseEpoch) return { acknowledged: false, error: 'LEASE_LOST' };

    task.status = disposition.status;
    task.result = disposition.result;
    task.error = disposition.error;
    return { acknowledged: true };
  }

  public clear(): void {
    this.tasks.clear();
  }
}

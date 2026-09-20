import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ArtifactRef,
  CheckpointRef,
  InvocationGrant,
  InvocationResponse,
  InvocationResponseSchema,
  TaskDisposition,
  contentHash,
} from '@du/contracts';
import { Logger } from '@du/observability';
import { RuntimeClient, RuntimeError, AmbiguousReportError } from './runtime-client';
import type {
  ArtifactFacade,
  ArtifactPurpose,
  ConnectorFacade,
  ConnectorInvokeInput,
  HumanWaitFacade,
  ProgressFacade,
  SpawnFacade,
  ChildTaskSpecInput,
  StepFacade,
  TaskContext,
} from './types';

/**
 * TaskContext implementation (P4-03/04/05/07).
 *
 * Invariants:
 * - every runtime write carries the claim's leaseEpoch (fencing)
 * - step.run never re-executes a SUCCEEDED checkpoint with matching inputHash
 *   (RUN-04: full output restored, no re-inference)
 * - spawnAndWait/waitForInput persist state BEFORE returning the disposition;
 *   the parent handler releases its slot (no in-memory join wait)
 * - connector.invoke derives a stable invocationId per (stepKey, slot,
 *   inputHash) via the runtime grant endpoint — replays reuse it
 * - after lease loss the abort signal fires; no new provider calls
 */

export class LeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`lease lost for task ${taskId}; aborting delivery`);
    this.name = 'LeaseLostError';
  }
}

export class InputHashMismatchError extends Error {
  constructor(readonly stepKey: string) {
    super(`checkpoint for step "${stepKey}" exists with a different inputHash`);
    this.name = 'InputHashMismatchError';
  }
}

export interface TaskContextDeps {
  runtime: RuntimeClient;
  logger: Logger;
  /** Performs the actual HTTP invocation against the connector service. */
  invokeConnector: (grant: InvocationGrant, req: ConnectorInvocationPayload) => Promise<InvocationResponse>;
}

export interface ConnectorInvocationPayload {
  contractVersion: '1';
  invocationId: string;
  grant: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: ConnectorInvokeInput;
  options?: Record<string, unknown>;
  sessionRef?: string | null;
  deadlineAt: string;
}

interface ClaimedTask {
  taskId: string;
  operationId: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  kind: string;
  taskKey: string;
  attempt: number;
  leaseEpoch: number;
  leaseExpiresAt: string;
  deadlineAt: string | null;
  input: Record<string, unknown>;
  waitResponse?: unknown;
  connectorBindings: Record<string, string>;
  checkpointRefs: CheckpointRef[];
  cancelRequested: boolean;
}

export class DefaultTaskContext implements TaskContext {
  readonly taskId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly action: string;
  readonly kind: string;
  readonly taskKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly deadlineAt: string | null;
  readonly input: Record<string, unknown>;
  readonly waitResponse?: unknown;
  readonly connectorBindings: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;

  private readonly abortController: AbortController;
  private checkpointList: CheckpointRef[];
  private cancelFlag: boolean;
  private terminalReported = false;

  readonly step: StepFacade;
  readonly spawn: SpawnFacade;
  readonly wait: HumanWaitFacade;
  readonly progress: ProgressFacade;
  readonly artifacts: ArtifactFacade;
  readonly connector: ConnectorFacade;

  constructor(
    private readonly task: ClaimedTask,
    private readonly deps: TaskContextDeps
  ) {
    this.taskId = task.taskId;
    this.operationId = task.operationId;
    this.tenantId = task.tenantId;
    this.businessId = task.businessId;
    this.businessVersion = task.businessVersion;
    this.action = task.action;
    this.kind = task.kind;
    this.taskKey = task.taskKey;
    this.attempt = task.attempt;
    this.leaseEpoch = task.leaseEpoch;
    this.deadlineAt = task.deadlineAt;
    this.input = task.input;
    this.waitResponse = task.waitResponse;
    this.connectorBindings = task.connectorBindings;
    this.checkpointList = [...task.checkpointRefs];
    this.cancelFlag = task.cancelRequested;

    this.abortController = new AbortController();
    this.signal = this.abortController.signal;

    this.step = this.createStepFacade();
    this.spawn = this.createSpawnFacade();
    this.wait = this.createWaitFacade();
    this.progress = this.createProgressFacade();
    this.artifacts = this.createArtifactFacade();
    this.connector = this.createConnectorFacade();
  }

  get cancelRequested(): boolean {
    return this.cancelFlag;
  }

  checkpoints(): readonly CheckpointRef[] {
    return this.checkpointList;
  }

  /** Called by the worker loop when heartbeat detects lease loss/cancel. */
  abort(reason: 'lease-lost' | 'cancel' | 'shutdown'): void {
    if (reason === 'cancel') this.cancelFlag = true;
    this.abortController.abort();
  }

  markTerminalReported(): void {
    this.terminalReported = true;
  }

  get hasReportedTerminal(): boolean {
    return this.terminalReported;
  }

  private assertLease(): void {
    if (this.abortController.signal.aborted) {
      throw new LeaseLostError(this.taskId);
    }
  }

  private wrapLeaseErrors<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err) => {
      if (err instanceof RuntimeError && err.isLeaseLost) {
        this.abortController.abort();
        throw new LeaseLostError(this.taskId);
      }
      throw err;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Step checkpoints (RUN-04)                                         */
  /* ---------------------------------------------------------------- */

  private createStepFacade(): StepFacade {
    const self = this;
    return {
      async run<T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> {
        self.assertLease();
        const existing = self.checkpointList.find((c) => c.stepKey === stepKey);
        if (existing) {
          if (existing.status === 'SUCCEEDED') {
            if (existing.inputHash !== inputHash) {
              throw new InputHashMismatchError(stepKey);
            }
            // Replay: restore full stored output; never re-execute fn.
            const stored = await self.readCheckpointOutput<T>(existing);
            self.deps.logger.debug('step checkpoint replay', { stepKey, generation: existing.generation });
            return stored;
          }
          // FAILED/PENDING checkpoint: fall through and re-execute with a new generation.
        }
        const output = await runWithStepKey(stepKey, fn);
        self.assertLease();
        const outputRef = await self.persistStepOutput(stepKey, output);
        const ack = await self.wrapLeaseErrors(() =>
          self.deps.runtime.saveStep(self.taskId, stepKey, {
            leaseEpoch: self.leaseEpoch,
            inputHash,
            outputRef,
            status: 'SUCCEEDED',
          })
        );
        self.checkpointList.push({
          stepKey,
          generation: ack.generation,
          inputHash,
          status: 'SUCCEEDED',
          outputRef,
        });
        return output;
      },

      async peek(stepKey: string): Promise<CheckpointRef | null> {
        return self.checkpointList.find((c) => c.stepKey === stepKey) ?? null;
      },
    };
  }

  /**
   * Step outputs are stored via the artifact mechanism (full output, no
   * preview truncation). Small outputs are inlined as data: refs to keep the
   * common case cheap; the runtime treats both uniformly.
   */
  private async persistStepOutput(stepKey: string, output: unknown): Promise<string> {
    const serialized = JSON.stringify({ stepKey, output });
    const inline = `inline:sha256:${createHash('sha256').update(serialized).digest('hex')}:${serialized.length}`;
    // Store the full payload as an intermediate artifact; ref points to it.
    const ref = await this.artifacts.write(serialized, `${stepKey}.checkpoint.json`, 'application/json', 'intermediate');
    return `artifact://${ref.artifactId}?meta=${encodeURIComponent(inline)}`;
  }

  private async readCheckpointOutput<T>(checkpoint: CheckpointRef): Promise<T> {
    if (!checkpoint.outputRef) {
      throw new Error(`checkpoint ${checkpoint.stepKey} has no outputRef`);
    }
    const artifactId = parseArtifactRef(checkpoint.outputRef);
    const raw = await this.artifacts.read(artifactId);
    const parsed = JSON.parse(raw.toString('utf8')) as { stepKey: string; output: T };
    return parsed.output;
  }

  /* ---------------------------------------------------------------- */
  /* Spawn + join (RUN-05)                                             */
  /* ---------------------------------------------------------------- */

  private createSpawnFacade(): SpawnFacade {
    const self = this;
    return {
      async spawnAndWait(children, joinPolicy, continuationRef): Promise<TaskDisposition> {
        self.assertLease();
        const specs = children.map((c: ChildTaskSpecInput) => ({
          taskKey: c.taskKey,
          kind: c.kind,
          payloadRef: c.payload,
          payloadHash: contentHash(c.payload),
        }));
        await self.wrapLeaseErrors(() =>
          self.deps.runtime.spawnChildren(self.taskId, {
            leaseEpoch: self.leaseEpoch,
            children: specs,
            joinPolicy,
            continuationRef,
          })
        );
        // State persisted (children + dependency + parent wait + outbox in one
        // transaction). Parent MUST now yield its slot.
        return { kind: 'waiting-children' };
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Human wait (RUN-06)                                               */
  /* ---------------------------------------------------------------- */

  private createWaitFacade(): HumanWaitFacade {
    const self = this;
    return {
      async waitForInput(waitKey, inputSchema, opts): Promise<TaskDisposition> {
        self.assertLease();
        const ack = await self.wrapLeaseErrors(() =>
          self.deps.runtime.waitInput(self.taskId, {
            leaseEpoch: self.leaseEpoch,
            waitKey,
            inputSchema,
            uiSchema: opts?.uiSchema,
            contextRef: opts?.contextRef ?? null,
            expiresAt: opts?.expiresAt,
          })
        );
        // Schema persisted before release; resume arrives as a new delivery.
        return { kind: 'waiting-input', waitId: ack.waitId };
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Progress                                                          */
  /* ---------------------------------------------------------------- */

  private createProgressFacade(): ProgressFacade {
    const self = this;
    return {
      async report(percent: number, message?: string): Promise<void> {
        if (self.abortController.signal.aborted) return; // best-effort only
        await self.deps.runtime.reportProgress(self.taskId, {
          leaseEpoch: self.leaseEpoch,
          percent,
          message,
        });
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Artifacts (ART-01..03 boundary: grants via runtime, bytes via      */
  /* storage URLs — worker holds no storage credentials)               */
  /* ---------------------------------------------------------------- */

  private createArtifactFacade(): ArtifactFacade {
    const self = this;
    return {
      async read(artifactId: string): Promise<Buffer> {
        self.assertLease();
        const grant = await self.wrapLeaseErrors(() =>
          self.deps.runtime.requestAccessGrant(artifactId, {
            taskId: self.taskId,
            leaseEpoch: self.leaseEpoch,
            mode: 'read',
          })
        );
        if (!grant.downloadUrl) throw new Error(`no download URL in access grant for ${artifactId}`);
        const res = await fetch(grant.downloadUrl);
        if (!res.ok) throw new Error(`artifact download failed: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      },

      async write(
        content: Buffer | string,
        fileName: string,
        mimeType: string,
        purpose: ArtifactPurpose = 'output'
      ): Promise<ArtifactRef> {
        self.assertLease();
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const grant = await self.wrapLeaseErrors(() =>
          self.deps.runtime.requestUploadGrant(self.taskId, {
            leaseEpoch: self.leaseEpoch,
            purpose,
            mimeType,
            sizeBytes: buf.byteLength,
          })
        );
        const upload = await fetch(grant.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': mimeType },
          body: buf,
        });
        if (!upload.ok) throw new Error(`artifact upload failed: ${upload.status}`);
        await self.wrapLeaseErrors(() =>
          self.deps.runtime.finalizeArtifact(grant.artifactId, { sizeBytes: buf.byteLength, sha256 })
        );
        return {
          artifactId: grant.artifactId,
          role: purpose,
          fileName,
          mimeType,
          sizeBytes: buf.byteLength,
          hashSha256: sha256,
        };
      },

      async accessGrant(artifactId: string, mode: 'read' | 'write') {
        self.assertLease();
        const grant = await self.wrapLeaseErrors(() =>
          self.deps.runtime.requestAccessGrant(artifactId, {
            taskId: self.taskId,
            leaseEpoch: self.leaseEpoch,
            mode,
          })
        );
        return { downloadUrl: grant.downloadUrl, uploadUrl: grant.uploadUrl, expiresAt: grant.expiresAt };
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Connector invocation (CON-01..04: stable invocation per step)     */
  /* ---------------------------------------------------------------- */

  private createConnectorFacade(): ConnectorFacade {
    const self = this;
    return {
      async invoke(slot: string, input: ConnectorInvokeInput, options?: Record<string, unknown>): Promise<InvocationResponse> {
        self.assertLease();
        const stepKey = currentStepKey();
        const inputHash = contentHash({ slot, input, options: options ?? null });
        // Runtime issues a stable invocationId for (task, stepKey, slot,
        // inputHash); replays reuse the same ID (no duplicate provider cost).
        const grant = await self.grantFor(stepKey, slot, inputHash);
        const payload: ConnectorInvocationPayload = {
          contractVersion: '1',
          invocationId: grant.invocationId,
          grant: grant.grant,
          operationId: self.operationId,
          taskId: self.taskId,
          stepKey,
          bindingSlot: slot,
          input,
          options,
          sessionRef: null,
          deadlineAt: self.deadlineAt ?? new Date(Date.now() + 300_000).toISOString(),
        };
        const response = await self.deps.invokeConnector(grant, payload);
        return InvocationResponseSchema.parse(response);
      },
    };
  }

  async grantFor(stepKey: string, bindingSlot: string, inputHash: string): Promise<InvocationGrant> {
    this.assertLease();
    return this.wrapLeaseErrors(() =>
      this.deps.runtime.requestInvocationGrant(this.taskId, {
        leaseEpoch: this.leaseEpoch,
        stepKey,
        bindingSlot,
        inputHash,
      })
    );
  }
}

export function parseArtifactRef(ref: string): string {
  const m = /^artifact:\/\/([0-9a-f-]{36})/.exec(ref);
  if (!m || !m[1]) throw new Error(`invalid artifact ref: ${ref}`);
  return m[1];
}

/* -------------------------------------------------------------------- */
/* Step-key scoping: connector.invoke needs the enclosing step key for   */
/* stable invocation IDs. step.run() scopes it via AsyncLocalStorage so  */
/* concurrent steps in the same process never cross-talk.                */
/* -------------------------------------------------------------------- */

const stepKeyStorage = new AsyncLocalStorage<string>();

export function runWithStepKey<T>(stepKey: string, fn: () => Promise<T>): Promise<T> {
  return stepKeyStorage.run(stepKey, fn);
}

function currentStepKey(): string {
  return stepKeyStorage.getStore() ?? 'default';
}

export { AmbiguousReportError, RuntimeError };
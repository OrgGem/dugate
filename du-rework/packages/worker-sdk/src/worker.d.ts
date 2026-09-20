import { BusinessJobV1 } from '@du/contracts';
import { Logger } from '@du/observability';
import type { BusinessDefinition, TaskHandler, WorkerConfig, WorkerHandle } from './types';
/**
 * Worker lifecycle (P4-02): validate definition → register manifest →
 * heartbeat loop → consume queue → claim task → run handler → report
 * disposition → graceful shutdown.
 *
 * Delivery semantics: at-least-once. The claim is the authority: if the
 * task is already terminal or leased elsewhere the runtime answers 409/410
 * and the delivery ends safely. Business retry budget is runtime-owned; the
 * SDK only classifies failures (retryable + errorCode + retryAfterMs).
 */
export interface DefineBusinessOptions {
    /** Fail fast on an invalid manifest at startup (REG-04). */
    validate?: boolean;
}
/**
 * Validate a business definition: manifest must pass contract validation and
 * every declared handler kind must have a handler; handlers must not exist
 * for undeclared kinds.
 */
export declare function defineBusiness(manifest: unknown, handlers: Record<string, TaskHandler>, opts?: DefineBusinessOptions): BusinessDefinition;
/** Queue consumer abstraction so tests can drive deliveries without Redis. */
export interface QueueConsumer {
    /** Begin consuming; handler receives the parsed job + delivery metadata. */
    start(handler: (job: BusinessJobV1) => Promise<void>): void;
    /** Graceful stop: no new deliveries, in-flight finished within graceMs. */
    stop(graceMs: number): Promise<void>;
}
export interface BullMQConsumerOptions {
    queueName: string;
    redisUrl: string;
    concurrency: number;
    workerInstanceId: string;
}
/** BullMQ-backed consumer (production path). Pinned bullmq ^5.x (ADR-05). */
export declare function createBullMQConsumer(opts: BullMQConsumerOptions): QueueConsumer;
interface StartWorkerInternalOptions extends WorkerConfig {
    /** Injectable queue consumer (tests). Defaults to BullMQ when redis given. */
    consumer?: QueueConsumer;
    logger?: Logger;
}
export declare function startWorker(definition: BusinessDefinition, config: StartWorkerInternalOptions): Promise<WorkerHandle>;
export interface FailureClassification {
    errorCode: string;
    retryable: boolean;
    retryAfterMs?: number;
    detail?: string;
}
/**
 * Classify a handler failure for the runtime (docs 04: runtime owns budget).
 * Business errors may carry `code`/`retryable`/`retryAfterMs` properties.
 */
export declare function classifyFailure(err: unknown): FailureClassification;
export {};
//# sourceMappingURL=worker.d.ts.map
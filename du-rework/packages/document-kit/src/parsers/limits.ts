import { ParserOptions } from '../types';

/**
 * Validates ParserOptions against structural and domain constraints.
 *
 * Constraints:
 * - maxBufferSizeBytes: If specified, must be a finite, non-negative integer (>= 0).
 * - timeoutMs: If specified, must be a finite, positive number (> 0).
 *
 * If bufferLength is provided, validates that bufferLength does not exceed maxBufferSizeBytes.
 */
export function validateParserOptions(options?: ParserOptions, bufferLength?: number): void {
  if (!options) return;

  if (options.maxBufferSizeBytes !== undefined) {
    if (
      typeof options.maxBufferSizeBytes !== 'number' ||
      !Number.isFinite(options.maxBufferSizeBytes) ||
      !Number.isInteger(options.maxBufferSizeBytes) ||
      options.maxBufferSizeBytes < 0
    ) {
      throw new TypeError(
        `Invalid maxBufferSizeBytes: must be a finite non-negative integer, received ${options.maxBufferSizeBytes}`
      );
    }

    if (bufferLength !== undefined && bufferLength > options.maxBufferSizeBytes) {
      throw new Error(
        `Document size (${bufferLength} bytes) exceeds maximum allowed parser limit (${options.maxBufferSizeBytes} bytes)`
      );
    }
  }

  if (options.timeoutMs !== undefined) {
    if (
      typeof options.timeoutMs !== 'number' ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0
    ) {
      throw new TypeError(
        `Invalid timeoutMs: must be a finite positive number, received ${options.timeoutMs}`
      );
    }
  }
}

/**
 * Wraps an asynchronous operation with a caller wait timeout budget via Promise.race.
 *
 * CRITICAL ARCHITECTURAL BOUNDARY:
 * Timing out rejects the caller's wait Promise. In single-threaded Node.js, synchronous CPU
 * execution (e.g. decompression, regex, AST traversal) or uncooperative async tasks CANNOT be
 * forcibly preempted or cancelled by Promise.race. Late completions from the underlying task
 * are discarded and will never produce caller-visible success or unhandled promise rejections.
 * True preemptive CPU cancellation requires terminable worker-thread or process isolation.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label = 'Parser execution'
): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms budget`));
    }, timeoutMs);
  });

  // Attach a no-op catch handler to ensure late rejection does not cause unhandledRejection
  promise.catch(() => {});

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

import type { InvocationInput, InvocationResponse } from '@du/contracts';
import { ConnectorClientError } from './errors';
import type { ClientInvocationRequest, ClientInvocationResult, ConnectorTransport } from './types';

/**
 * Adapter that plugs a `ConnectorTransport` into the worker SDK's
 * `invokeConnector` seam (`TaskContextDeps.invokeConnector` /
 * `WorkerConfig.invokeConnector`, P4-07 wiring).
 *
 * The SDK contract expects the WIRE shape (`InvocationResponse`) and a
 * returned-not-thrown failure envelope whenever the connector produced a
 * typed outcome, so the SDK's classifier can distinguish:
 *
 * - `FAILED` + `error.retryable`  → runtime retry budget (RETRY_PENDING)
 * - `UNKNOWN`                     → reconcile via the stable invocationId,
 *                                   never a blind provider retry
 * - `PENDING`                     → yield the slot (no spinning)
 *
 * Transport-level HTTP errors (non-2xx) are converted into the same wire
 * envelope: `INVOCATION_UNKNOWN` at status 0 or 409 becomes `state: 'UNKNOWN'`,
 * every other `ConnectorClientError` becomes `state: 'FAILED'` carrying
 * the error's `retryable` flag. Nothing is thrown unless the connector
 * call itself could not be represented (programming error).
 */

/** Structural mirror of the worker-sdk `ConnectorInvocationPayload`. */
export interface SdkInvocationPayload {
  contractVersion: '1';
  invocationId: string;
  grant: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: InvocationInput;
  options?: Record<string, unknown>;
  sessionRef?: string | null;
  deadlineAt: string;
}

/** Structural mirror of the grant object the SDK passes alongside. */
export interface SdkInvocationGrant {
  grant: string;
  invocationId: string;
}

export type SdkConnectorInvoker = (
  grant: SdkInvocationGrant,
  payload: SdkInvocationPayload
) => Promise<InvocationResponse>;

const STATE_TO_WIRE = {
  completed: 'SUCCEEDED',
  pending: 'PENDING',
  failed: 'FAILED',
  unknown: 'UNKNOWN',
  cancelled: 'CANCELLED',
} as const;

export function createSdkConnectorInvoker(
  transport: ConnectorTransport
): SdkConnectorInvoker {
  return async (
    _grant: SdkInvocationGrant,
    payload: SdkInvocationPayload
  ): Promise<InvocationResponse> => {
    const request: ClientInvocationRequest = {
      contractVersion: payload.contractVersion,
      invocationId: payload.invocationId,
      grant: payload.grant,
      operationId: payload.operationId,
      taskId: payload.taskId,
      stepKey: payload.stepKey,
      bindingSlot: payload.bindingSlot,
      input: payload.input,
      options: payload.options,
      sessionRef: payload.sessionRef ?? null,
      deadlineAt: payload.deadlineAt,
    };
    let result: ClientInvocationResult;
    try {
      result = await transport.invoke(request);
    } catch (err) {
      if (err instanceof ConnectorClientError) {
        return errorToWireResponse(payload.invocationId, err);
      }
      throw err;
    }
    return toWireResponse(result);
  };
}

export function toWireResponse(result: ClientInvocationResult): InvocationResponse {
  return {
    invocationId: result.invocationId,
    state: STATE_TO_WIRE[result.state],
    result: (result.result as InvocationResponse['result']) ?? null,
    usage: (result.usage as InvocationResponse['usage']) ?? null,
    providerRequestId: result.providerRequestId,
    error: result.error
      ? {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable ?? false,
          retryAfterMs: result.error.retryAfterMs,
        }
      : null,
    nextPollAt: result.nextPollAt ?? null,
  } as InvocationResponse;
}

function errorToWireResponse(invocationId: string, err: ConnectorClientError): InvocationResponse {
  // Status-0 unknown outcome: the invocation MAY have reached the provider;
  // the SDK must reconcile via the stable invocationId, not mark it failed.
  const state = err.code === 'INVOCATION_UNKNOWN' ? 'UNKNOWN' : 'FAILED';
  return {
    invocationId,
    state,
    result: null,
    usage: null,
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable ?? false,
      retryAfterMs: err.retryAfterMs,
    },
    nextPollAt: null,
  } as InvocationResponse;
}

import { InvocationGrant, InvocationResponse } from '@du/contracts';
import type { ConnectorInvocationPayload } from './task-context';
/**
 * Minimal connector invocation client (P4-07). The full typed client with
 * replay/poll lives in @du/connector-client (Copilot lane); the SDK ships
 * this thin transport so worker-sdk has no cross-lane build dependency.
 * Once connector-client is published against frozen contracts, businesses
 * may inject their own invoke function via WorkerConfig.
 */
export interface ConnectorClientOptions {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
export declare class ConnectorTransportError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message?: string);
}
export declare function createConnectorInvoker(opts: ConnectorClientOptions): (_grant: InvocationGrant, payload: ConnectorInvocationPayload) => Promise<InvocationResponse>;
//# sourceMappingURL=connector-invoker.d.ts.map
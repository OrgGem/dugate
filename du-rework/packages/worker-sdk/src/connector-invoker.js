"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectorTransportError = void 0;
exports.createConnectorInvoker = createConnectorInvoker;
const contracts_1 = require("@du/contracts");
class ConnectorTransportError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message ?? `connector error ${status} ${code}`);
        this.status = status;
        this.code = code;
        this.name = 'ConnectorTransportError';
    }
}
exports.ConnectorTransportError = ConnectorTransportError;
function createConnectorInvoker(opts) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    return async function invokeConnector(_grant, payload) {
        // Validate outgoing payload against the frozen wire contract before send.
        const request = contracts_1.InvocationRequestSchema.parse(payload);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/invocations`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            });
        }
        catch (err) {
            // Transport failure with unknown outcome: surface as UNKNOWN so the
            // runtime/business reconcile instead of blind-retrying the provider.
            throw new ConnectorTransportError(0, 'INVOCATION_UNKNOWN', `transport failure: ${String(err)}`);
        }
        finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        const raw = text.length > 0 ? JSON.parse(text) : undefined;
        if (!response.ok) {
            const code = response.status === 409
                ? 'INVOCATION_UNKNOWN'
                : response.status === 429
                    ? 'PROVIDER_RATE_LIMITED'
                    : response.status >= 500
                        ? 'PROVIDER_UNAVAILABLE'
                        : 'INVALID_INPUT';
            throw new ConnectorTransportError(response.status, code, text.slice(0, 512));
        }
        return contracts_1.InvocationResponseSchema.parse(raw);
    };
}
//# sourceMappingURL=connector-invoker.js.map
/**
 * R1-C recording transports: doubles that NEVER connect. They prove "policy denies before
 * connect" (calls === 0) and capture what production tried to do (hasSignal, redirect,
 * headers) through the injectable seams only (webhooks.ts fetchFn, transport.ts fetcher,
 * createHttpTransport fetchImpl) — never a globalThis.fetch rewrite (report sec.6.1 rule 1).
 */
import { isIP } from 'node:net';

export class RecordingNotConnectedError extends Error {
  constructor(public readonly target: string) {
    super(`harness: connect blocked (recording transport never opens a socket) target=${target}`);
    this.name = 'RecordingNotConnectedError';
  }
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  hasSignal: boolean;
  signalAborted: boolean;
  redirect?: string;
  bodyKind: 'string' | 'object' | 'none';
  bodyPreview?: string;
}

export interface RecordingFetcher {
  fetcher: typeof fetch;
  calls: RecordedCall[];
}

export function makeRecordingFetcher(
  behavior?: (call: RecordedCall) => Response | Promise<Response>,
): RecordingFetcher {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: string | URL | { url?: string }, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input.url ?? input);
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const bodyRaw = init?.body;
    const bodyKind: RecordedCall['bodyKind'] = bodyRaw === undefined || bodyRaw === null ? 'none' : typeof bodyRaw === 'string' ? 'string' : 'object';
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: rawHeaders,
      hasSignal: init?.signal !== undefined && init?.signal !== null,
      signalAborted: init?.signal?.aborted === true,
      redirect: init?.redirect,
      bodyKind,
      bodyPreview: typeof bodyRaw === 'string' ? bodyRaw.slice(0, 512) : undefined,
    };
    calls.push(call);
    if (!behavior) throw new RecordingNotConnectedError(url);
    return behavior(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

/** Shape-compatible with WebhookDispatcherOptions.fetchFn (services/orchestrator/src/modules/webhooks/webhooks.ts:126). */
export interface WebhookCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookFetchFn {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number }>;
}

export function makeWebhookFetchFn(
  behavior?: (call: WebhookCall) => { status: number } | Promise<{ status: number }>,
): { fetchFn: WebhookFetchFn; calls: WebhookCall[] } {
  const calls: WebhookCall[] = [];
  const fetchFn: WebhookFetchFn = async (url, init) => {
    const call: WebhookCall = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    if (!behavior) throw new RecordingNotConnectedError(url);
    return behavior(call);
  };
  return { fetchFn, calls };
}

/** host is an IP literal iff policy tests may skip DNS entirely (offline guarantee). */
export function isIpLiteralHost(host: string): boolean {
  return isIP(host.replace(/^\[|\]$/g, '')) !== 0;
}

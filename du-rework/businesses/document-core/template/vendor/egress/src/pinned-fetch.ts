// VENDORED from @du/egress @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/egress/src/pinned-fetch.ts (lines=365) sha256=A812CE680880174373945BF983E43F8BF666A465EF0312DB90D827C21EB1B638
// why: pinned fetch for vendored worker-sdk source-acquisition

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { adjudicateUrlDestination, isDestinationAddressAllowed } from '@du/contracts';

/**
 * PR-Q3-03 / PR-Q3-09 (FIX-CR-01): DNS-rebinding-safe fetch — ONE resolution shared by
 * policy and connect. The pre-fix path (global undici fetch) resolved the host at
 * adjudication and AGAIN inside connect, so a DNS could answer public first and loopback
 * seconds later (TOCTOU). Here the adjudicated answer is the address actually dialed;
 * HTTPS keeps SNI + certificate verification on the ORIGINAL hostname (tls servername),
 * so pinning does not weaken transport security. Even under allowPrivateNetworks the
 * resolver (when provided) is called exactly once and its answer is dialed.
 *
 * Scope guards (CYCLE-95 HARDENING, review.md finding 3):
 * - NO globalThis.fetch fallback for ANY body shape. FormData is serialized to
 *   multipart/form-data over the SAME pinned connection (the in-repo multipart adapter
 *   uses text fields only); ReadableStream bodies are piped; string/Buffer/ArrayBuffer/
 *   URLSearchParams are written directly. Unknown shapes (Blob parts, exotic objects)
 *   are REJECTED fail-closed — silently routing a credentialed body through an
 *   un-pinned resolver was exactly the latent TOCTOU bypass the reviewer flagged.
 * - Response bodies are decompressed here (gzip/deflate/br) because Node core, unlike
 *   undici fetch, does not — callers' streaming caps then measure DECODED bytes,
 *   matching the pre-migration behavior of the connector transport.
 */

export interface PinnedFetchOptions {
  /** Narrow local-mesh opt-in: RFC1918/loopback/ULA only (contracts semantics), never metadata/CGNAT/multicast. */
  allowPrivateNetworks?: boolean;
  /** Exact IP-literal opt-ins honored; a listed NAME never skips answer adjudication. */
  allowHosts?: ReadonlySet<string>;
  /** Resolver seam (tests + callers with a pre-adjudicated answer cache). Default: dns promises, all answers. */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * CYCLE-101: optional HARD deadline for establishing the response (headers phase).
   * When it fires the socket is destroyed and the promise rejects with a
   * TimeoutError-NAMED error — distinct from caller-abort's AbortError. Body-phase
   * bounding stays with the caller (caps/signals), same as undici fetch semantics.
   */
  timeoutMs?: number;
}

export class DestinationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationDeniedError';
  }
}

type HeaderRecord = Record<string, string>;

function collectHeaders(init: RequestInit | undefined): HeaderRecord {
  const out: HeaderRecord = {};
  const raw = init?.headers;
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const pair of raw) out[String(pair[0]).toLowerCase()] = String(pair[1]);
    return out;
  }
  if (typeof (raw as Headers).forEach === 'function') {
    (raw as Headers).forEach((v: string, k: string) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

interface OutboundBody {
  bytes?: Buffer | string;
  stream?: ReadableStream<Uint8Array>;
  multipart?: { serialize: () => Promise<Buffer>; boundary: string };
  reject?: string;
}

/** Cycle-95: EVERY shape is pinned-or-rejected; there is no un-pinned route anymore. */
async function prepareBody(body: unknown): Promise<OutboundBody> {
  if (body === null || body === undefined) return {};
  if (typeof body === 'string') return { bytes: body };
  if (Buffer.isBuffer(body)) return { bytes: body };
  if (body instanceof Uint8Array) return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  if (body instanceof ArrayBuffer) return { bytes: Buffer.from(body) };
  if (body instanceof URLSearchParams) return { bytes: body.toString() };
  if (body instanceof ReadableStream) return { stream: body };
  if (body instanceof FormData) {
    const boundary = '----DUEgress' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return { multipart: { boundary, serialize: () => serializeMultipart(body, boundary) } };
  }
  return { reject: 'unsupported request body shape for pinned egress: ' + Object.prototype.toString.call(body) };
}

async function serializeMultipart(form: FormData, boundary: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  const encoder = new TextEncoder();
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string') {
      // Blob/File parts are not used by any in-repo adapter; sending them through an
      // un-pinned path is exactly what we removed, so reject instead of approximating.
      throw new DestinationDeniedError('pinned fetch: multipart Blob/File parts are not supported');
    }
    let disp = 'Content-Disposition: form-data; name="' + name.replace(/"/g, '%22') + '"';
    if (value.includes('\r') || value.includes('\n')) disp += '; filename="' + name.replace(/"/g, '%22') + '.txt"';
    parts.push(Buffer.from('--' + boundary + '\r\n' + disp + '\r\nContent-Type: text/plain;charset=utf-8\r\n\r\n', 'utf8'));
    parts.push(Buffer.from(value, 'utf8'));
    parts.push(encoder ? Buffer.from('\r\n', 'utf8') : Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
  return Buffer.concat(parts);
}

function unwrapEncoding(res: IncomingMessage, source: IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return source.pipe(createGunzip());
  if (encoding === 'deflate') return source.pipe(createInflate());
  if (encoding === 'br') return source.pipe(createBrotliDecompress());
  return source;
}

function responseHeaders(res: IncomingMessage): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) out[k] = v.join(', ');
    else if (v !== undefined) out[k] = String(v);
  }
  return out;
}

export interface DialOptionSpec {
  isHttps: boolean;
  dialHost: string;
  port: number;
  hostNoPort: string;
  method: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * CYCLE-101 (pitfall 5 made structural): TLS-only options exist in the returned
 * object ONLY for https. Passing rejectUnauthorized to PLAIN http.request produced
 * connect ETIMEDOUT on loopback (Node 22/Windows, probe-raw2 A/B) — this split is
 * now asserted by unit test instead of living inside an inline spread nobody checks.
 */
export function buildDialOptions(spec: DialOptionSpec): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    host: spec.dialHost,
    port: spec.port,
    method: spec.method,
    path: spec.path,
    headers: spec.headers,
  };
  if (spec.isHttps) {
    opts.servername = spec.hostNoPort;
    opts.rejectUnauthorized = true;
  }
  return opts;
}

export function createPinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const resolve =
    options.resolve ??
    (async (host: string) => (await dnsPromises.lookup(host, { all: true })).map((entry) => entry.address));

  const fetcher = (async (input: string | URL | { url?: string }, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url?: string }).url ?? input);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new DestinationDeniedError('pinned fetch: unparseable destination');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DestinationDeniedError('pinned fetch: non-http(s) protocol');
    }
    const headers = collectHeaders(init);
    const prepared = await prepareBody(init?.body);
    if (prepared.reject) throw new DestinationDeniedError('pinned fetch: ' + prepared.reject);
    if (prepared.multipart) headers['content-type'] = 'multipart/form-data; boundary=' + prepared.multipart.boundary;

    const hostNoPort = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const literal = isIP(hostNoPort) !== 0;
    const decision = adjudicateUrlDestination(rawUrl, {
      allowHosts: options.allowHosts,
      allowPrivateNetworks: options.allowPrivateNetworks,
    });
    if (decision.kind === 'DENIED') {
      throw new DestinationDeniedError('pinned fetch: destination denied (' + decision.reason + ')');
    }
    // Candidate dial set: the adjudicated answers themselves (never a re-resolve),
    // deduplicated, IPv4-preferred so a localhost mesh that binds 127.0.0.1 does not
    // pay a ::1 connect timeout first. Literal hosts dial the literal.
    let candidates: string[] = [];
    if (!literal) {
      let answers: string[];
      try {
        answers = await resolve(hostNoPort);
      } catch (err) {
        // CYCLE-101: resolver failure is a SANITIZED denial-shaped error (never a raw
        // dns message reaching caller logs), and connect provably never happened.
        const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : 'Error');
        throw new DestinationDeniedError('pinned fetch: dns resolution failed (' + String(code) + ')');
      }
      if (!Array.isArray(answers)) {
        throw new DestinationDeniedError('pinned fetch: dns resolver returned a non-list answer');
      }
      if (decision.kind === 'NEEDS_RESOLUTION') {
        if (!answers.every((answer) => isDestinationAddressAllowed(answer, options))) {
          throw new DestinationDeniedError('pinned fetch: resolved destination is not routable');
        }
        if (answers.length === 0) throw new DestinationDeniedError('pinned fetch: empty dns answer');
      }
      candidates = Array.from(new Set(answers));
    }
    if (candidates.length === 0) candidates = [hostNoPort];
    candidates.sort((a, b) => (isIP(a) === 4 ? 0 : 1) - (isIP(b) === 4 ? 0 : 1));

    headers.host = url.host;
    if (!('accept-encoding' in headers)) headers['accept-encoding'] = 'gzip, deflate, br';

    const attemptOne = (dialHost: string): Promise<Response> => new Promise<Response>((fulfill, reject) => {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req: ClientRequest = transport(
        buildDialOptions({
          isHttps: url.protocol === 'https:',
          dialHost,
          port,
          hostNoPort,
          method: init?.method ?? 'GET',
          path: url.pathname + url.search,
          headers,
        }),
        (res) => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          const status = res.statusCode ?? 0;
          const rawLocation = res.headers.location;
          const location = typeof rawLocation === 'string' && rawLocation.length > 0 ? rawLocation : undefined;
          if (status >= 300 && status < 400 && location !== undefined) {
            // CYCLE-103 redirect-hop boundary: egress never FOLLOWED a redirect
            // (Node-core manual semantics), but returning a 3xx that points at
            // private/loopback/link-local/metadata space hands every naive caller
            // upstream an internal-address follow vector. So the hop is adjudicated
            // HERE: internal targets are destroyed+denied; public 3xx pass through
            // untouched for the caller's own redirect policy.
            void (async (): Promise<void> => {
              let hop: URL;
              try {
                hop = new URL(location, url);
              } catch {
                req.destroy();
                reject(new DestinationDeniedError('pinned fetch: redirect location is unparseable'));
                return;
              }
              const decision2 = adjudicateUrlDestination(hop.toString(), {
                allowHosts: options.allowHosts,
                allowPrivateNetworks: options.allowPrivateNetworks,
              });
              if (decision2.kind === 'DENIED') {
                req.destroy();
                reject(new DestinationDeniedError('pinned fetch: redirect hop to blocked destination (' + decision2.reason + ')'));
                return;
              }
              if (decision2.kind === 'NEEDS_RESOLUTION' && decision2.host) {
                let answers: string[];
                try {
                  answers = await resolve(decision2.host);
                } catch (err) {
                  req.destroy();
                  reject(new DestinationDeniedError('pinned fetch: redirect hop dns resolution failed (' + String((err as NodeJS.ErrnoException).code ?? 'Error') + ')'));
                  return;
                }
                if (!Array.isArray(answers) || !answers.every((a) => isDestinationAddressAllowed(a, options))) {
                  req.destroy();
                  reject(new DestinationDeniedError('pinned fetch: redirect hop resolves to a blocked destination'));
                  return;
                }
              }
              fulfillResponse(res, status);
            })();
            return;
          }
          fulfillResponse(res, status);
        }
      );
      function fulfillResponse(response: IncomingMessage, responseStatus: number): void {
        const decoded = unwrapEncoding(response, response);
        const web = Readable.toWeb(decoded as unknown as Readable) as unknown as ReadableStream;
        fulfill(
          new Response(web, {
            status: responseStatus,
            statusText: response.statusMessage ?? undefined,
            headers: responseHeaders(response),
          })
        );
      }
      // CYCLE-101 deadlines: caller signal (AbortError) AND optional timeoutMs
      // (TimeoutError) both DESTROY the socket — no orphan connection survives either
      // way; the timer is unref'd and cleared the moment the response arrives.
      const signal = init?.signal;
      let timedOut = false;
      const deadlineTimer =
        options.timeoutMs !== undefined && options.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              req.destroy(deadlineError());
            }, options.timeoutMs)
          : undefined;
      deadlineTimer?.unref?.();
      function deadlineError(): Error {
        return timedOut
          ? Object.assign(new Error('pinned fetch timeout'), { name: 'TimeoutError' })
          : Object.assign(new Error('pinned fetch aborted'), { name: 'AbortError' });
      }
      const onAbort = (): ClientRequest => req.destroy(deadlineError());
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('error', (err) => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      if (prepared.multipart) {
        prepared.multipart.serialize().then(
          (buf) => {
            req.write(buf);
            req.end();
          },
          (err: unknown) => req.destroy(err instanceof Error ? err : new Error(String((err as Error)?.name ?? 'multipart error')))
        );
      } else if (prepared.stream) {
        const nodeSrc = Readable.fromWeb(prepared.stream as never);
        nodeSrc.on('error', (err: unknown) => req.destroy(err as Error));
        nodeSrc.pipe(req);
      } else {
        if (prepared.bytes !== undefined) req.write(prepared.bytes);
        req.end();
      }
    });

    // Connect-level failover across the ALREADY-ADJUDICATED candidate set only —
    // never a re-resolve, so this cannot reopen the rebinding window.
    let lastError: unknown = null;
    for (let index = 0; index < candidates.length; index++) {
      const dialHost = candidates[index] as string;
      try {
        return await attemptOne(dialHost);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        const connectLevel = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
        if (!connectLevel || index === candidates.length - 1) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new DestinationDeniedError('pinned fetch: no dial candidates');
  }) as typeof fetch;
  return fetcher;
}

import { lookup } from 'node:dns/promises';
import { adjudicateUrlDestination, isDestinationAddressAllowed } from '@du/contracts';
import { ConnectorError } from '../errors';
import { createPinnedFetch } from '@du/egress';
import type { ProviderTransport } from '../invoke';
import type { ProviderRequest, ProviderResponse } from '../types';

/**
 * R1-C FIX-CR-01: destination adjudication delegates to the shared byte-space policy in
 * @du/contracts (single source of truth pinned by tests/harness/network-boundaries +
 * services/connector/tests/network-boundaries.boundary.test.ts). allowPrivateNetworks
 * is a narrow opt-in for RFC1918, loopback, and IPv6 ULA (default false); it does not
 * permit link-local/metadata, unspecified, CGNAT, multicast, or reserved ranges.
 * allowHosts honors EXACT IP-literal opt-ins only; a listed DOMAIN still resolves and
 * every DNS answer still gets adjudicated (A-red-4).
 * R1-C FIX-CR-08: response bodies are consumed with a hard streaming cap — reading stops
 * and the body is cancelled the moment the limit is crossed (B1-red), instead of
 * buffering the whole stream first.
 */

export interface FetchProviderTransportOptions {
  maxResponseBytes?: number;
  /** When omitted, the DEFAULT is the PR-Q3-03 pinned fetch (policy+connect share ONE resolution). */
  fetcher?: typeof fetch;
  allowHosts?: readonly string[];
  allowPrivateNetworks?: boolean;
  /** Resolver seam forwarded to the pinned default fetch (tests pin rebinding sequences). */
  resolve?: (host: string) => Promise<string[]>;
}

export class FetchProviderTransport implements ProviderTransport {
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof fetch;
  private readonly allowHosts: ReadonlySet<string>;
  private readonly allowPrivateNetworks: boolean;

  public constructor(options: FetchProviderTransportOptions = {}) {
    this.maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
    this.allowHosts = new Set((options.allowHosts ?? []).map((host) => host.toLowerCase()));
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.fetcher =
      options.fetcher ??
      createPinnedFetch({
        allowHosts: this.allowHosts,
        allowPrivateNetworks: this.allowPrivateNetworks,
        resolve: options.resolve,
      });
  }

  public async send(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    try {
      await validateProviderUrl(request.url, {
        allowHosts: this.allowHosts,
        allowPrivateNetworks: this.allowPrivateNetworks,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider destination could not be resolved.');
    }
    let response: Response;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: typeof request.body === 'string' || request.body instanceof FormData
          ? request.body
          : Buffer.from(request.body),
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider request could not be sent.');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider redirects are not followed.');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > this.maxResponseBytes) {
      throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response is too large.');
    }
    const bytes = await readCappedBody(response, this.maxResponseBytes);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    if (text.length > 0 && response.headers.get('content-type')?.includes('application/json')) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider returned invalid JSON.');
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }
}

/** FIX-CR-08: cap DURING streaming, not after buffering; cancel the body on breach. */
async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = (): ConnectorError =>
    new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response is too large.');
  if (!response.body) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    if (buffered.byteLength > maxBytes) throw tooLarge();
    return buffered;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    // Pre-existing semantics: transport/abort errors propagate unchanged (classify.ts
    // and the durable tests depend on AbortError identity); only cap breach is ours.
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function validateProviderUrl(
  value: string,
  options: { allowHosts?: ReadonlySet<string>; allowPrivateNetworks?: boolean } = {},
): Promise<URL> {
  // Scheme/credentials are ALWAYS validated (pinned by the A-lock-2 boundary case).
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError('INVALID_INPUT', 'Provider URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectorError('INVALID_INPUT', 'Provider URL scheme or credentials are not supported.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConnectorError('INVALID_INPUT', 'Provider URL scheme or credentials are not supported.');
  }
  const decision = adjudicateUrlDestination(value, {
    allowHosts: options.allowHosts,
    allowPrivateNetworks: options.allowPrivateNetworks,
  });
  if (decision.kind === 'DENIED') {
    throw new ConnectorError('INVALID_INPUT', 'Provider destination is not allowed.');
  }
  if (decision.kind === 'NEEDS_RESOLUTION' && decision.host) {
    const answers = await lookup(decision.host, { all: true });
    if (answers.length === 0 || !answers.every((entry) => isDestinationAddressAllowed(entry.address, {
      allowPrivateNetworks: options.allowPrivateNetworks,
    }))) {
      throw new ConnectorError('INVALID_INPUT', 'Provider destination is not allowed.');
    }
  }
  return url;
}

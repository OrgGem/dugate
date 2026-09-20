import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConnectorError } from '../errors';
import type { ProviderTransport } from '../invoke';
import type { ProviderRequest, ProviderResponse } from '../types';

export interface FetchProviderTransportOptions {
  maxResponseBytes?: number;
  fetcher?: typeof fetch;
  allowHosts?: readonly string[];
  allowPrivateNetworks?: boolean;
}

export class FetchProviderTransport implements ProviderTransport {
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof fetch;
  private readonly allowHosts: ReadonlySet<string>;
  private readonly allowPrivateNetworks: boolean;

  public constructor(options: FetchProviderTransportOptions = {}) {
    this.maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
    this.fetcher = options.fetcher ?? fetch;
    this.allowHosts = new Set((options.allowHosts ?? []).map((host) => host.toLowerCase()));
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) {
      throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response is too large.');
    }
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

export async function validateProviderUrl(
  value: string,
  options: { allowHosts?: ReadonlySet<string>; allowPrivateNetworks?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError('INVALID_INPUT', 'Provider URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ConnectorError('INVALID_INPUT', 'Provider URL scheme or credentials are not supported.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (options.allowHosts?.has(host) || options.allowPrivateNetworks) return url;
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.some(isBlockedAddress)) {
    throw new ConnectorError('INVALID_INPUT', 'Provider destination is not allowed.');
  }
  return url;
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

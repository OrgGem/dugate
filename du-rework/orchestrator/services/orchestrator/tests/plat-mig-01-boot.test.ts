import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectorRevisionStateSchema } from '@du/contracts';
import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import { connectorBaseUrlResolver } from '../src/app/bootstrap/create-app';
import {
  assertConnectorComposition,
  connectorBaseUrlsFromEnv,
} from '../src/main';
import { createConnectorManagementAuthorizationProvider } from '../src/modules/connectors/management-service-identity';
import { HttpError } from '../src/http/errors';

/** PLAT-MIG-01: the connector management boot composition. */

const BASE_URLS: Record<string, string> = { 'default-connector': 'http://connector:8080' };
const KEY = Buffer.alloc(32, 0x42);
const SERVICE_IDENTITY_SECRET = KEY.toString('base64');
const authorizationForRequest = createConnectorManagementAuthorizationProvider(KEY);

async function startMockConnector(): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: { path: string; headers: Record<string, string> }[];
}> {
  const requests: { path: string; headers: Record<string, string> }[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers as Record<string, string> });
    const state = ConnectorRevisionStateSchema.options[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ connectorId: 'default-connector', revision: 1, adapter: 'mock', state, config: {}, credentialRef: 'vault:mock' }]));
  });
  // Below the Windows ephemeral range, with a bounded retry on EADDRINUSE.
  let port = 0;
  for (let candidate = 41973; candidate < 41990 && port === 0; candidate += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => resolve());
      });
      port = (server.address() as AddressInfo).port;
    } catch {
      server.removeAllListeners('error');
    }
  }
  if (port === 0) throw new Error('no free loopback port for the mock connector');
  return {
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
  };
}

describe('partial connector config fails closed', () => {
  it('base URLs without a signed service identity are refused', () => {
    expect(() => assertConnectorComposition({ DU_CONNECTOR_BASE_URLS: JSON.stringify(BASE_URLS) }))
      .toThrow(/SERVICE_IDENTITY_SECRET is required/);
  });

  it('an empty base-URL map is refused, not treated as empty-and-fine', () => {
    expect(() => connectorBaseUrlsFromEnv({ DU_CONNECTOR_BASE_URLS: '{}' })).toThrow(/must not be empty/);
  });

  it('non-JSON and non-URL values are refused', () => {
    expect(() => connectorBaseUrlsFromEnv({ DU_CONNECTOR_BASE_URLS: 'not json' })).toThrow(/JSON object/);
    expect(() => connectorBaseUrlsFromEnv({ DU_CONNECTOR_BASE_URLS: '[]' })).toThrow(/JSON object/);
    expect(() => connectorBaseUrlsFromEnv({ DU_CONNECTOR_BASE_URLS: JSON.stringify({ a: '' }) })).toThrow(/non-empty base URL/);
    expect(() => connectorBaseUrlsFromEnv({ DU_CONNECTOR_BASE_URLS: JSON.stringify({ '': 'http://x' }) })).toThrow(/non-empty connector ids/);
  });

  it('legacy arbitrary-header identity configuration is refused', () => {
    expect(() => assertConnectorComposition({
      DU_CONNECTOR_BASE_URLS: JSON.stringify(BASE_URLS),
      DU_CONNECTOR_MANAGEMENT_HEADERS: JSON.stringify({ authorization: 'Bearer operator-token' }),
      SERVICE_IDENTITY_SECRET,
    })).toThrow(/DU_CONNECTOR_MANAGEMENT_HEADERS is no longer supported/);
  });

  it('a complete surface composes with a decoded 32-byte issuer key', () => {
    const composed = assertConnectorComposition({
      DU_CONNECTOR_BASE_URLS: JSON.stringify(BASE_URLS),
      SERVICE_IDENTITY_SECRET,
    });
    expect(composed.connectorBaseUrls).toEqual(BASE_URLS);
    expect(composed.connectorManagementAuthorizationForRequest).toEqual(expect.any(Function));
  });

  it('a short decoded key is refused without exposing the configured value', () => {
    expect(() => assertConnectorComposition({
      DU_CONNECTOR_BASE_URLS: JSON.stringify(BASE_URLS),
      SERVICE_IDENTITY_SECRET: Buffer.alloc(8, 0x55).toString('base64'),
    })).toThrow(/base64-encoded 32-byte secret/);
  });

  it('the legacy out-of-token expiry setting is refused', () => {
    expect(() => assertConnectorComposition({
      DU_CONNECTOR_BASE_URLS: JSON.stringify(BASE_URLS),
      SERVICE_IDENTITY_SECRET,
      DU_CONNECTOR_IDENTITY_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    })).toThrow(/DU_CONNECTOR_IDENTITY_EXPIRES_AT is obsolete/);
  });
});

describe('management surface against a mock Connector', () => {
  it('a configured deployment lists REAL revisions, not a placeholder', async () => {
    const mock = await startMockConnector();
    try {
      const store = createConnectorManagementStore({
        baseUrlFor: connectorBaseUrlResolver({ 'default-connector': mock.url }),
        authorizationForRequest,
      });
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.connectorId).toBe('default-connector');
      expect(list[0]?.adapter).toBe('mock');
      expect(mock.requests[0]?.headers.authorization).toMatch(/^Bearer [\w.-]+$/);
    } finally {
      await mock.close();
    }
  });

  it('an unknown connector id is rejected, never an empty list', async () => {
    const mock = await startMockConnector();
    try {
      const resolve = connectorBaseUrlResolver({ 'default-connector': mock.url });
      expect(() => resolve('nope')).toThrow(HttpError);
      try {
        resolve('nope');
        throw new Error('expected a throw');
      } catch (error) {
        expect((error as HttpError).code).toBe('NOT_FOUND');
      }
      // The store asks the resolver first, so an unknown id is refused BEFORE
      // any call: a refusal, never a silent empty list.
      const store = createConnectorManagementStore({ baseUrlFor: resolve, authorizationForRequest });
      await expect(store.getRevision('nope', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await mock.close();
    }
  });

  it('with no base URLs the surface fails closed instead of listing empty', () => {
    expect(() => connectorBaseUrlResolver({})()).toThrow(HttpError);
    try {
      connectorBaseUrlResolver({})();
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as HttpError).code).toBe('SERVICE_UNAVAILABLE');
    }
  });
});

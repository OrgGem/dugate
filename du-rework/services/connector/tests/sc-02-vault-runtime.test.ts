import {
  DurableConnectorRuntime,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  jsonHttpAdapter,
  hashInvocationInput,
  type GrantClaims,
  type LocalInvocationRequest,
} from '../src';
import type { ConnectorConfigRepository, ConnectorRevision } from '../src/db/repository';
import type { AdapterRegistry } from '../src/adapters/registry';
import type { ProviderTransport } from '../src/invoke';
import { VaultReaderError, createVaultKv2HttpReader, createDaemonBackedVaultKv2Reader } from '../src/vault/reader';
import { createAppRoleTokenClient } from '../src/vault/approle';
import { createTokenRenewalDaemon } from '../src/vault/token-renewal';
import { createConnectorVaultRuntime, connectorVaultRuntimeFromEnv } from '../src/vault/runtime';
import type { CredentialSource } from '../src/vault/resolver';

/**
 * SC-02 (SECRET-CATALOG-20261006) focused tests — offline mock Vault HTTP.
 * Closes CR06-02 chain: AppRole identity → renewal daemon → scoped KV v2
 * reader → SecretResolver → DurableConnectorRuntime invocation.
 */

const TENANT_ID = 'tenant-a';
const CONNECTOR_ID = 'openai';
const ACCOUNT_ID = 'acct-openai-main';
const REVISION = 7;
const CANONICAL_PATH = `du/tenants/${TENANT_ID}/connectors/${CONNECTOR_ID}/accounts/${ACCOUNT_ID}`;
const SCOPE = { mount: 'secret', pathPrefix: 'du/tenants' };
const SECRET_V3 = 'vault-secret-SENTINEL-V3';
const SECRET_V4 = 'vault-secret-SENTINEL-V4';

interface VaultCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function lowerHeaders(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(
    Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

function makeMockVault(leaseSeconds = 120) {
  const versions = new Map<string, Map<number, Record<string, string>>>();
  const calls: VaultCall[] = [];
  let issued = 0;
  let outage = false;
  let rejectRenew = false;
  const liveTokens = new Set<string>();

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const method = init?.method ?? 'GET';
    const headers = lowerHeaders(init);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, headers, body });
    if (outage) return new Response('{"errors":["outage"]}', { status: 503 });
    if (parsed.pathname === '/v1/auth/approle/login') {
      const payload = JSON.parse(body) as { role_id?: string; secret_id?: string };
      if (payload.role_id !== 'role-1' || payload.secret_id !== 'secret-1') {
        return new Response('{"errors":["invalid role"]}', { status: 400 });
      }
      issued += 1;
      const token = 'hvs.approle-' + issued;
      liveTokens.add(token);
      return jsonResponse({ auth: { client_token: token, lease_duration: leaseSeconds } });
    }
    if (parsed.pathname === '/v1/auth/token/renew-self') {
      const token = headers['x-vault-token'];
      if (!token || !liveTokens.has(token)) return new Response('{"errors":["bad token"]}', { status: 403 });
      if (rejectRenew) return new Response('{"errors":["not renewable"]}', { status: 400 });
      return jsonResponse({ auth: { client_token: token, lease_duration: leaseSeconds } });
    }
    const dataMatch = /^\/v1\/([^/]+)\/data\/(.+)$/.exec(parsed.pathname);
    if (dataMatch) {
      const token = headers['x-vault-token'];
      if (!token || !liveTokens.has(token)) return new Response('{"errors":["permission denied"]}', { status: 403 });
      const key = dataMatch[1] + '::' + decodeURIComponent(dataMatch[2]!);
      const versionParam = parsed.searchParams.get('version');
      const byVersion = versions.get(key);
      if (!byVersion) return new Response('{"errors":[]}', { status: 404 });
      const wanted = versionParam === null ? Math.max(...byVersion.keys()) : Number(versionParam);
      const fields = byVersion.get(wanted);
      if (!fields) return new Response('{"errors":[]}', { status: 404 });
      return jsonResponse({ data: { data: fields, metadata: { version: wanted } } });
    }
    return new Response('{"errors":["not found"]}', { status: 404 });
  };

  return {
    fetchImpl,
    calls,
    setOutage: (value: boolean) => { outage = value; },
    setRejectRenew: (value: boolean) => { rejectRenew = value; },
    addToken: (token: string) => { liveTokens.add(token); },
    write(mount: string, path: string, version: number, fields: Record<string, string>) {
      const key = mount + '::' + path;
      const byVersion = versions.get(key) ?? new Map<number, Record<string, string>>();
      byVersion.set(version, fields);
      versions.set(key, byVersion);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function source(overrides: Partial<Extract<CredentialSource, { kind: 'vault-kv2' }>> = {}): CredentialSource {
  return {
    kind: 'vault-kv2',
    account: ACCOUNT_ID,
    mount: 'secret',
    path: CANONICAL_PATH,
    key: 'api-key',
    version: 3,
    ...overrides,
  };
}

/* ---------------- AppRole + renewal ---------------- */

describe('SC-02 AppRole token client', () => {
  it('logs in with role credentials and renews the lease', async () => {
    const vault = makeMockVault(120);
    let clock = 1_000;
    const client = createAppRoleTokenClient({
      address: 'https://vault.internal:8200',
      namespace: 'team-a',
      roleId: 'role-1',
      secretId: 'secret-1',
      fetchImpl: vault.fetchImpl,
      now: () => clock,
    });
    const token = await client.login();
    expect(token.value).toMatch(/^hvs\.approle-/);
    expect(token.expiresAtMs).toBe(1_000 + 120_000);
    const login = vault.calls[0]!;
    expect(login.url).toBe('https://vault.internal:8200/v1/auth/approle/login');
    expect(login.headers['x-vault-namespace']).toBe('team-a');
    expect(JSON.parse(login.body)).toEqual({ role_id: 'role-1', secret_id: 'secret-1' });

    clock += 60_000;
    const renewed = await client.renew(token);
    expect(renewed?.value).toBe(token.value);
    expect(vault.calls[1]!.headers['x-vault-token']).toBe(token.value);

    vault.setRejectRenew(true);
    expect(await client.renew(token)).toBeNull();
  });

  it('treats login rejection as non-retryable and transport/5xx as retryable', async () => {
    const vault = makeMockVault();
    const bad = createAppRoleTokenClient({
      address: 'https://vault.internal:8200', roleId: 'wrong', secretId: 'wrong', fetchImpl: vault.fetchImpl,
    });
    await expect(bad.login()).rejects.toMatchObject({ name: 'VaultAuthError', code: 'VAULT_AUTH_REJECTED', retryable: false });

    vault.setOutage(true);
    const flaky = createAppRoleTokenClient({
      address: 'https://vault.internal:8200', roleId: 'role-1', secretId: 'secret-1', fetchImpl: vault.fetchImpl,
      maxResponseBytes: 1024,
    });
    await expect(flaky.login()).rejects.toMatchObject({ code: 'VAULT_TRANSPORT', retryable: true });
  });

  it('rejects an unbounded/invalid auth response without echoing secrets', async () => {
    const client = createAppRoleTokenClient({
      address: 'https://vault.internal:8200',
      roleId: 'role-1',
      secretId: SECRET_V3,
      fetchImpl: async () => jsonResponse({ auth: { client_token: 'hvs.x', lease_duration: 0 } }),
    });
    await expect(client.login()).rejects.toMatchObject({ name: 'VaultAuthError', code: 'VAULT_RESPONSE_INVALID' });
    let message = '';
    try {
      await client.login();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET_V3);
  });
});

describe('SC-02 renewal daemon cycle with AppRole identity', () => {
  it('authenticates, renews at the margin, keeps a valid token on renew outage, re-logins on lost lease', async () => {
    const vault = makeMockVault(120);
    let clock = 10_000;
    const scheduled: Array<{ at: number; fn: () => void }> = [];
    const daemon = createTokenRenewalDaemon({
      client: createAppRoleTokenClient({
        address: 'https://vault.internal:8200', roleId: 'role-1', secretId: 'secret-1',
        fetchImpl: vault.fetchImpl, now: () => clock,
      }),
      safetyMarginMs: 30_000,
      retryBaseMs: 1_000,
      minLeadMs: 10,
      now: () => clock,
      schedule: (fn, ms) => { scheduled.push({ at: clock + ms, fn }); return scheduled.length - 1; },
      cancel: () => undefined,
    });

    await daemon.start();
    expect(daemon.state()).toBe('active');
    expect(daemon.current()?.value).toBe('hvs.approle-1');

    vault.setOutage(true);
    clock += 95_000; // inside the safety margin
    expect(await daemon.runOnce()).toBe('retrying');
    expect(daemon.current()?.value).toBe('hvs.approle-1'); // still-valid token kept

    vault.setOutage(false);
    vault.setRejectRenew(true);
    clock += 10_000;
    expect(await daemon.runOnce()).toBe('authenticated'); // lease not renewable → re-login
    expect(daemon.current()?.value).toBe('hvs.approle-2');

    daemon.stop();
  });
});

/* ---------------- HTTP reader ---------------- */

describe('SC-02 scoped Vault KV v2 reader', () => {
  it('reads a version-pinned field with namespace and scope enforcement', async () => {
    const vault = makeMockVault();
    vault.addToken('hvs.reader-1');
    vault.write('secret', CANONICAL_PATH, 3, { 'api-key': SECRET_V3 });
    const reader = createVaultKv2HttpReader({
      address: 'https://vault.internal:8200',
      namespace: 'team-a',
      allowedScopes: [SCOPE],
      token: () => 'hvs.reader-1',
      fetchImpl: vault.fetchImpl,
    });

    await expect(reader.readSecret({ account: ACCOUNT_ID, mount: 'secret', path: CANONICAL_PATH, key: 'api-key', version: 3 }))
      .resolves.toBe(SECRET_V3);
    const call = vault.calls[0]!;
    expect(call.url).toBe('https://vault.internal:8200/v1/secret/data/' + CANONICAL_PATH + '?version=3');
    expect(call.headers['x-vault-token']).toBe('hvs.reader-1');
    expect(call.headers['x-vault-namespace']).toBe('team-a');
  });

  it.each([
    ['out-of-scope path', { account: ACCOUNT_ID, mount: 'secret', path: 'other-project/secrets', key: 'api-key', version: 1 }, 'VAULT_SCOPE_DENIED'],
    ['wrong mount', { account: ACCOUNT_ID, mount: 'kv-prod', path: CANONICAL_PATH, key: 'api-key', version: 1 }, 'VAULT_SCOPE_DENIED'],
    ['traversal path', { account: ACCOUNT_ID, mount: 'secret', path: '../../etc/passwd', key: 'api-key', version: 1 }, 'VAULT_BAD_REQUEST'],
  ])('%s fails before any HTTP call', async (_label, input, code) => {
    const vault = makeMockVault();
    const reader = createVaultKv2HttpReader({
      address: 'https://vault.internal:8200', allowedScopes: [SCOPE], token: () => 'hvs.reader-1', fetchImpl: vault.fetchImpl,
    });
    await expect(reader.readSecret(input)).rejects.toMatchObject({ name: 'VaultReaderError', code });
    expect(vault.calls).toHaveLength(0);
  });

  it('no live token ⇒ VAULT_UNAUTHENTICATED with zero requests (no fallback)', async () => {
    const vault = makeMockVault();
    const reader = createDaemonBackedVaultKv2Reader({
      daemon: {
        current: () => undefined,
        state: () => 'unauthenticated',
        start: async () => undefined,
        stop: () => undefined,
        runOnce: async () => 'unauthenticated',
        nextAttemptAtMs: () => undefined,
      },
      reader: createVaultKv2HttpReader({
        address: 'https://vault.internal:8200', allowedScopes: [SCOPE], token: () => 'hvs.reader-1', fetchImpl: vault.fetchImpl,
      }),
    });
    await expect(reader.readSecret({ account: ACCOUNT_ID, mount: 'secret', path: CANONICAL_PATH, key: 'api-key', version: 3 }))
      .rejects.toMatchObject({ code: 'VAULT_UNAUTHENTICATED', retryable: false });
    expect(vault.calls).toHaveLength(0);
  });

  it('maps Vault status codes to typed retryability and never echoes values', async () => {
    const statusFor = async (status: number) => {
      const reader = createVaultKv2HttpReader({
        address: 'https://vault.internal:8200',
        allowedScopes: [SCOPE],
        token: () => 'hvs.reader-1',
        fetchImpl: async () => new Response('{"errors":["denied"]}', { status }),
      });
      return reader.readSecret({ account: ACCOUNT_ID, mount: 'secret', path: CANONICAL_PATH, key: 'api-key', version: 3 })
        .catch((e: VaultReaderError) => e);
    };
    expect(await statusFor(404)).toMatchObject({ code: 'VAULT_NOT_FOUND', retryable: false });
    expect(await statusFor(403)).toMatchObject({ code: 'VAULT_PERMISSION_DENIED', retryable: false });
    expect(await statusFor(500)).toMatchObject({ code: 'VAULT_SERVER_ERROR', retryable: true });
    expect(await statusFor(429)).toMatchObject({ code: 'VAULT_SERVER_ERROR', retryable: true });

    const nonKv = createVaultKv2HttpReader({
      address: 'https://vault.internal:8200', allowedScopes: [SCOPE], token: () => 'hvs.reader-1',
      fetchImpl: async () => jsonResponse({ data: { value: SECRET_V3 } }),
    });
    let message = '';
    try {
      await nonKv.readSecret({ account: ACCOUNT_ID, mount: 'secret', path: CANONICAL_PATH, key: 'api-key', version: 3 });
      throw new Error('fixture: non-KV response must fail');
    } catch (error) {
      expect((error as VaultReaderError).code).toBe('VAULT_NOT_FOUND');
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET_V3);
  });
});

/* ---------------- runtime end-to-end ---------------- */

describe('SC-02 production chain closes CR06-02 at the invocation boundary', () => {
  function createRuntimeFixture() {
    const vault = makeMockVault();
    vault.write('secret', CANONICAL_PATH, 3, { 'api-key': SECRET_V3 });
    vault.write('secret', CANONICAL_PATH, 4, { 'api-key': SECRET_V4 });
    let clock = 1_000;
    const scheduled: Array<{ at: number; fn: () => void }> = [];
    const vaultRuntime = createConnectorVaultRuntime({
      address: 'https://vault.internal:8200',
      roleId: 'role-1',
      secretId: 'secret-1',
      scopes: [SCOPE],
      fetchImpl: vault.fetchImpl,
      daemon: {
        safetyMarginMs: 30_000,
        minLeadMs: 10,
        now: () => clock,
        schedule: (fn, ms) => { scheduled.push({ at: clock + ms, fn }); return scheduled.length - 1; },
        cancel: () => undefined,
      },
    });

    const localRequest: LocalInvocationRequest = {
      contractVersion: '1',
      invocationId: 'sc02-invocation',
      tenantId: TENANT_ID,
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      stepKey: 'extract',
      bindingSlot: 'reasoning',
      input: { prompt: 'sc02' },
      deadlineAt: '2099-01-01T00:00:00.000Z',
    };
    const grantTenantId = TENANT_ID;
    const revisionFor = (credentialSource: CredentialSource, tenantId = TENANT_ID): ConnectorRevision => ({
      connectorId: CONNECTOR_ID,
      revision: REVISION,
      adapter: 'openai-http',
      config: { baseUrl: 'https://provider.example', path: '/v1/infer', timeoutMs: 1_000 },
      credentialRef: 'credential-openai-main',
      state: 'ACTIVE',
      credentialSource,
      tenantId,
      accountId: ACCOUNT_ID,
    });
    const providerRequests: Array<Record<string, string>> = [];
    let invocationSeq = 0;

    const invokeWith = (credentialSource: CredentialSource, tenantId = TENANT_ID) => {
      invocationSeq += 1;
      const local = { ...localRequest, tenantId: grantTenantId, invocationId: `${localRequest.invocationId}-${invocationSeq}` };
      const revision = revisionFor(credentialSource, tenantId);
      const repository = {
        getRevision: async (connectorId: string, revisionNumber: number, scope?: { tenantId?: string }) =>
          connectorId === revision.connectorId && revisionNumber === revision.revision
          && scope?.tenantId === revision.tenantId ? revision : undefined,
      } as unknown as ConnectorConfigRepository;
      const grant: GrantClaims = {
        audience: 'connector',
        tenantId: grantTenantId,
        operationId: local.operationId,
        taskId: local.taskId,
        stepKey: local.stepKey,
        invocationId: local.invocationId,
        inputHash: hashInvocationInput(local),
        connectorRevision: `${CONNECTOR_ID}:${REVISION}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      const transport: ProviderTransport = {
        send: async (request) => {
          providerRequests.push({ ...request.headers });
          return { status: 200, body: { content: 'ok' } };
        },
      };
      const runtime = new DurableConnectorRuntime(
        new InMemoryInvocationLedger() as never,
        repository,
        new InMemoryQuotaStore(),
        { append: async () => undefined } as never,
        { get: () => jsonHttpAdapter } as unknown as AdapterRegistry,
        transport,
        { encrypt: () => new Uint8Array(), decrypt: () => 'unused' } as never,
        { verify: async () => grant },
        vaultRuntime.secretResolver,
      );
      return runtime.invoke({
        contractVersion: '1',
        invocationId: local.invocationId,
        grant: 'signed-unit-grant',
        operationId: local.operationId,
        taskId: local.taskId,
        stepKey: local.stepKey,
        bindingSlot: local.bindingSlot,
        input: local.input,
        deadlineAt: local.deadlineAt,
      });
    };

    return { vault, vaultRuntime, invokeWith, providerRequests, advance: (ms: number) => { clock += ms; } };
  }

  it('start → login → runtime resolves the pinned vault secret into the provider call', async () => {
    const fixture = createRuntimeFixture();
    await fixture.vaultRuntime.start();

    await expect(fixture.invokeWith(source())).resolves.toMatchObject({ state: 'completed' });
    expect(fixture.providerRequests).toHaveLength(1);
    expect(fixture.providerRequests[0]!.authorization).toBe('Bearer ' + SECRET_V3);
    const read = fixture.vault.calls.find((call) => call.url.includes('/data/'))!;
    expect(read.url).toContain('version=3');
  });

  it('rotating the linked secret version yields the new value on the next revision pin', async () => {
    const fixture = createRuntimeFixture();
    await fixture.vaultRuntime.start();
    await fixture.invokeWith(source({ version: 3 }));
    await fixture.invokeWith(source({ version: 4 }));
    expect(fixture.providerRequests[0]!.authorization).toBe('Bearer ' + SECRET_V3);
    expect(fixture.providerRequests[1]!.authorization).toBe('Bearer ' + SECRET_V4);
  });

  it('cross-tenant grant and out-of-scope refs fail before any Vault read or provider call', async () => {
    const crossTenant = createRuntimeFixture();
    await crossTenant.vaultRuntime.start();
    await expect(crossTenant.invokeWith(source(), 'tenant-b')).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(crossTenant.vault.calls.some((call) => call.url.includes('/data/'))).toBe(false);
    expect(crossTenant.providerRequests).toHaveLength(0);

    const scopeDenied = createRuntimeFixture();
    await scopeDenied.vaultRuntime.start();
    await expect(scopeDenied.invokeWith(source({
      path: 'du/tenants/tenant-a/connectors/openai/accounts/other',
      account: 'other',
    }))).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(scopeDenied.vault.calls.some((call) => call.url.includes('/data/'))).toBe(false);
    expect(scopeDenied.providerRequests).toHaveLength(0);
  });

  it('Vault outage fails closed with retryable PROVIDER_UNAVAILABLE and no provider dispatch', async () => {
    const fixture = createRuntimeFixture();
    await fixture.vaultRuntime.start();
    fixture.vault.setOutage(true);
    await expect(fixture.invokeWith(source())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      safeToRetry: true,
    });
    expect(fixture.providerRequests).toHaveLength(0);
    fixture.vault.setOutage(false);
    await expect(fixture.invokeWith(source())).resolves.toMatchObject({ state: 'completed' });
  });

  it('daemon renewal keeps the runtime chain authenticated across the safety margin', async () => {
    const fixture = createRuntimeFixture();
    await fixture.vaultRuntime.start();
    const firstToken = fixture.vaultRuntime.daemon.current()?.value;
    fixture.advance(95_000);
    expect(await fixture.vaultRuntime.daemon.runOnce()).toBe('renewed');
    expect(fixture.vaultRuntime.daemon.current()?.value).toBe(firstToken);
    await expect(fixture.invokeWith(source())).resolves.toMatchObject({ state: 'completed' });
  });
});

describe('SC-02 environment construction', () => {
  it('returns undefined when Vault is not configured and refuses a half-set surface', () => {
    expect(connectorVaultRuntimeFromEnv({})).toBeUndefined();
    expect(() => connectorVaultRuntimeFromEnv({ VAULT_ADDR: 'https://vault.internal:8200' }))
      .toThrow(/VAULT_APPROLE_ROLE_ID/);
    expect(() => connectorVaultRuntimeFromEnv({
      VAULT_ADDR: 'https://vault.internal:8200',
      VAULT_APPROLE_ROLE_ID: 'role-1',
      VAULT_APPROLE_SECRET_ID: 'secret-1',
      VAULT_REQUEST_TIMEOUT_MS: 'nope',
    })).toThrow(/VAULT_REQUEST_TIMEOUT_MS/);
    expect(() => connectorVaultRuntimeFromEnv({
      VAULT_ADDR: 'https://vault.internal:8200',
      VAULT_APPROLE_ROLE_ID: 'role-1',
      VAULT_APPROLE_SECRET_ID: 'secret-1',
      VAULT_KV_ALLOWED_PREFIX: '../etc',
    })).toThrow(/mount\/prefix/);
  });

  it('builds a runtime from the full env surface', () => {
    const runtime = connectorVaultRuntimeFromEnv({
      VAULT_ADDR: 'https://vault.internal:8200',
      VAULT_APPROLE_ROLE_ID: 'role-1',
      VAULT_APPROLE_SECRET_ID: 'secret-1',
      VAULT_KV_MOUNT: 'secret',
      VAULT_KV_ALLOWED_PREFIX: 'du/tenants',
    });
    expect(runtime).toBeDefined();
    runtime?.stop();
  });
});

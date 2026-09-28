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
import { SecretResolver, type CredentialSource } from '../src/vault/resolver';

const TENANT_ID = 'tenant-a';
const CONNECTOR_ID = 'openai';
const ACCOUNT_ID = 'acct-openai-main';
const REVISION = 7;
const CANONICAL_PATH = `du/tenants/${TENANT_ID}/connectors/${CONNECTOR_ID}/accounts/${ACCOUNT_ID}`;

const localRequest: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'vault-scope-invocation',
  tenantId: TENANT_ID,
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { prompt: 'test invocation' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

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

type RuntimeOptions = {
  /** Signed-grant tenant; defaults to the revision's own tenant. */
  grantTenantId?: string;
  /** Simulate a store whose lookup IGNORES its tenant predicate. */
  unscopedRepository?: boolean;
  /** Bound tenant carried by the revision row itself. */
  revisionTenantId?: string;
};

function createRuntime(
  credentialSource: CredentialSource,
  revisionAccountId = ACCOUNT_ID,
  opts: RuntimeOptions = {},
) {
  const grantTenantId = opts.grantTenantId ?? TENANT_ID;
  const local: LocalInvocationRequest = { ...localRequest, tenantId: grantTenantId };
  const reads: unknown[] = [];
  let providerCalls = 0;
  const revision: ConnectorRevision = {
    connectorId: CONNECTOR_ID,
    revision: REVISION,
    adapter: 'openai-http',
    config: { baseUrl: 'https://provider.example', path: '/v1/infer', timeoutMs: 1_000 },
    credentialRef: 'credential-openai-main',
    state: 'ACTIVE',
    credentialSource,
    // W-VAULT01-BIND-1R: the row carries its own trusted tenant binding; the
    // storage projection is what gates selection (a foreign tenant's lookup
    // never sees the row at all).
    tenantId: opts.revisionTenantId ?? TENANT_ID,
    accountId: revisionAccountId,
  };
  const repository = {
    getRevision: async (connectorId: string, revisionNumber: number, scope?: { tenantId?: string }) =>
      connectorId === revision.connectorId
        && revisionNumber === revision.revision
        && (opts.unscopedRepository === true || scope?.tenantId === revision.tenantId)
        ? revision : undefined,
  } as unknown as ConnectorConfigRepository;
  const resolver = new SecretResolver({
    kv2: {
      readSecret: async (input) => {
        reads.push(input);
        return 'unit-provider-secret';
      },
    },
  });
  const grant: GrantClaims = {
    audience: 'connector',
    tenantId: grantTenantId,
    operationId: localRequest.operationId,
    taskId: localRequest.taskId,
    stepKey: localRequest.stepKey,
    invocationId: localRequest.invocationId,
    inputHash: hashInvocationInput(local),
    connectorRevision: `${CONNECTOR_ID}:${REVISION}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const transport: ProviderTransport = {
    send: async () => {
      providerCalls += 1;
      return { status: 200, body: { content: 'unit response' } };
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
    resolver,
  );
  const invoke = () => runtime.invoke({
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
  return { invoke, reads, providerCalls: () => providerCalls };
}

describe('VAULT-01 account-prefix isolation at invocation boundary', () => {
  it.each([
    ['different tenant', source({ path: 'du/tenants/tenant-b/connectors/openai/accounts/acct-openai-main' })],
    ['different connector', source({ path: 'du/tenants/tenant-a/connectors/anthropic/accounts/acct-openai-main' })],
    ['different account path segment', source({ path: 'du/tenants/tenant-a/connectors/openai/accounts/acct-other' })],
    ['different account ref', source({ account: 'acct-other' })],
    ['sibling account prefix', source({ path: 'du/tenants/tenant-a/connectors/openai/accounts/acct-openai-main-foreign' })],
    ['extra nested path', source({ path: `${CANONICAL_PATH}/nested` })],
  ])('%s mismatch fails before Vault read and provider dispatch', async (_label, credentialSource) => {
    const fixture = createRuntime(credentialSource);

    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('source matching the path but not the stored account binding is denied before Vault read', async () => {
    const fixture = createRuntime(source(), 'acct-other');

    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('matching tenant, connector and account reads the pinned ref then dispatches once', async () => {
    const fixture = createRuntime(source());

    await expect(fixture.invoke()).resolves.toMatchObject({ state: 'completed' });
    expect(fixture.reads).toEqual([{
      account: ACCOUNT_ID,
      mount: 'secret',
      path: CANONICAL_PATH,
      key: 'api-key',
      version: 3,
    }]);
    expect(fixture.providerCalls()).toBe(1);
  });
});

/**
 * W-VAULT-CONNECTOR-ISOLATION-1 (VAULT-05): the invoke boundary must compare
 * the verified grant, the revision row's own trusted binding, and the
 * persisted VaultKv2Ref BEFORE any VaultKv2SecretReader call or provider
 * transport dispatch. Every rejection below asserts reads === 0 and
 * provider calls === 0.
 */
describe('VAULT-05 grant, revision and ref comparison precede Vault and provider', () => {
  it('foreign grant tenant cannot reach a bound revision even with a perfectly matching ref', async () => {
    const fixture = createRuntime(source(), undefined, { grantTenantId: 'tenant-b' });

    await expect(fixture.invoke()).rejects.toMatchObject({
      code: 'BINDING_DENIED',
      message: 'Invocation grant connector revision binding is invalid.',
    });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('a store that ignores its tenant predicate is still denied by the runtime row comparison', async () => {
    const fixture = createRuntime(source(), undefined, {
      grantTenantId: 'tenant-b',
      unscopedRepository: true,
    });

    await expect(fixture.invoke()).rejects.toMatchObject({
      code: 'BINDING_DENIED',
      message: 'Invocation grant connector revision binding is invalid.',
    });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('unsupported credential source kind fails closed as CREDENTIAL_INVALID', async () => {
    const fixture = createRuntime({ kind: 'aws-kms', bucket: 'x' } as unknown as CredentialSource);

    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('a vault ref missing its version pin is rejected before any read', async () => {
    const unpinned = {
      kind: 'vault-kv2',
      account: ACCOUNT_ID,
      mount: 'secret',
      path: CANONICAL_PATH,
      key: 'api-key',
    } as unknown as CredentialSource;
    const fixture = createRuntime(unpinned);

    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('legacy-db credential on a tenant-bound revision is denied before provider dispatch', async () => {
    const fixture = createRuntime({ kind: 'legacy-db', credentialRef: 'credential-openai-main' });

    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });
});

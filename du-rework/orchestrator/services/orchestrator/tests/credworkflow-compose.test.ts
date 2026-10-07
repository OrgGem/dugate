import {
  composeCredentialWorkflow,
  credentialWorkflowEnvRequested,
  CredentialWorkflowBootError,
  VAULT_KV_OPTIONS_ENV,
  VAULT_KV_TOKEN_ENV,
} from '../src/modules/connector-credentials/compose';
import type { ConnectorRevisionStore, RevisionRow } from '../src/modules/connector-credentials/workflow';

/**
 * CREDWORKFLOW-IMPL (D3) — boot composition policy.
 *
 * All env absent → undefined (workflow off, capabilities false). Any env set
 * but incomplete/malformed → typed REFUSE-BOOT (a half-configured production
 * must not boot into silent 503s). Complete env → a workflow that actually
 * rotates through the KV2 writer + revision store.
 */

const SENTINEL = 'CREDWORKFLOW-COMPOSE-SENTINEL-1a2b';
const CANONICAL_PATH = 'du/tenants/t1/connectors/c1/accounts/a1';

const OPTIONS = JSON.stringify({ vaultAddress: 'http://vault.test:8200', kvMount: 'secret' });

function boundRow(): RevisionRow {
  return {
    revision: 2,
    adapter: 'mock-openai',
    state: 'ACTIVE',
    credentialSource: { kind: 'vault-kv2', account: 'a1', mount: 'secret', path: CANONICAL_PATH, key: 'api_key', version: 1 },
    tenantId: 't1',
    accountId: 'a1',
  };
}

function fakeRevisions(): { store: ConnectorRevisionStore; created: string[] } {
  const created: string[] = [];
  const store: ConnectorRevisionStore = {
    async get(_connectorId, scope) {
      return scope?.tenantId === 't1' || scope === undefined ? boundRow() : undefined;
    },
    async createPending(_connectorId, source) {
      created.push(source.path);
      return {
        revision: 3,
        adapter: 'mock-openai',
        state: 'PENDING',
        credentialSource: { ...source, version: 3 },
        tenantId: 't1',
        accountId: 'a1',
      };
    },
    async activate() {
      return true;
    },
    async retire() {
      return undefined;
    },
  };
  return { store, created };
}

function vaultFetch(calls: { url: string; body?: unknown }[]) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ data: { version: 3 } }), { status: 200 }) as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('CREDWORKFLOW-IMPL compose policy', () => {
  it('all env absent → undefined; any env set → requested', () => {
    expect(credentialWorkflowEnvRequested({})).toBe(false);
    expect(composeCredentialWorkflow({ env: {}, revisions: fakeRevisions().store })).toBeUndefined();
    expect(credentialWorkflowEnvRequested({ [VAULT_KV_TOKEN_ENV]: 't' })).toBe(true);
  });

  it('partial env refuses boot with a typed error (never silent 503)', () => {
    const { store } = fakeRevisions();
    expect(() => composeCredentialWorkflow({ env: { [VAULT_KV_OPTIONS_ENV]: OPTIONS }, revisions: store })).toThrow(
      CredentialWorkflowBootError,
    );
    expect(() => composeCredentialWorkflow({ env: { [VAULT_KV_TOKEN_ENV]: 't' }, revisions: store })).toThrow(
      CredentialWorkflowBootError,
    );
    expect(() =>
      composeCredentialWorkflow({ env: { [VAULT_KV_OPTIONS_ENV]: '{bad json', [VAULT_KV_TOKEN_ENV]: 't' }, revisions: store }),
    ).toThrow(CredentialWorkflowBootError);
    expect(() =>
      composeCredentialWorkflow({
        env: {
          [VAULT_KV_OPTIONS_ENV]: JSON.stringify({ vaultAddress: 'not-a-url' }),
          [VAULT_KV_TOKEN_ENV]: 't',
        },
        revisions: store,
      }),
    ).toThrow(CredentialWorkflowBootError);
  });

  it('complete env → a working workflow: rotate writes Vault (CAS), pins revision, activates', async () => {
    const { store, created } = fakeRevisions();
    const calls: { url: string; body?: unknown }[] = [];
    const workflow = composeCredentialWorkflow({
      env: {
        [VAULT_KV_OPTIONS_ENV]: OPTIONS,
        [VAULT_KV_TOKEN_ENV]: 'writer-token',
        DU_CONNECTOR_INITIAL_BINDINGS: JSON.stringify({ c1: { tenantId: 't1', accountId: 'a1' } }),
      },
      revisions: store,
      fetchImpl: vaultFetch(calls),
    });
    expect(workflow).toBeDefined();

    const result = await workflow!.rotate({
      connectorId: 'c1',
      ref: { account: 'a1', mount: 'secret', path: CANONICAL_PATH, key: 'api_key' },
      value: SENTINEL,
    });
    expect(result).toMatchObject({ connectorId: 'c1', revision: 3, version: 3, state: 'ACTIVE' });
    expect(created).toEqual([CANONICAL_PATH]);
    // Positive control: the secret really was written to Vault (the one place it may exist)…
    const vaultBody = JSON.stringify(calls[0]!.body);
    expect(vaultBody).toContain(SENTINEL);
    // …and it never appears in the workflow's returned result.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('Vault down → rotate rejects with the mapped 503 family and creates NO revision', async () => {
    const { store, created } = fakeRevisions();
    const deadFetch = (async () => {
      throw new Error('vault down');
    }) as unknown as typeof fetch;
    const workflow = composeCredentialWorkflow({
      env: {
        [VAULT_KV_OPTIONS_ENV]: OPTIONS,
        [VAULT_KV_TOKEN_ENV]: 'writer-token',
        DU_CONNECTOR_INITIAL_BINDINGS: JSON.stringify({ c1: { tenantId: 't1', accountId: 'a1' } }),
      },
      revisions: store,
      fetchImpl: deadFetch,
    });
    await expect(
      workflow!.rotate({
        connectorId: 'c1',
        ref: { account: 'a1', mount: 'secret', path: CANONICAL_PATH, key: 'api_key' },
        value: SENTINEL,
      }),
    ).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(created).toEqual([]);
  });
});

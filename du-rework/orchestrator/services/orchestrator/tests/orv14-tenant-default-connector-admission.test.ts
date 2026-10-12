import { resolveAdmittedConnectorBindings } from '../src/modules/operations/submission';
import type { TenantDefaultsSnapshot } from '@du/contracts';
import type { EffectiveProfile } from '../src/modules/profiles/profiles';
import type { ConnectorManagementStore } from '../src/modules/connectors/connector-management-store';

const tenantId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const tenantDefaults: TenantDefaultsSnapshot = {
  aiRevision: 4,
  promptRevision: null,
  settingsDigest: `sha256:${'b'.repeat(64)}`,
  ai: {
    provider: 'openai-compatible',
    model: 'tenant-model',
    connectorId: 'tenant-openai',
    connectorRevision: 8,
  },
  prompts: { image: null, pdf: null, docx: null, compare: null, generate: null },
};

function revision(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    connectorId: 'tenant-openai',
    revision: 8,
    state: 'ACTIVE',
    recipe: { adapter: 'openai-compatible' },
    credentialRef: null,
    credentialVersion: null,
    expectedHeadRevision: 8,
    ...overrides,
  };
}

function managementWith(value: unknown) {
  const getRecipeRevision = jest.fn(async () => value as never);
  return { getRecipeRevision, management: { getRecipeRevision } as unknown as ConnectorManagementStore };
}

describe('tenant-default Connector admission', () => {
  it('pins the exact tenant-owned active provider revision into each missing chat slot', async () => {
    const { getRecipeRevision, management } = managementWith(revision());
    const result = await resolveAdmittedConnectorBindings(
      tenantId,
      { mode: 'legacy' },
      [
        { name: 'reasoning', acceptedCapabilities: ['chat-completion', 'structured-output'] },
        { name: 'ocr', acceptedCapabilities: ['ocr', 'pdf-text'] },
      ],
      tenantDefaults,
      management,
    );

    expect(result).toEqual({ reasoning: { connectorId: 'tenant-openai', revision: 8 } });
    expect(getRecipeRevision).toHaveBeenCalledWith({ tenantId, connectorId: 'tenant-openai', revision: 8 });
  });

  it('preserves an explicit Profile binding and does not resolve the tenant Connector', async () => {
    const { getRecipeRevision, management } = managementWith(revision());
    const profile = {
      mode: 'pinned',
      bindings: { reasoning: { connectorId: 'profile-openai', revision: 2 } },
    } as unknown as EffectiveProfile;

    const result = await resolveAdmittedConnectorBindings(
      tenantId,
      profile,
      [{ name: 'reasoning', acceptedCapabilities: ['chat-completion'] }],
      tenantDefaults,
      management,
    );

    expect(result).toEqual({ reasoning: { connectorId: 'profile-openai', revision: 2 } });
    expect(getRecipeRevision).not.toHaveBeenCalled();
  });

  it('fails closed for a foreign, stale, pending, or provider-mismatched fallback revision', async () => {
    for (const candidate of [
      revision({ tenantId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
      revision({ revision: 7 }),
      revision({ state: 'PENDING' }),
      revision({ recipe: { adapter: 'gemini' } }),
    ]) {
      const { management } = managementWith(candidate);
      await expect(resolveAdmittedConnectorBindings(
        tenantId,
        { mode: 'legacy' },
        [{ name: 'reasoning', acceptedCapabilities: ['chat-completion'] }],
        tenantDefaults,
        management,
      )).rejects.toMatchObject({ code: 'CONNECTOR_REVISION_CHANGED' });
    }
  });
});

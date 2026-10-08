import type { BusinessManifest } from '@du/contracts';
import type { Db } from '../src/db/db';
import type { MetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import { createSubmissionService } from '../src/modules/operations/submission';
import { lcCheckerManifest } from '../../../../businesses/lc-checker/src/manifest';
import { documentCoreManifest } from '../../../../businesses/document-core/src/manifest/document-core.manifest';

const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const PIN = {
  tenantId: TENANT,
  slug: 'invoice-flow',
  revision: 1,
  digest: `sha256:${'a'.repeat(64)}`,
  schema: {
    slug: 'invoice-flow',
    name: 'Invoice flow',
    nodes: [{ id: 'ocr', type: 'connector', connector: 'ocr-service' }],
    flow: ['ocr'],
  },
  connectorSlotMap: { 'ocr-service': 'legacy-connector-00' },
} as const;

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    variables: { type: 'object' },
    artifactIds: { type: 'array', items: { type: 'string' } },
    fileNames: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'object' } },
  },
  required: ['variables', 'artifactIds', 'fileNames', 'artifacts'],
  additionalProperties: false,
};

function makeService(
  bindings: Record<string, { connectorId: string; revision: number }>,
  options: { businessId?: string; manifest?: BusinessManifest; effectiveInput?: Record<string, unknown> } = {},
) {
  const manifest = options.manifest ?? ({
    actions: [{ name: 'schema-workflow', inputSchema: ACTION_SCHEMA }],
  } as unknown as BusinessManifest);
  const query = jest.fn(async () => ({
    rowCount: 1,
    rows: [{ version: manifest.version ?? '1.0.0', manifest, digest: 'manifest-digest', queue: 'q-document-core' }],
  }));
  const db = { query } as unknown as Db;
  const profile = {
    mode: 'pinned',
    profileId: 'profile-1',
    revision: 7,
    bindings,
    profileName: 'workflow profile',
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '.pdf',
      connectionsOverride: [],
      fileUrlAuthConfig: null,
      callbackPolicy: null,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: options.effectiveInput ?? {
      variables: { account: 'A' },
      artifactIds: [],
      fileNames: [],
      artifacts: [],
    },
    bullMqPriority: 10,
  };
  const profiles = {
    resolveEffectiveProfile: jest.fn(async () => profile),
  } as unknown as ProfileService;
  const metadataCrypto = {
    seal: jest.fn(),
    open: jest.fn(),
    isSealed: jest.fn(),
    readStored: jest.fn(),
  } as unknown as MetadataCrypto;
  const service = createSubmissionService(
    db,
    {} as RegistryService,
    profiles,
    { metadataCrypto },
  );
  return { service, query, profiles, businessId: options.businessId ?? 'document-core' };
}

const preflightInput = {
  tenantId: TENANT,
  apiKeyId: KEY,
  businessId: 'document-core',
  action: 'schema-workflow',
  input: { variables: { account: 'A' }, artifactIds: [], fileNames: [], artifacts: [] },
  fileNames: ['invoice.pdf'],
  workflowSchemaPin: PIN,
};

describe('WFA API admission preflight', () => {
  it('requires configured metadata encryption before any workflow request can be admitted', async () => {
    const query = jest.fn();
    const service = createSubmissionService(
      { query } as unknown as Db,
      {} as RegistryService,
      { resolveEffectiveProfile: jest.fn() } as unknown as ProfileService,
    );

    await expect(service.preflightLegacyWorkflow(preflightInput)).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_UNAVAILABLE',
    });
    await expect(service.submit({
      tenantId: TENANT,
      apiKeyId: KEY,
      businessId: 'document-core',
      action: 'schema-workflow',
      submission: {},
      legacyProjection: {
        endpointSlug: 'workflows:schema:invoice-flow',
        pipelineJson: [],
        progressMessage: 'Initializing schema workflow...',
      },
    })).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('requires every immutable schema slot to be pinned by the authorized profile', async () => {
    const unbound = makeService({});
    await expect(unbound.service.preflightLegacyWorkflow(preflightInput)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });

    const bound = makeService({ 'legacy-connector-00': { connectorId: 'connector-ocr', revision: 4 } });
    await expect(bound.service.preflightLegacyWorkflow(preflightInput)).resolves.toBeUndefined();
    expect(bound.profiles.resolveEffectiveProfile).toHaveBeenCalledWith(
      KEY,
      'document-core',
      '1.0.0',
      'schema-workflow',
      preflightInput.input,
      ['variables', 'artifactIds', 'fileNames', 'artifacts'],
    );
  });

  it('applies the pinned profile file extension rule before public artifact creation', async () => {
    const { service } = makeService({ 'legacy-connector-00': { connectorId: 'connector-ocr', revision: 4 } });
    await expect(service.preflightLegacyWorkflow({ ...preflightInput, fileNames: ['payload.exe'] }))
      .rejects.toMatchObject({ status: 422, code: 'PROFILE_EXTENSION_DENIED' });
  });

  it('requires all legacy LC processor stages to be explicitly pinned before uploads', async () => {
    const input = {
      variables: {},
      artifactIds: ['artifact-1'],
      fileNames: ['invoice.pdf'],
      artifacts: [{ artifactId: 'artifact-1', role: 'file' }],
      legacyWorkflow: { version: 'legacy-workflow-named-input-v1', process: 'lc-checker' },
    };
    const manifest = lcCheckerManifest as unknown as BusinessManifest;
    const context = {
      ...preflightInput,
      businessId: 'lc-checker',
      action: 'lc-checker',
      input,
      workflowSchemaPin: undefined,
    };

    const missing = makeService({}, { businessId: 'lc-checker', manifest, effectiveInput: input });
    await expect(missing.service.preflightLegacyWorkflow(context)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });

    const complete = makeService({
      'legacy-ocr': { connectorId: 'ocr-provider', revision: 4 },
      'legacy-compliance': { connectorId: 'compliance-provider', revision: 7 },
      'legacy-report': { connectorId: 'report-provider', revision: 2 },
    }, { businessId: 'lc-checker', manifest, effectiveInput: input });
    await expect(complete.service.preflightLegacyWorkflow(context)).resolves.toBeUndefined();
    const resolverArgs = (complete.profiles.resolveEffectiveProfile as jest.Mock).mock.calls[0];
    expect(resolverArgs?.[1]).toBe('lc-checker');
    expect(resolverArgs?.[2]).toBe('1.1.0');
    expect(resolverArgs?.[4]).toEqual(input);
    expect(resolverArgs?.[5]).not.toContain('legacyWorkflow');
  });

  it('requires all four doc-compare legacy stages before admitting even a one-file async request', async () => {
    const input = {
      variables: {},
      artifactIds: [],
      fileNames: [],
      artifacts: [],
      legacyWorkflow: { version: 'legacy-workflow-named-input-v1', process: 'doc-compare' },
    };
    const manifest = documentCoreManifest as unknown as BusinessManifest;
    const context = {
      ...preflightInput,
      action: 'doc-compare',
      input,
      fileNames: ['only.pdf'],
      workflowSchemaPin: undefined,
    };

    const missing = makeService({}, { manifest, effectiveInput: input });
    await expect(missing.service.preflightLegacyWorkflow(context)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });

    const complete = makeService({
      'legacy-ocr': { connectorId: 'ocr-provider', revision: 4 },
      'legacy-toc': { connectorId: 'toc-provider', revision: 5 },
      'legacy-compare': { connectorId: 'compare-provider', revision: 8 },
      'legacy-report': { connectorId: 'report-provider', revision: 2 },
    }, { manifest, effectiveInput: input });
    await expect(complete.service.preflightLegacyWorkflow(context)).resolves.toBeUndefined();
  });
});

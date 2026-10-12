import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildProfileGroupSaveBody,
  isProfileGroupRevisionConflict,
  parseProfileGroup,
  parseProfileGroupFunctionCatalog,
  profileGroupDraftFromRead,
  profileGroupFunctionDraftKey,
  profileGroupMemberDraftKey,
  validateProfileGroupDraft,
} from '../src/features/profiles/profile-group-state.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const apiKeyId = '33333333-3333-4333-8333-333333333333';
const policy = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: 'pdf',
  fileUrlAuthConfigured: true,
  allowedOrigins: ['https://files.example'],
  connectionsOverride: [],
};

function functionBinding({ functionId, kind, action, endpointSlug, manifestDigest, childProfileId, connectorId }) {
  return {
    kind,
    functionId,
    action,
    ...(endpointSlug ? { endpointSlug } : {}),
    manifestDigest,
    childProfileId,
    childRevision: 3,
    enabled: true,
    policy,
    connectorBindings: { reasoning: { connectorId, revision: 2 } },
  };
}

const groupWire = {
  groupId,
  name: 'Business A intake',
  tenantId,
  revision: 4,
  apiKey: { apiKeyId, prefix: 'du_test', status: 'ACTIVE' },
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.4.0',
      manifestDigest: 'core-digest-v1',
      functions: [functionBinding({
        functionId: 'core:extract:invoice', kind: 'endpoint', action: 'extract', endpointSlug: 'extract.invoice',
        manifestDigest: 'core-digest-v1', childProfileId: '44444444-4444-4444-8444-444444444444', connectorId: 'core-connector',
      })],
    },
    {
      businessId: 'claims-workflow',
      businessVersion: '2.0.1',
      manifestDigest: 'claims-digest-v2',
      functions: [functionBinding({
        functionId: 'claims:action:review', kind: 'workflow', action: 'review-claim',
        manifestDigest: 'claims-digest-v2', childProfileId: '55555555-5555-4555-8555-555555555555', connectorId: 'claims-connector',
      })],
    },
  ],
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-11T08:00:00.000Z',
};

function catalog({ businessId, businessVersion, manifestDigest, functionId, kind, action, endpointSlug, available = true }) {
  return {
    businessId,
    businessVersion,
    manifestDigest,
    businessEnabled: true,
    functions: [{
      kind,
      functionId,
      action,
      ...(endpointSlug ? { endpointSlug } : {}),
      manifestDigest,
      inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      profileSchema: {
        type: 'object',
        properties: {
          temperature: { type: 'number', minimum: 0, maximum: 1, default: 0.2 },
          options: { type: 'object', default: {} },
        },
        required: ['temperature'],
      },
      available,
      ...(!available ? { unavailableReason: 'Runtime facade does not accept this declared endpoint.' } : {}),
      connectorSlots: [{ name: 'reasoning', required: true, acceptedCapabilities: ['reasoning'] }],
    }],
  };
}

function loadCatalogs(draft, catalogs) {
  return {
    ...draft,
    members: draft.members.map((member) => ({
      ...member,
      enabled: true,
      catalog: parseProfileGroupFunctionCatalog(catalogs.find((item) => item.businessId === member.businessId && item.businessVersion === member.businessVersion)),
    })),
  };
}

describe('profile group draft state', () => {
  it('uses selected manifest defaults for required settings and persists the displayed defaults', () => {
    const group = parseProfileGroup(groupWire);
    assert.ok(group);
    const draft = loadCatalogs(profileGroupDraftFromRead(group), [
      catalog({ businessId: 'document-core', businessVersion: '1.4.0', manifestDigest: 'core-digest-v1', functionId: 'core:extract:invoice', kind: 'endpoint', action: 'extract', endpointSlug: 'extract.invoice' }),
      catalog({ businessId: 'claims-workflow', businessVersion: '2.0.1', manifestDigest: 'claims-digest-v2', functionId: 'claims:action:review', kind: 'workflow', action: 'review-claim' }),
    ]);

    assert.deepEqual(validateProfileGroupDraft(draft), []);
    const body = buildProfileGroupSaveBody(draft, tenantId);
    assert.deepEqual(body.businesses[0].functions[0].policy.parameters, {
      temperature: { value: 0.2 },
      options: { value: {} },
    });
    assert.deepEqual(body.businesses[1].functions[0].policy.parameters, {
      temperature: { value: 0.2 },
      options: { value: {} },
    });
  });

  it('keeps function configuration isolated by business and version and serializes one complete multi-business save', () => {
    const group = parseProfileGroup(groupWire);
    assert.ok(group, 'read DTO must match the group contract');
    const initial = profileGroupDraftFromRead(group);
    const draft = loadCatalogs(initial, [
      catalog({ businessId: 'document-core', businessVersion: '1.4.0', manifestDigest: 'core-digest-v1', functionId: 'core:extract:invoice', kind: 'endpoint', action: 'extract', endpointSlug: 'extract.invoice' }),
      catalog({ businessId: 'claims-workflow', businessVersion: '2.0.1', manifestDigest: 'claims-digest-v2', functionId: 'claims:action:review', kind: 'workflow', action: 'review-claim' }),
    ]);
    const coreKey = profileGroupFunctionDraftKey('document-core', '1.4.0', 'core:extract:invoice');
    const claimsKey = profileGroupFunctionDraftKey('claims-workflow', '2.0.1', 'claims:action:review');
    assert.notEqual(coreKey, claimsKey);
    draft.functionDrafts[coreKey].parameters.temperature = { value: 0.25, isLocked: false };
    draft.functionDrafts[claimsKey].parameters.temperature = { value: 0.8, isLocked: true };

    assert.deepEqual(validateProfileGroupDraft(draft), []);
    const body = buildProfileGroupSaveBody(draft, tenantId);
    assert.equal(body.expectedRevision, 4);
    assert.equal(body.businesses.length, 2);
    assert.deepEqual(body.businesses.map(({ businessId, businessVersion, manifestDigest }) => [businessId, businessVersion, manifestDigest]), [
      ['document-core', '1.4.0', 'core-digest-v1'],
      ['claims-workflow', '2.0.1', 'claims-digest-v2'],
    ]);
    assert.equal(body.businesses[0].functions[0].kind, 'endpoint');
    assert.equal(body.businesses[0].functions[0].endpointSlug, 'extract.invoice');
    assert.equal(body.businesses[0].functions[0].policy.parameters.temperature.value, 0.25);
    assert.equal(body.businesses[1].functions[0].kind, 'workflow');
    assert.equal(body.businesses[1].functions[0].action, 'review-claim');
    assert.equal(body.businesses[1].functions[0].policy.parameters.temperature.value, 0.8);
    assert.deepEqual(body.businesses[0].functions[0].connectorBindings, { reasoning: { connectorId: 'core-connector', revision: 2 } });
    assert.deepEqual(body.businesses[1].functions[0].connectorBindings, { reasoning: { connectorId: 'claims-connector', revision: 2 } });
    assert.deepEqual(body.businesses[0].functions[0].policy.allowedOrigins, ['https://files.example']);
    assert.equal('fileUrlAuthConfig' in body.businesses[0].functions[0].policy, false, 'the UI never reads or writes provider credentials');
  });

  it('hydrates a full group read for reload and preserves independent member versions and bindings', () => {
    const group = parseProfileGroup(groupWire);
    assert.ok(group);
    const draft = profileGroupDraftFromRead(group);
    assert.deepEqual(draft.members.map(({ businessId, businessVersion }) => [businessId, businessVersion]), [
      ['document-core', '1.4.0'], ['claims-workflow', '2.0.1'],
    ]);
    assert.deepEqual(draft.selectedFunctionsByVersion[profileGroupMemberDraftKey('document-core', '1.4.0')], ['core:extract:invoice']);
    assert.deepEqual(draft.selectedFunctionsByVersion[profileGroupMemberDraftKey('claims-workflow', '2.0.1')], ['claims:action:review']);
    assert.equal(draft.functionDrafts[profileGroupFunctionDraftKey('claims-workflow', '2.0.1', 'claims:action:review')].connectorBindings.reasoning.connectorId, 'claims-connector');
  });

  it('blocks save when a business was disabled while open or a function is unavailable in its selected manifest', () => {
    const group = parseProfileGroup(groupWire);
    assert.ok(group);
    const base = profileGroupDraftFromRead(group);
    const catalogs = [
      catalog({ businessId: 'document-core', businessVersion: '1.4.0', manifestDigest: 'core-digest-v1', functionId: 'core:extract:invoice', kind: 'endpoint', action: 'extract', endpointSlug: 'extract.invoice' }),
      catalog({ businessId: 'claims-workflow', businessVersion: '2.0.1', manifestDigest: 'claims-digest-v2', functionId: 'claims:action:review', kind: 'workflow', action: 'review-claim' }),
    ];
    const disabled = loadCatalogs(base, catalogs);
    disabled.members[0].enabled = false;
    assert.ok(validateProfileGroupDraft(disabled).some((message) => message.includes('not currently enabled')));

    const unavailable = loadCatalogs(base, catalogs.map((item) => item.businessId === 'document-core'
      ? catalog({ businessId: item.businessId, businessVersion: item.businessVersion, manifestDigest: item.manifestDigest, functionId: 'core:extract:invoice', kind: 'endpoint', action: 'extract', endpointSlug: 'extract.invoice', available: false })
      : item));
    assert.ok(validateProfileGroupDraft(unavailable).some((message) => message.includes('unavailable')));
    assert.throws(() => buildProfileGroupSaveBody(unavailable, tenantId), /unavailable/);
  });

  it('uses revision conflicts to stop edits until the complete server group is reloaded', () => {
    assert.equal(isProfileGroupRevisionConflict(409, 'REVISION_CONFLICT'), true);
    assert.equal(isProfileGroupRevisionConflict(409, 'STATE_CONFLICT'), false);
    assert.equal(isProfileGroupRevisionConflict(422, 'INVALID_SCHEMA'), false);
  });
});

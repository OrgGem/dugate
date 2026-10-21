/**
 * PC-01 — profile-group control plane V2 contracts.
 *
 * 36 contract cases from the PREP-PC-01 design (report
 * coordination/reports/prep-pc01-contracts-spec.md, Appendix A). Everything
 * is imported from the package barrel so this file also proves the public export
 * surface in src/index.ts.
 *
 * These are pure contract cases: no HTTP, no DB, no CAS. Behaviour lives in
 * PC-03/PC-04/PC-05 and their PG/HTTP suites.
 */
import assert from 'node:assert/strict';
import {
  AdminWorkbenchProfilePreviewV2RequestSchema,
  AdminWorkbenchProfilePreviewV2ResponseSchema,
  AdminWorkbenchProfileSubmitV2RequestSchema,
  ParameterResolutionCapabilitySchema,
  ParameterResolutionSchema,
  ParameterSourceSchema,
  ProfileGroupAuthAuthoritySchema,
  ProfileGroupFunctionSchema,
  ProfileGroupKeyGrantSchema,
  ProfileGroupKeyIssueInputSchema,
  ProfileGroupKeyIssueResultSchema,
  ProfileGroupKeyRevokeInputSchema,
  ProfileGroupPreviewV2RequestSchema,
  ProfileGroupPreviewV2ResponseSchema,
  ProfileGroupRequestDefaultsSchema,
  ProfileGroupRevokedKeyGrantSchema,
  ProfileGroupRollbackSchema,
  ProfileGroupSaveSchema,
  ProfileGroupSubmitV2RequestSchema,
  ProfileGroupV2FunctionInputSchema,
  ProfileGroupV2RollbackSchema,
  ProfileGroupV2SaveSchema,
  ProfileGroupV2Schema,
  ResolutionFingerprintSchema,
  canonicalRequestHash,
  computeResolutionFingerprint,
  validateManifest,
  type BusinessManifest,
  type ResolutionFingerprintPartsV2,
} from '../src';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;
const DIGEST_A = sha('a');
const DIGEST_B = sha('b');

const test = (name: string, fn: () => void): void => {
  it(name, fn);
};

interface ParseLike {
  success: boolean;
  error?: { issues: readonly { code: string; path: readonly PropertyKey[] }[] };
}

const paths = (result: ParseLike): string[] =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('.'));
const codes = (result: ParseLike): string[] =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.code);

/* ---------------------------- fixtures ---------------------------- */

const v1GroupSave = {
  name: 'Acme invoices',
  tenantId: uuid(1),
  apiKey: { apiKeyId: uuid(2) },
  expectedRevision: 0,
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      functions: [
        {
          kind: 'endpoint' as const,
          functionId: 'extract.invoice',
          action: 'extract',
          endpointSlug: 'extract.invoice',
          policy: { enabled: true },
        },
      ],
    },
  ],
};

const v2Function = {
  kind: 'endpoint' as const,
  functionId: 'extract.invoice',
  action: 'extract',
  endpointSlug: 'extract.invoice',
  policy: { enabled: true, parameters: { maxPages: { value: 10, isLocked: true } } },
  requestDefaults: { documentType: { value: 'invoice' } },
  connectorBindings: { reasoning: { connectorId: 'acme-llm', revision: 7 } },
};

const v2GroupSave = {
  name: 'Acme invoices',
  tenantId: uuid(1),
  authMode: 'API_KEY' as const,
  expectedRevision: 0,
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      functions: [v2Function],
    },
  ],
};

const policyRead = {
  enabled: true,
  parameters: { maxPages: { value: 10, isLocked: true } },
  jobPriority: 'MEDIUM' as const,
  allowedFileExtensions: '',
  fileUrlAuthConfigured: false,
  allowedOrigins: [] as string[],
  connectionsOverride: [] as { slug: string }[],
};

const v2GroupRead = {
  groupId: uuid(3),
  tenantId: uuid(1),
  name: 'Acme invoices',
  authMode: 'API_KEY' as const,
  authAuthority: 'GROUP_GRANT' as const,
  revision: 4,
  accessVersion: 7,
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      functions: [
        {
          kind: 'endpoint' as const,
          functionId: 'extract.invoice',
          action: 'extract',
          endpointSlug: 'extract.invoice',
          manifestDigest: DIGEST_A,
          childProfileId: uuid(4),
          childRevision: 2,
          enabled: true,
          policy: policyRead,
          requestDefaults: { documentType: { value: 'invoice' } },
          connectorBindings: { reasoning: { connectorId: 'acme-llm', revision: 7 } },
        },
      ],
    },
  ],
  apiKeyGrants: [] as unknown[],
  createdAt: '2026-10-21T01:00:00+07:00',
  updatedAt: '2026-10-21T01:00:00+07:00',
};

const submission = { input: { documentType: 'invoice', language: 'vi' } };

const fingerprintParts: ResolutionFingerprintPartsV2 = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  apiKeyId: '22222222-2222-4222-8222-222222222222',
  groupId: '33333333-3333-4333-8333-333333333333',
  groupRevision: 4,
  accessVersion: 7,
  function: {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    manifestDigest: DIGEST_A,
    kind: 'endpoint',
    functionId: 'extract.invoice',
    action: 'extract',
    endpointSlug: 'extract.invoice',
  },
  children: [
    {
      functionId: 'extract.invoice',
      childProfileId: '44444444-4444-4444-8444-444444444444',
      childRevision: 2,
    },
  ],
  tenantDefaultsRevision: null,
  connectorBindings: [{ slot: 'reasoning', connectorId: 'acme-llm', revision: 7 }],
  workflow: null,
  submission,
};

const exampleManifest: BusinessManifest = {
  contractVersion: '1',
  businessId: 'example-review',
  version: '1.0.0',
  displayName: 'Example Review',
  description: 'Example business for contract tests',
  imageDigest: `sha256:${'0'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root', 'review-item'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'review',
      displayName: 'Review documents',
      description: 'Review a document',
      inputSchema: {
        type: 'object',
        properties: { requireApproval: { type: 'boolean' } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [],
      artifactPolicy: { minFiles: 1, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 2 },
    },
  ],
} as BusinessManifest;

/* ------------------------- A. v1 freeze -------------------------- */

test('A1 v1 save still requires the singular apiKey', () => {
  assert.equal(ProfileGroupSaveSchema.safeParse(v1GroupSave).success, true);
  const { apiKey: _apiKey, ...withoutKey } = v1GroupSave;
  const parsed = ProfileGroupSaveSchema.safeParse(withoutKey);
  assert.equal(parsed.success, false);
  assert.ok(paths(parsed).includes('apiKey'));
});

test('A2 v1 read DTO still requires apiKey metadata', () => {
  const v1Read = {
    groupId: uuid(3),
    name: 'Acme invoices',
    tenantId: uuid(1),
    revision: 4,
    apiKey: { apiKeyId: uuid(2), prefix: 'du_live_abc', status: 'ACTIVE' },
    businesses: [],
    createdAt: '2026-10-21T01:00:00+07:00',
    updatedAt: '2026-10-21T01:00:00+07:00',
  };
  const parsed = ProfileGroupV2Schema.safeParse(v1Read);
  assert.equal(parsed.success, false, 'v1 read shape must not satisfy the v2 DTO');
});

/* ------------------------ B. v2 save ---------------------------- */

test('B1 v2 save accepts a group body with no key selector at all', () => {
  const parsed = ProfileGroupV2SaveSchema.safeParse(v2GroupSave);
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.data, 'apiKey'), false);
  assert.deepEqual(parsed.data.businesses[0]?.functions[0]?.requestDefaults, {
    documentType: { value: 'invoice' },
  });
});

test('B2 v2 save rejects a lingering singular apiKey', () => {
  const parsed = ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, apiKey: { apiKeyId: uuid(2) } });
  assert.equal(parsed.success, false);
  assert.ok(codes(parsed).includes('unrecognized_keys'));
});

test('B3 authMode is an explicit required literal', () => {
  const { authMode: _authMode, ...withoutMode } = v2GroupSave;
  assert.equal(ProfileGroupV2SaveSchema.safeParse(withoutMode).success, false);
  assert.equal(
    ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, authMode: 'LEGACY' }).success,
    false,
  );
});

test('B4 create uses expectedRevision 0 and update keeps the same body', () => {
  assert.equal(ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, expectedRevision: 0 }).success, true);
  assert.equal(ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, expectedRevision: 4 }).success, true);
});

test('B5 requestDefaults defaults to {} when omitted', () => {
  const { requestDefaults: _defaults, ...fn } = v2Function;
  const parsed = ProfileGroupV2SaveSchema.safeParse({
    ...v2GroupSave,
    businesses: [
      { ...v2GroupSave.businesses[0], functions: [fn] },
    ],
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.businesses[0]?.functions[0]?.requestDefaults, {});
});

/* ------------------- C. function selector rules ------------------ */

const fnBase: Record<string, unknown> = {
  kind: 'endpoint',
  functionId: 'extract.invoice',
  action: 'extract',
  endpointSlug: 'extract.invoice',
  policy: { enabled: true },
};

const fnCase = (fn: Record<string, unknown>) =>
  ProfileGroupV2FunctionInputSchema.safeParse({ ...fnBase, ...fn });

test('C1 endpoint without endpointSlug is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'endpoint', endpointSlug: undefined })).includes('endpointSlug'));
});

test('C2 endpoint carrying workflowRevision is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'endpoint', workflowRevision: 3 })).includes('workflowRevision'));
});

test('C3 workflow without workflowRevision is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'workflow', endpointSlug: undefined })).includes('workflowRevision'));
});

test('C4 workflow carrying endpointSlug is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'workflow', endpointSlug: 'x', workflowRevision: 3 })).includes('endpointSlug'));
});

test('C5 workflow with workflowRevision is accepted', () => {
  const parsed = fnCase({ kind: 'workflow', endpointSlug: undefined, workflowRevision: 3 });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

/* ---------------------- D. requestDefaults ---------------------- */

test('D1 credential-shaped requestDefaults keys are refused', () => {
  assert.ok(paths(ProfileGroupRequestDefaultsSchema.safeParse({ openaiToken: { value: 'x' } })).includes('openaiToken'));
  assert.ok(paths(ProfileGroupRequestDefaultsSchema.safeParse({ apiKey: { value: 'x' } })).includes('apiKey'));
});

test('D2 non-credential lookalike names stay usable', () => {
  const parsed = ProfileGroupRequestDefaultsSchema.safeParse({
    maxTokens: { value: 512 },
    passwordPolicy: { value: 'strict' },
    tokenizer: { value: 'bpe' },
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

test('D3 profileSettings keeps v1 parity (credentials refused only at the snapshot)', () => {
  const parsed = fnCase({ policy: { enabled: true, parameters: { apiKey: { value: 'x' } } } });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

/* -------------------------- E. grants --------------------------- */

test('E1 zero active grants is a valid readable/editable profile', () => {
  const parsed = ProfileGroupV2Schema.safeParse(v2GroupRead);
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.apiKeyGrants, []);
  assert.equal(parsed.data.authAuthority, 'GROUP_GRANT');
  assert.equal(parsed.data.accessVersion, 7);
});

test('E2 grant rows carry safe metadata only', () => {
  const grant = {
    apiKeyId: uuid(2),
    prefix: 'du_live_abc',
    status: 'ACTIVE',
    grantedAt: '2026-10-21T01:00:00+07:00',
    grantedBy: 'admin',
  };
  assert.equal(ProfileGroupKeyGrantSchema.safeParse(grant).success, true);
  assert.equal(
    ProfileGroupKeyGrantSchema.safeParse({ ...grant, secret: 'du_live_raw' }).success,
    false,
    'a raw secret must not be representable in the grant DTO',
  );
});

test('E3 revoke keeps a tombstone with revokedAt', () => {
  const tombstone = {
    apiKeyId: uuid(2),
    prefix: 'du_live_abc',
    status: 'ACTIVE',
    grantedAt: '2026-10-21T01:00:00+07:00',
  };
  assert.equal(ProfileGroupRevokedKeyGrantSchema.safeParse(tombstone).success, false);
  assert.equal(
    ProfileGroupRevokedKeyGrantSchema.safeParse({ ...tombstone, revokedAt: '2026-10-21T02:00:00+07:00' }).success,
    true,
  );
});

test('E4 issue/revoke bodies validate', () => {
  assert.equal(ProfileGroupKeyIssueInputSchema.safeParse({}).success, true);
  assert.equal(ProfileGroupKeyIssueInputSchema.safeParse({ note: 'a'.repeat(201) }).success, false);
  assert.equal(ProfileGroupKeyRevokeInputSchema.safeParse({ expectedAccessVersion: 7 }).success, true);
  assert.equal(ProfileGroupKeyRevokeInputSchema.safeParse({ expectedAccessVersion: 0 }).success, false);
  assert.equal(
    ProfileGroupKeyRevokeInputSchema.safeParse({ expectedAccessVersion: 7, revokeKey: true }).success,
    false,
  );
  assert.equal(
    ProfileGroupKeyIssueResultSchema.safeParse({
      grant: {
        apiKeyId: uuid(2),
        prefix: 'du_live_abc',
        status: 'ACTIVE',
        grantedAt: '2026-10-21T01:00:00+07:00',
      },
      secret: 'du_live_' + 'x'.repeat(32),
      secretAvailable: true,
    }).success,
    true,
  );
});

test('E5 v2 rollback shares the v1 body and accepts no access version', () => {
  assert.equal(ProfileGroupV2RollbackSchema.safeParse({ expectedRevision: 4, targetRevision: 2 }).success, true);
  assert.equal(
    ProfileGroupV2RollbackSchema.safeParse({ expectedRevision: 4, targetRevision: 2, accessVersion: 7 }).success,
    false,
  );
  assert.equal(ProfileGroupRollbackSchema.safeParse({ expectedRevision: 4, targetRevision: 2 }).success, true);
});

/* ----------------------- F. fingerprint ------------------------- */

test('F1 golden fingerprint for the canonical fixture', () => {
  assert.equal(
    canonicalRequestHash(submission),
    'sha256:5670835bd3436b8af329dc069f5e9eb5938239e07d71f4be02bc220503f55a64',
  );
  // PC-R04 re-pinned: the payload now carries tenantDefaultsAiRevision /
  // tenantDefaultsPromptRevision / tenantDefaultsDigest and a workflow slug, so
  // the pre-R04 constant (sha256:b226e4ef…) is intentionally unreachable.
  // Computed from a hand-built payload through `canonicalize` + sha256 — not
  // from this implementation's payload builder.
  assert.equal(
    computeResolutionFingerprint(fingerprintParts),
    'sha256:38fc7569935274af990ca6808e705489e95a8427fe6cd95e7b2c996b22c44c40',
  );
});

test('F2 key order and pin order never change the fingerprint', () => {
  const base = computeResolutionFingerprint(fingerprintParts);
  const reordered = computeResolutionFingerprint({
    ...fingerprintParts,
    submission: { input: { language: 'vi', documentType: 'invoice' } },
    children: [
      { functionId: 'zzz', childProfileId: uuid(9), childRevision: 1 },
      { functionId: 'extract.invoice', childProfileId: uuid(4), childRevision: 2 },
    ],
    connectorBindings: [
      { slot: 'zzz', connectorId: 'other', revision: 1 },
      { slot: 'reasoning', connectorId: 'acme-llm', revision: 7 },
    ],
  });
  const sorted = computeResolutionFingerprint({
    ...fingerprintParts,
    submission: { input: { documentType: 'invoice', language: 'vi' } },
    children: [
      { functionId: 'extract.invoice', childProfileId: uuid(4), childRevision: 2 },
      { functionId: 'zzz', childProfileId: uuid(9), childRevision: 1 },
    ],
    connectorBindings: [
      { slot: 'reasoning', connectorId: 'acme-llm', revision: 7 },
      { slot: 'zzz', connectorId: 'other', revision: 1 },
    ],
  });
  assert.equal(reordered, sorted);
  assert.notEqual(base, reordered);
});

test('F3 every pinned ref moves the fingerprint', () => {
  const base = computeResolutionFingerprint(fingerprintParts);
  const variants = [
    computeResolutionFingerprint({ ...fingerprintParts, groupRevision: 5 }),
    computeResolutionFingerprint({ ...fingerprintParts, accessVersion: 8 }),
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsRevision: 3 }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      children: [{ functionId: 'extract.invoice', childProfileId: uuid(4), childRevision: 3 }],
    }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      function: { ...fingerprintParts.function, manifestDigest: DIGEST_B },
    }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      workflow: { revision: 3, digest: DIGEST_B },
    }),
    computeResolutionFingerprint({ ...fingerprintParts, submission: { input: { documentType: 'invoice' } } }),
  ];
  for (const variant of variants) assert.notEqual(variant, base);
  assert.equal(new Set(variants).size, variants.length);
});

test('F4 non-fingerprinted request fields are excluded', () => {
  const base = computeResolutionFingerprint(fingerprintParts);
  assert.equal(
    computeResolutionFingerprint({
      ...fingerprintParts,
      submission: { ...submission, clientReference: 'invoice-2026-10' },
    }),
    base,
  );
  assert.equal(
    computeResolutionFingerprint({ ...fingerprintParts, submission: { ...submission, output: undefined } }),
    base,
    'absent and undefined output normalize identically',
  );
  assert.equal(
    computeResolutionFingerprint({
      ...fingerprintParts,
      submission: { ...submission, output: null } as unknown as ResolutionFingerprintPartsV2['submission'],
    }),
    base,
    'canonicalRequestHash normalizes an explicit null output exactly like an absent one',
  );
  assert.notEqual(
    computeResolutionFingerprint({
      ...fingerprintParts,
      submission: { input: { documentType: null, language: 'vi' } },
    }),
    base,
    'inside input, an explicit null is a different value than an absent property',
  );
});

test('F5 fingerprint wire schema is sha256-prefixed lowercase hex', () => {
  assert.equal(ResolutionFingerprintSchema.safeParse(DIGEST_A).success, true);
  assert.equal(ResolutionFingerprintSchema.safeParse('a'.repeat(64)).success, false);
  assert.equal(ResolutionFingerprintSchema.safeParse(sha('A')).success, false);
  assert.equal(ResolutionFingerprintSchema.safeParse(`sha256:${'a'.repeat(63)}`).success, false);
});

/* -------------------- G. public v2 preview/submit --------------- */

test('G1 preview parses without any fingerprint', () => {
  const parsed = ProfileGroupPreviewV2RequestSchema.safeParse({
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission,
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

test('G2 the group is addressed by path, never by body', () => {
  const parsed = ProfileGroupPreviewV2RequestSchema.safeParse({
    groupId: uuid(3),
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission,
  });
  assert.ok(codes(parsed).includes('unrecognized_keys'));
});

test('G3 submit requires the fingerprint', () => {
  const body = {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission,
  };
  const missing = ProfileGroupSubmitV2RequestSchema.safeParse(body);
  assert.equal(missing.success, false);
  assert.ok(paths(missing).includes('resolutionFingerprint'));
  assert.equal(
    ProfileGroupSubmitV2RequestSchema.safeParse({ ...body, resolutionFingerprint: DIGEST_A }).success,
    true,
  );
});

test('G4 preview response carries refs, fingerprint and redacted effective input', () => {
  const parsed = ProfileGroupPreviewV2ResponseSchema.safeParse({
    refs: {
      groupId: uuid(3),
      groupRevision: 4,
      accessVersion: 7,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      kind: 'endpoint',
      functionId: 'extract.invoice',
      action: 'extract',
      endpointSlug: 'extract.invoice',
      childProfileId: uuid(4),
      childRevision: 2,
      tenantDefaultsRevision: null,
      connectorBindings: [{ slot: 'reasoning', connectorId: 'acme-llm', revision: 7 }],
    },
    resolutionFingerprint: DIGEST_A,
    effective: {
      parameters: { documentType: 'invoice', language: 'vi' },
      appliedRequestDefaults: ['documentType'],
      appliedSchemaDefaults: [],
      lockedParameters: [],
    },
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

/* --------------------- H. workbench v2 -------------------------- */

const workbenchSelector = {
  tenantId: uuid(1),
  apiKeyId: uuid(2),
  businessId: 'document-core',
  businessVersion: '1.0.0',
  action: 'extract',
  functionId: 'extract.invoice',
  submission,
};

test('H1 workbench requires an explicitly selected key', () => {
  const { apiKeyId: _key, ...withoutKey } = workbenchSelector;
  const parsed = AdminWorkbenchProfilePreviewV2RequestSchema.safeParse(withoutKey);
  assert.equal(parsed.success, false);
  assert.ok(paths(parsed).includes('apiKeyId'));
});

test('H2 workbench submit requires the preview fingerprint', () => {
  assert.equal(AdminWorkbenchProfilePreviewV2RequestSchema.safeParse(workbenchSelector).success, true);
  assert.equal(AdminWorkbenchProfileSubmitV2RequestSchema.safeParse(workbenchSelector).success, false);
  assert.equal(
    AdminWorkbenchProfileSubmitV2RequestSchema.safeParse({
      ...workbenchSelector,
      resolutionFingerprint: DIGEST_A,
    }).success,
    true,
  );
});

test('H3 workbench preview response echoes the selected key', () => {
  const preview = {
    refs: {
      groupId: uuid(3),
      groupRevision: 4,
      accessVersion: 7,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      kind: 'endpoint',
      functionId: 'extract.invoice',
      action: 'extract',
      childProfileId: uuid(4),
      childRevision: 2,
      tenantDefaultsRevision: null,
      connectorBindings: [],
    },
    resolutionFingerprint: DIGEST_A,
    effective: {
      parameters: {},
      appliedRequestDefaults: [],
      appliedSchemaDefaults: [],
      lockedParameters: [],
    },
  };
  assert.equal(AdminWorkbenchProfilePreviewV2ResponseSchema.safeParse(preview).success, false);
  assert.equal(
    AdminWorkbenchProfilePreviewV2ResponseSchema.safeParse({ ...preview, apiKeyId: uuid(2) }).success,
    true,
  );
});

/* ------------------ I. manifest capability ---------------------- */

/**
 * Digest of `exampleManifest()` measured BEFORE PC-01 (fresh build of the
 * unchanged src, not `dist`). It is the freeze pin for v1 manifest semantics:
 * adding an *optional* capability must not move the digest of a manifest that
 * does not declare it.
 */
const V1_MANIFEST_DIGEST =
  'sha256:eb89c23697ebf1181a3e4a0fbb3421cd6d3f1e1cf340108019e6636f8c980533';

test('I1 v1 manifest digest is unchanged by this packet (golden pin)', () => {
  const result = validateManifest(exampleManifest);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.digest, V1_MANIFEST_DIGEST);
});

test('I2 a declared capability now survives parsing and moves the digest', () => {
  const capability = {
    version: 2 as const,
    fields: { requireApproval: 'requestDefaults' as const },
    applyTopLevelDefaults: true,
  };
  const withCapability = {
    ...exampleManifest,
    actions: [{ ...exampleManifest.actions[0], parameterResolution: capability }],
  } as unknown as BusinessManifest;
  const result = validateManifest(withCapability);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // PC-01 declared the field, so the non-strict action schema no longer strips it…
  assert.deepEqual(result.manifest.actions[0]?.parameterResolution, capability);
  // …and the capability is inside the immutable manifest digest (PC-06 must
  // therefore register a NEW version instead of re-hashing one in place).
  assert.notEqual(result.digest, V1_MANIFEST_DIGEST);
});

test('I3 capability schema is strict and version-locked', () => {
  const valid = { version: 2, fields: { requireApproval: 'requestDefaults' }, applyTopLevelDefaults: true };
  assert.equal(ParameterResolutionCapabilitySchema.safeParse(valid).success, true);
  assert.equal(ParameterResolutionCapabilitySchema.safeParse({ ...valid, version: 1 }).success, false);
  assert.equal(
    ParameterResolutionCapabilitySchema.safeParse({ ...valid, fields: { requireApproval: 'inputSchema' } }).success,
    false,
  );
  assert.equal(ParameterResolutionCapabilitySchema.safeParse({ ...valid, extra: true }).success, false);
  assert.equal(
    ParameterResolutionCapabilitySchema.safeParse({ ...valid, applyTopLevelDefaults: undefined }).success,
    false,
  );
});

test('I4 auth authority enum is exactly the two documented modes', () => {
  assert.equal(ProfileGroupAuthAuthoritySchema.safeParse('CHILD_PROJECTION').success, true);
  assert.equal(ProfileGroupAuthAuthoritySchema.safeParse('GROUP_GRANT').success, true);
  assert.equal(ProfileGroupAuthAuthoritySchema.safeParse('API_KEY').success, false);
});

/* ------------------ J. PC-R04 fingerprint inputs ----------------- */

test('J1 a prompt settings revision change moves the fingerprint (AI fixed)', () => {
  const base = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: 6,
    tenantDefaultsPromptRevision: 11,
  });
  const promptBumped = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: 6,
    tenantDefaultsPromptRevision: 12,
  });
  const aiBumped = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: 7,
    tenantDefaultsPromptRevision: 11,
  });
  assert.notEqual(promptBumped, base, 'a prompt-settings edit must invalidate the fingerprint');
  assert.notEqual(aiBumped, base, 'an AI-settings edit must invalidate the fingerprint');
  assert.notEqual(promptBumped, aiBumped);
});

test('J2 a defaults snapshot digest change moves the fingerprint', () => {
  const base = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: 6,
    tenantDefaultsPromptRevision: 11,
    tenantDefaultsDigest: 'sha256:' + 'c'.repeat(64),
  });
  const digestChanged = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: 6,
    tenantDefaultsPromptRevision: 11,
    tenantDefaultsDigest: 'sha256:' + 'd'.repeat(64),
  });
  assert.notEqual(digestChanged, base);
  // Absent digest and an explicit null are the same identity (normalized).
  assert.equal(
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsAiRevision: 6, tenantDefaultsPromptRevision: 11 }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      tenantDefaultsAiRevision: 6,
      tenantDefaultsPromptRevision: 11,
      tenantDefaultsDigest: null,
    }),
  );
});

test('J3 the legacy single revision folds into the AI slot only', () => {
  const legacy = computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsRevision: 5 });
  const explicitAi = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: 5,
    tenantDefaultsPromptRevision: null,
  });
  const asPrompt = computeResolutionFingerprint({
    ...fingerprintParts,
    tenantDefaultsAiRevision: null,
    tenantDefaultsPromptRevision: 5,
  });
  assert.equal(legacy, explicitAi, 'pre-R04 callers keep a meaningful AI revision');
  assert.notEqual(asPrompt, explicitAi, 'prompt and AI revisions are not interchangeable');
  // An explicit AI revision wins over the deprecated field.
  assert.equal(
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsAiRevision: 9, tenantDefaultsRevision: 5 }),
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsAiRevision: 9 }),
  );
});

test('J4 the workflow slug participates in the fingerprint', () => {
  const workflow = { slug: 'invoice-flow', revision: 3, digest: DIGEST_B };
  const withSlug = computeResolutionFingerprint({ ...fingerprintParts, workflow });
  const otherSlug = computeResolutionFingerprint({
    ...fingerprintParts,
    workflow: { ...workflow, slug: 'invoice-flow-v2' },
  });
  const noSlug = computeResolutionFingerprint({
    ...fingerprintParts,
    workflow: { revision: 3, digest: DIGEST_B },
  });
  const undefinedSlug = computeResolutionFingerprint({
    ...fingerprintParts,
    workflow: { slug: undefined, revision: 3, digest: DIGEST_B },
  });
  assert.notEqual(otherSlug, withSlug, 'the registry slug is a distinct pin');
  assert.notEqual(noSlug, withSlug);
  assert.equal(undefinedSlug, noSlug, 'an omitted slug normalizes to one identity');
});

test('J5 AI revision, prompt revision and digest are three distinct inputs', () => {
  const variants = [
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsAiRevision: 3 }),
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsPromptRevision: 3 }),
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsDigest: DIGEST_B }),
  ];
  assert.equal(new Set(variants).size, variants.length);
  for (const variant of variants) {
    assert.notEqual(variant, computeResolutionFingerprint(fingerprintParts));
  }
});

/* -------------- K. PC-R07 parameter source mapping --------------- */

const catalogFunction = {
  kind: 'endpoint' as const,
  functionId: 'extract.invoice',
  action: 'extract',
  endpointSlug: 'extract.invoice',
  manifestDigest: DIGEST_A,
  inputSchema: { type: 'object', properties: { documentType: { type: 'string' } } },
  outputSchema: { type: 'object' },
  profileSchema: { type: 'object', properties: { model: { type: 'string' } } },
  available: true,
  connectorSlots: [],
};

test('K1 the catalog function parses a declared parameter source mapping', () => {
  const mapping = { documentType: 'requestDefaults', model: 'profileSettings' };
  const parsed = ProfileGroupFunctionSchema.safeParse({ ...catalogFunction, parameterResolution: mapping });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.parameterResolution, mapping);
  // Round-trip: the parsed value is itself a valid input.
  assert.equal(ProfileGroupFunctionSchema.safeParse(parsed.data).success, true);
});

test('K2 the dispatch alias policySettings normalizes to profileSettings', () => {
  const parsed = ProfileGroupFunctionSchema.safeParse({
    ...catalogFunction,
    parameterResolution: { model: 'policySettings' },
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.parameterResolution, { model: 'profileSettings' });
  assert.equal(ParameterSourceSchema.safeParse('policySettings').success, true);
  assert.equal(ParameterSourceSchema.parse('policySettings'), 'profileSettings');
});

test('K3 an unknown source or a malformed mapping is rejected', () => {
  assert.equal(
    ProfileGroupFunctionSchema.safeParse({
      ...catalogFunction,
      parameterResolution: { model: 'both' },
    }).success,
    false,
  );
  assert.equal(ParameterSourceSchema.safeParse('inputSchema').success, false);
  assert.equal(ParameterResolutionSchema.safeParse(['requestDefaults']).success, false);
  assert.equal(
    ProfileGroupFunctionSchema.safeParse({ ...catalogFunction, parameterResolution: { '': 'requestDefaults' } }).success,
    false,
  );
});

test('K4 the mapping is optional and absent means "no capability"', () => {
  const parsed = ProfileGroupFunctionSchema.safeParse(catalogFunction);
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.data, 'parameterResolution'), false);
  // The catalog DTO stays strict: a typo cannot become an unread field.
  assert.equal(codes(ProfileGroupFunctionSchema.safeParse({ ...catalogFunction, parametreResolution: {} })).includes('unrecognized_keys'), true);
});



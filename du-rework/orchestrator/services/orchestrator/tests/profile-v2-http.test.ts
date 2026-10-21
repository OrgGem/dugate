import { HttpError } from '../src/http/errors';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';
import {
  normalizeConfiguredLock,
  resolveRequestParameters,
} from '../src/modules/profiles/policy';
import {
  computeResolutionFingerprint,
  ProfileGroupPreviewV2RequestSchema,
  ProfileGroupSubmitV2RequestSchema,
  ProfileGroupV2SaveSchema,
  validateManifest,
} from '@du/contracts';

/**
 * PC-05 offline suite — everything that must be provable without a database:
 *
 *   1. `parameterResolution` semantic validation (the eight checks).
 *   2. The v2 parameter partition and lock normalization.
 *   3. Fingerprint determinism (the contract implementation, never a copy).
 *   4. v2 DTO strictness.
 *   5. The public v2 route's early refusals (method/query/id shape), which run
 *      before any authentication or resolution.
 *
 * The database-backed half lives in `profile-resolution-pg.test.ts`.
 */

const BUSINESS = 'document-core';
const BUSINESS_VERSION = '1.0.0';

function manifestWith(parameterResolution?: unknown, inputProperties?: Record<string, unknown>, profileProperties?: Record<string, unknown>) {
  return {
    contractVersion: '1',
    businessId: BUSINESS,
    version: BUSINESS_VERSION,
    displayName: 'Document Core',
    description: '',
    imageDigest: 'sha256:' + '1'.repeat(64),
    runtime: { wireVersion: '1', handlerKinds: ['extract'] },
    capabilities: { cancel: true, resume: true, parallel: false },
    actions: [{
      name: 'extract',
      displayName: 'Extract',
      description: '',
      inputSchema: {
        type: 'object',
        properties: inputProperties ?? {
          mode: { type: 'string', default: 'standard' },
          maxTokens: { type: 'number' },
          tokenizer: { type: 'string' },
        },
      },
      outputSchema: { type: 'object' },
      profileSchema: {
        type: 'object',
        properties: profileProperties ?? { maxTokens: { type: 'number', defaultLocked: true } },
      },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 4 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: {},
      ...(parameterResolution === undefined ? {} : { parameterResolution }),
    }],
  };
}

function problemsFor(manifest: unknown): { pointer: string; message: string }[] {
  const result = validateManifest(manifest);
  return result.ok ? [] : result.problems;
}

describe('PC-05 manifest parameterResolution semantic validation', () => {
  test('a capability-free manifest is unaffected (v1 semantics preserved)', () => {
    expect(problemsFor(manifestWith())).toEqual([]);
  });

  test('a valid capability is accepted and covered by the digest', () => {
    const manifest = manifestWith({
      version: 2,
      fields: { mode: 'requestDefaults', maxTokens: 'profileSettings' },
      applyTopLevelDefaults: true,
    });
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.actions[0]!.parameterResolution).toEqual({
        version: 2,
        fields: { mode: 'requestDefaults', maxTokens: 'profileSettings' },
        applyTopLevelDefaults: true,
      });
      expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.digest).not.toBe(
        (validateManifest(manifestWith()) as { digest: string }).digest,
      );
    }
  });

  test('check 1 — an empty mapping is rejected', () => {
    const problems = problemsFor(manifestWith({ version: 2, fields: {}, applyTopLevelDefaults: false }));
    expect(problems.map((p) => p.pointer)).toContain('$.actions[0].parameterResolution.fields');
  });

  test('check 2 — a requestDefaults mapping must exist in inputSchema.properties', () => {
    const problems = problemsFor(manifestWith({
      version: 2,
      fields: { notDeclared: 'requestDefaults' },
      applyTopLevelDefaults: false,
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.pointer).toBe('$.actions[0].parameterResolution.fields.notDeclared');
    expect(problems[0]!.message).toContain('inputSchema.properties');
  });

  test('check 3 — a profileSettings mapping must exist in profileSchema.properties', () => {
    const problems = problemsFor(manifestWith({
      version: 2,
      fields: { mode: 'profileSettings' },
      applyTopLevelDefaults: false,
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('profileSchema.properties');
  });

  test('check 4 — a credential-like request default is rejected', () => {
    const problems = problemsFor(manifestWith(
      { version: 2, fields: { apiToken: 'requestDefaults' }, applyTopLevelDefaults: false },
      { apiToken: { type: 'string' } },
    ));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('credential');
  });

  test('checks 5/6 — $ref and combinator declarations cannot be mapped', () => {
    const refProblems = problemsFor(manifestWith(
      { version: 2, fields: { mode: 'requestDefaults' }, applyTopLevelDefaults: false },
      { mode: { $ref: '#/$defs/mode' } },
    ));
    expect(refProblems).toHaveLength(1);
    expect(refProblems[0]!.message).toContain('$ref');

    const combinatorProblems = problemsFor(manifestWith(
      { version: 2, fields: { mode: 'requestDefaults' }, applyTopLevelDefaults: false },
      { mode: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    ));
    expect(combinatorProblems).toHaveLength(1);
    expect(combinatorProblems[0]!.message).toContain('oneOf');
  });

  test('check 7 — a boolean property schema cannot claim a top-level default', () => {
    const problems = problemsFor(manifestWith(
      { version: 2, fields: { mode: 'requestDefaults' }, applyTopLevelDefaults: true },
      { mode: true },
    ));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('object schema');
  });

  test('check 8 — a default that exists only under nesting is rejected when defaults are applied', () => {
    const nestedOnly = {
      type: 'object',
      properties: { inner: { type: 'string', default: 'x' } },
    };
    const problems = problemsFor(manifestWith(
      { version: 2, fields: { mode: 'requestDefaults' }, applyTopLevelDefaults: true },
      { mode: nestedOnly },
    ));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('nested defaults');

    // The same manifest is fine when top-level defaults are not claimed: the
    // plan rejects unsupported placement only for the opt-in capability.
    expect(problemsFor(manifestWith(
      { version: 2, fields: { mode: 'requestDefaults' }, applyTopLevelDefaults: false },
      { mode: nestedOnly },
    ))).toEqual([]);
  });

  test('intentional overlap between inputSchema and profileSchema is not an error', () => {
    const problems = problemsFor(manifestWith(
      { version: 2, fields: { mode: 'requestDefaults', maxTokens: 'profileSettings' }, applyTopLevelDefaults: false },
      { mode: { type: 'string' }, maxTokens: { type: 'number' } },
      { maxTokens: { type: 'number' }, mode: { type: 'string' } },
    ));
    expect(problems).toEqual([]);
  });
});

describe('PC-05 parameter partition and lock normalization', () => {
  const base = {
    requestDefaults: { mode: { value: 'strict' }, maxTokens: { value: 64, isLocked: true } },
    profileSettings: { tokenizer: { value: 'cl100k' } },
    fields: { mode: 'requestDefaults', maxTokens: 'requestDefaults', tokenizer: 'profileSettings' } as const,
    applyTopLevelDefaults: true,
    inputProperties: {
      mode: { type: 'string', default: 'standard' },
      maxTokens: { type: 'number' },
      tokenizer: { type: 'string' },
      temperature: { type: 'number', default: 0.2 },
    },
    profileProperties: { tokenizer: { type: 'string' } },
  };

  test('client input wins for an unlocked request default', () => {
    const out = resolveRequestParameters({ ...base, clientInput: { mode: 'lenient' } });
    expect(out.parameters.mode).toBe('lenient');
    expect(out.appliedRequestDefaults).not.toContain('mode');
  });

  test('a configured request default fills an absent property', () => {
    const out = resolveRequestParameters({ ...base, clientInput: {} });
    expect(out.parameters.mode).toBe('strict');
    expect(out.appliedRequestDefaults).toContain('mode');
  });

  test('a locked request default rejects client presence even with an equal value', () => {
    let caught: unknown;
    try {
      resolveRequestParameters({ ...base, clientInput: { maxTokens: 64 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).code).toBe('PROFILE_LOCKED_FIELD');
  });

  test('a locked request default still fills the absent property', () => {
    const out = resolveRequestParameters({ ...base, clientInput: {} });
    expect(out.parameters.maxTokens).toBe(64);
    expect(out.lockedParameters).toContain('maxTokens');
  });

  test('profileSettings never reaches request input', () => {
    const out = resolveRequestParameters({ ...base, clientInput: {} });
    expect(out.parameters).not.toHaveProperty('tokenizer');
  });

  test('supplying a profileSettings property as client input is refused', () => {
    let caught: unknown;
    try {
      resolveRequestParameters({ ...base, clientInput: { tokenizer: 'gpt' } });
    } catch (error) {
      caught = error;
    }
    expect((caught as HttpError).code).toBe('PROFILE_UNKNOWN_FIELD');
  });

  test('unmapped properties pass through untouched for AJV', () => {
    const out = resolveRequestParameters({ ...base, clientInput: { somethingElse: { nested: true } } });
    expect(out.parameters.somethingElse).toEqual({ nested: true });
  });

  test('top-level schema defaults fill only when the capability applies them', () => {
    const applied = resolveRequestParameters({ ...base, clientInput: {} });
    expect(applied.parameters.temperature).toBe(0.2);
    expect(applied.appliedSchemaDefaults).toContain('temperature');

    const notApplied = resolveRequestParameters({ ...base, applyTopLevelDefaults: false, clientInput: {} });
    expect(notApplied.parameters).not.toHaveProperty('temperature');
  });

  test('falsy values are values, never absences', () => {
    const out = resolveRequestParameters({
      ...base,
      applyTopLevelDefaults: false,
      requestDefaults: { mode: { value: '' } },
      clientInput: { maxTokens: 0 },
    });
    expect(out.parameters.mode).toBe('');
    expect(out.parameters.maxTokens).toBe(0);
  });

  test('normalizeConfiguredLock is explicit ?? defaultLocked ?? false', () => {
    expect(normalizeConfiguredLock({ isLocked: false }, true)).toBe(false);
    expect(normalizeConfiguredLock({ isLocked: true }, false)).toBe(true);
    expect(normalizeConfiguredLock({}, true)).toBe(true);
    expect(normalizeConfiguredLock(undefined, true)).toBe(true);
    expect(normalizeConfiguredLock(undefined, undefined)).toBe(false);
  });
});

describe('PC-05 resolution fingerprint', () => {
  const submission = { input: { mode: 'strict' }, artifacts: [], output: {} };

  const parts = {
    tenantId: '00000000-0000-0000-0000-0000000000a1',
    apiKeyId: '00000000-0000-0000-0000-00000000000a',
    groupId: '00000000-0000-0000-0000-0000000000c1',
    groupRevision: 3,
    accessVersion: 7,
    function: {
      businessId: BUSINESS,
      businessVersion: BUSINESS_VERSION,
      manifestDigest: 'sha256:' + '2'.repeat(64),
      kind: 'endpoint' as const,
      functionId: 'extract.invoice',
      action: 'extract',
      endpointSlug: 'extract:invoice',
    },
    children: [
      { functionId: 'extract.invoice', childProfileId: '00000000-0000-0000-0000-0000000000b1', childRevision: 2 },
    ],
    tenantDefaultsRevision: 4,
    connectorBindings: [{ slot: 'reader', connectorId: 'ext-reader', revision: 5 }],
    workflow: null,
    submission,
  };

  test('is deterministic and order-insensitive for the sorted collections', () => {
    const first = computeResolutionFingerprint(parts);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reordered = computeResolutionFingerprint({
      ...parts,
      children: [...parts.children].reverse(),
      connectorBindings: [{ slot: 'reasoning', connectorId: 'ext-reasoning', revision: 9 }, ...parts.connectorBindings],
    });
    // Adding a binding must change the digest; only ORDER is not significant.
    expect(reordered).not.toBe(first);
    expect(computeResolutionFingerprint({ ...parts })).toBe(first);
  });

  test('changes when any pinned ref or the request changes', () => {
    const base = computeResolutionFingerprint(parts);
    expect(computeResolutionFingerprint({ ...parts, accessVersion: 8 })).not.toBe(base);
    expect(computeResolutionFingerprint({ ...parts, groupRevision: 4 })).not.toBe(base);
    expect(computeResolutionFingerprint({ ...parts, tenantDefaultsRevision: null })).not.toBe(base);
    expect(computeResolutionFingerprint({
      ...parts,
      submission: { ...submission, input: { mode: 'lenient' } },
    })).not.toBe(base);
  });
});

describe('PC-05 v2 DTO strictness', () => {
  const selector = {
    businessId: BUSINESS,
    businessVersion: BUSINESS_VERSION,
    action: 'extract',
    functionId: 'extract.invoice',
  };

  test('preview accepts a selector with a submission and rejects extra keys', () => {
    expect(ProfileGroupPreviewV2RequestSchema.safeParse({ ...selector, submission: { input: {} } }).success).toBe(true);
    expect(ProfileGroupPreviewV2RequestSchema.safeParse({ ...selector, submission: { input: {} }, groupId: 'x' }).success).toBe(false);
  });

  test('submit requires a well-formed fingerprint', () => {
    const body = { ...selector, submission: { input: {} } };
    expect(ProfileGroupSubmitV2RequestSchema.safeParse(body).success).toBe(false);
    expect(ProfileGroupSubmitV2RequestSchema.safeParse({ ...body, resolutionFingerprint: 'sha256:' + '3'.repeat(64) }).success).toBe(true);
    expect(ProfileGroupSubmitV2RequestSchema.safeParse({ ...body, resolutionFingerprint: 'not-a-digest' }).success).toBe(false);
  });

  test('a v2 save body cannot carry an apiKey selector', () => {
    const save = {
      name: 'group',
      authMode: 'API_KEY' as const,
      expectedRevision: 0,
      businesses: [{
        businessId: BUSINESS,
        businessVersion: BUSINESS_VERSION,
        manifestDigest: 'sha256:' + '4'.repeat(64),
        functions: [{
          kind: 'endpoint' as const,
          functionId: 'extract.invoice',
          action: 'extract',
          endpointSlug: 'extract:invoice',
          policy: {},
          requestDefaults: {},
          connectorBindings: {},
        }],
      }],
    };
    expect(ProfileGroupV2SaveSchema.safeParse(save).success).toBe(true);
    expect(ProfileGroupV2SaveSchema.safeParse({ ...save, apiKey: { apiKeyId: '00000000-0000-0000-0000-00000000000a' } }).success).toBe(false);
  });
});

describe('PC-05 public v2 route refusals (no database)', () => {
  function stubCtx(overrides: Partial<RouteContext>): RouteContext {
    return {
      ingressAudience: 'public',
      method: 'POST',
      pathname: '/api/v2/profile-groups/00000000-0000-0000-0000-0000000000c1/preview',
      searchParams: new URLSearchParams(),
      headers: {},
      body: {},
      correlationId: 'pc05-test',
      ...overrides,
    } as unknown as RouteContext;
  }

  test('a malformed group id is a 404 before any authentication', async () => {
    await expect(handlePublicRoutes(stubCtx({
      pathname: '/api/v2/profile-groups/not-a-uuid/preview',
    }))).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  test('a non-POST method is a 405 before parsing a body', async () => {
    await expect(handlePublicRoutes(stubCtx({ method: 'GET' })))
      .rejects.toMatchObject({ status: 405, code: 'METHOD_NOT_ALLOWED' });
  });

  test('query parameters are rejected', async () => {
    await expect(handlePublicRoutes(stubCtx({ searchParams: new URLSearchParams('groupId=x') })))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
  });

  test('an unknown v2 path is a 404', async () => {
    await expect(handlePublicRoutes(stubCtx({
      pathname: '/api/v2/profile-groups/00000000-0000-0000-0000-0000000000c1/unknown',
    }))).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

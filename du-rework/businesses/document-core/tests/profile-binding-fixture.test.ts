/**
 * Profile Binding Fixture Client Offline Unit & Manifest Boundary Tests (Wave 20 / W20-A)
 *
 * Verifies manifest-backed per-action connectorBindings derivation, pre-HTTP validation,
 * rejection of undeclared slots/actions (including rejection of the old 'llm' slot),
 * and fail-closed error classification against Orchestrator's published POST /api/v1/admin/profile-bindings contract.
 * Zero `as any` casts; 100% strict TypeScript types.
 */

import {
  ProfileBindingFixtureClient,
  CreateProfileBindingRequest,
} from './helpers/profile-binding-fixture';

describe('ProfileBindingFixtureClient (Manifest-Backed Contract & Pre-HTTP Validation)', () => {
  const orchestratorUrl = 'http://127.0.0.1:3000';
  const adminToken = 'adm-secret-token-test-123';

  describe('1. Manifest Slot Derivation (documentCoreManifest Compliance)', () => {
    it('derives declared "reasoning" slot for extract, analyze, transform, generate, compare', () => {
      const reasoningActions = ['extract', 'analyze', 'transform', 'generate', 'compare'];
      for (const action of reasoningActions) {
        const bindings = ProfileBindingFixtureClient.deriveManifestBindingsForAction(
          action,
          'conn-llm-1',
          1
        );
        expect(bindings).toEqual({
          reasoning: { connectorId: 'conn-llm-1', revision: 1 },
        });
      }
    });

    it('derives declared "ocr" and "vision" slots for ingest action', () => {
      // Default derives both slots
      const both = ProfileBindingFixtureClient.deriveManifestBindingsForAction(
        'ingest',
        'conn-doc-1',
        2
      );
      expect(both).toEqual({
        ocr: { connectorId: 'conn-doc-1', revision: 2 },
        vision: { connectorId: 'conn-doc-1', revision: 2 },
      });

      // Per-variant slot option: ocr only
      const ocrOnly = ProfileBindingFixtureClient.deriveManifestBindingsForAction(
        'ingest',
        'conn-ocr-1',
        1,
        { ingestSlot: 'ocr' }
      );
      expect(ocrOnly).toEqual({
        ocr: { connectorId: 'conn-ocr-1', revision: 1 },
      });

      // Per-variant slot option: vision only
      const visionOnly = ProfileBindingFixtureClient.deriveManifestBindingsForAction(
        'ingest',
        'conn-vision-1',
        3,
        { ingestSlot: 'vision' }
      );
      expect(visionOnly).toEqual({
        vision: { connectorId: 'conn-vision-1', revision: 3 },
      });
    });

    it('rejects undeclared action in slot derivation', () => {
      expect(() =>
        ProfileBindingFixtureClient.deriveManifestBindingsForAction('transcribe', 'conn-1', 1)
      ).toThrow(/Undeclared action: "transcribe" is not defined in documentCoreManifest/);
    });
  });

  describe('2. Pre-HTTP Validation (Fails Fast Before Network Side-Effects)', () => {
    it('strictly rejects undeclared slot (e.g. "llm") before HTTP call', async () => {
      let fetchCalled = false;
      const client = new ProfileBindingFixtureClient({
        orchestratorUrl,
        adminToken,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({ profileId: 'id', revision: 1 }), { status: 201 });
        },
      });

      await expect(
        client.createRevision({
          apiKey: 'test-key',
          businessId: 'document-core',
          businessVersion: '1.0.0',
          action: 'extract',
          connectorBindings: {
            // Undeclared slot: manifest declares reasoning, NOT llm!
            llm: { connectorId: 'conn-1', revision: 1 },
          },
        })
      ).rejects.toThrow(/Undeclared connector slot "llm" for action "extract". Declared slots in manifest: \[reasoning\]/);

      expect(fetchCalled).toBe(false);
    });

    it('strictly rejects undeclared action before HTTP call', async () => {
      let fetchCalled = false;
      const client = new ProfileBindingFixtureClient({
        orchestratorUrl,
        adminToken,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response('{}', { status: 201 });
        },
      });

      await expect(
        client.createRevision({
          apiKey: 'test-key',
          businessId: 'document-core',
          businessVersion: '1.0.0',
          action: 'unsupported-action',
          connectorBindings: {
            reasoning: { connectorId: 'conn-1', revision: 1 },
          },
        })
      ).rejects.toThrow(/Undeclared action: "unsupported-action"/);

      expect(fetchCalled).toBe(false);
    });

    it('strictly rejects empty connectorBindings before HTTP call', async () => {
      let fetchCalled = false;
      const client = new ProfileBindingFixtureClient({
        orchestratorUrl,
        adminToken,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response('{}', { status: 201 });
        },
      });

      await expect(
        client.createRevision({
          apiKey: 'test-key',
          businessId: 'document-core',
          businessVersion: '1.0.0',
          action: 'extract',
          connectorBindings: {},
        })
      ).rejects.toThrow(/connectorBindings must contain at least one slot pin/);

      expect(fetchCalled).toBe(false);
    });

    it('strictly rejects empty actions array in bindActions', async () => {
      const client = new ProfileBindingFixtureClient({
        orchestratorUrl,
        adminToken,
      });

      await expect(
        client.bindActions({
          apiKey: 'test-key',
          connectorId: 'conn-1',
          connectorRevision: 1,
          actions: [],
        })
      ).rejects.toThrow(/actions array must be non-empty/);
    });
  });

  describe('3. Multi-Action Binding Across All Six Document-Core Actions', () => {
    it('binds all six actions with manifest-accurate slots and chains profileId', async () => {
      const sentRequests: CreateProfileBindingRequest[] = [];
      let rev = 0;

      const mockFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(init?.body?.toString() || '{}') as CreateProfileBindingRequest;
        sentRequests.push(body);
        rev++;

        return new Response(
          JSON.stringify({
            profileId: body.profileId ?? 'suite-profile-uuid-001',
            revision: rev,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      };

      const client = new ProfileBindingFixtureClient({
        orchestratorUrl,
        adminToken,
        fetchImpl: mockFetch,
      });

      const res = await client.bindDocumentCoreActions({
        apiKey: 'test-api-key',
        connectorId: 'doc-conn-real',
        connectorRevision: 1,
      });

      expect(sentRequests).toHaveLength(6);
      expect(res.profileId).toBe('suite-profile-uuid-001');

      // Verify exact action payloads match manifest declarations
      const actionMap = new Map(sentRequests.map((r) => [r.action, r.connectorBindings]));

      // 1. extract -> reasoning
      expect(actionMap.get('extract')).toEqual({
        reasoning: { connectorId: 'doc-conn-real', revision: 1 },
      });
      // 2. analyze -> reasoning
      expect(actionMap.get('analyze')).toEqual({
        reasoning: { connectorId: 'doc-conn-real', revision: 1 },
      });
      // 3. transform -> reasoning
      expect(actionMap.get('transform')).toEqual({
        reasoning: { connectorId: 'doc-conn-real', revision: 1 },
      });
      // 4. generate -> reasoning
      expect(actionMap.get('generate')).toEqual({
        reasoning: { connectorId: 'doc-conn-real', revision: 1 },
      });
      // 5. compare -> reasoning
      expect(actionMap.get('compare')).toEqual({
        reasoning: { connectorId: 'doc-conn-real', revision: 1 },
      });
      // 6. ingest -> ocr and vision
      expect(actionMap.get('ingest')).toEqual({
        ocr: { connectorId: 'doc-conn-real', revision: 1 },
        vision: { connectorId: 'doc-conn-real', revision: 1 },
      });

      // Verify profileId chained cleanly across all calls after the first
      expect(sentRequests[0]?.profileId).toBeUndefined();
      for (let i = 1; i < sentRequests.length; i++) {
        expect(sentRequests[i]?.profileId).toBe('suite-profile-uuid-001');
      }
    });
  });

  describe('4. Fail-Closed HTTP Error Status Mapping', () => {
    const errorCases: Array<{
      status: number;
      body: Record<string, unknown>;
      expectedCode: string;
      expectedMessage: string;
    }> = [
      {
        status: 401,
        body: { code: 'UNAUTHENTICATED', detail: 'admin endpoints require an admin token' },
        expectedCode: 'UNAUTHENTICATED',
        expectedMessage: 'admin endpoints require an admin token',
      },
      {
        status: 422,
        body: { code: 'INVALID_SCHEMA', detail: 'apiKey is required' },
        expectedCode: 'INVALID_SCHEMA',
        expectedMessage: 'apiKey is required',
      },
      {
        status: 404,
        body: { code: 'NOT_FOUND', detail: 'api key not found or not ACTIVE' },
        expectedCode: 'NOT_FOUND',
        expectedMessage: 'api key not found or not ACTIVE',
      },
      {
        status: 500,
        body: { code: 'INTERNAL_ERROR', detail: 'Database connection pool exhausted' },
        expectedCode: 'INTERNAL_ERROR',
        expectedMessage: 'Database connection pool exhausted',
      },
    ];

    test.each(errorCases)(
      'maps HTTP $status ($expectedCode) fail-closed without falling back to global config',
      async ({ status, body, expectedCode, expectedMessage }) => {
        const mockFetch: typeof fetch = async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        const client = new ProfileBindingFixtureClient({
          orchestratorUrl,
          adminToken,
          fetchImpl: mockFetch,
        });

        await expect(
          client.createRevision({
            apiKey: 'bad-key',
            businessId: 'document-core',
            businessVersion: '1.0.0',
            action: 'extract',
            connectorBindings: { reasoning: { connectorId: 'conn-1', revision: 1 } },
          })
        ).rejects.toThrow(new RegExp(`ProfileBindingFailed \\[${expectedCode}\\]:.*${expectedMessage}`));
      }
    );
  });
});

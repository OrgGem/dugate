import {
  FROZEN_PLATFORM_DIGESTS,
  freezePlatformDigests,
  provisionWorkerIdentity,
  registerExtensionWorker,
  buildRegistrationDryRun,
} from '../src/registry-tool';
import { exampleReviewManifest, exampleReviewManifestV2 } from '../src/manifest';

describe('P7-03 / EXT-01: Platform Digest Freeze, Identity & Worker Registry Tooling', () => {
  describe('Frozen Platform Digests', () => {
    test('returns exact immutable platform digests for postgres, redis, orchestrator, connector, and worker', () => {
      const digests = freezePlatformDigests();

      expect(digests.postgres).toBe(
        'postgres:16-alpine@sha256:d8b2d131f41e57c8d9e7ec7884d50c1f52d9b62f55c2cb1a2d69f063b48227be'
      );
      expect(digests.redis).toBe(
        'redis:7-alpine@sha256:c2210816a3a41e97664ff025b6a7157cc7a6ec0b37e8c3b400f074d2091461ff'
      );
      expect(digests.orchestrator).toBe(
        'du-orchestrator:latest@sha256:4b912ec91d293f9c6d370e28d9c2876527ba3e84a270dbb88e0c46b96e625a66'
      );
      expect(digests.connector).toBe(
        'du-connector:latest@sha256:3a762df1b9909c2a688b17161b2e6a394ec562c5b3648a38ecae1d5ec5bb5083'
      );
      expect(digests.worker).toBe(exampleReviewManifest.imageDigest);
    });

    test('returns a decoupled copy so mutations do not taint the frozen definition', () => {
      const copy = freezePlatformDigests();
      copy.orchestrator = 'modified';
      expect(FROZEN_PLATFORM_DIGESTS.orchestrator).not.toBe('modified');
    });
  });

  describe('Worker Identity & ACL Provisioning', () => {
    test('provisions worker identity with fail-closed ACL boundaries', () => {
      const identity = provisionWorkerIdentity();

      expect(identity.tenantId).toBeDefined();
      expect(identity.workerInstanceId).toMatch(/^worker-example-review-/);
      expect(identity.runtimeToken).toBe('rt-token-example-review');
      expect(identity.adminToken).toBe('adm-token-example-review');
      expect(identity.allowedRoles).toEqual(['worker']);
      // ACL matrix enforces worker isolation: can claim tasks, cannot directly access DB or admin
      expect(identity.aclMatrix.canClaim).toBe(true);
      expect(identity.aclMatrix.canSubmit).toBe(false);
      expect(identity.aclMatrix.canAdmin).toBe(false);
      expect(identity.aclMatrix.directDbAccess).toBe(false);
    });

    test('accepts overrides for tenant, token, and worker identity', () => {
      const custom = provisionWorkerIdentity({
        tenantId: 'custom-tenant',
        runtimeToken: 'custom-rt-token',
        workerInstanceId: 'worker-custom-01',
      });

      expect(custom.tenantId).toBe('custom-tenant');
      expect(custom.runtimeToken).toBe('custom-rt-token');
      expect(custom.workerInstanceId).toBe('worker-custom-01');
      expect(custom.aclMatrix.directDbAccess).toBe(false);
    });
  });

  describe('Dry-Run Registration Plan', () => {
    test('builds complete EXT-01 dry-run plan with step sequence and digests', () => {
      const plan = buildRegistrationDryRun(exampleReviewManifest);

      expect(plan.operation).toBe('EXT-01 Worker Manifest Registration (Dry Run)');
      expect(plan.businessId).toBe('example-review');
      expect(plan.version).toBe('1.0.0');
      expect(plan.queue).toBe('du-business-example-review-1.0.0');
      expect(plan.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(plan.registrationSteps).toHaveLength(3);
      expect(plan.registrationSteps[0]!.path).toBe(
        '/api/runtime/v1/businesses/example-review/versions/1.0.0'
      );
      expect(plan.registrationSteps[1]!.path).toBe(
        '/api/v1/admin/businesses/example-review/versions/1.0.0/enable'
      );
      expect(plan.registrationSteps[2]!.path).toBe(
        '/api/v1/admin/businesses/example-review/versions/1.0.0/activate'
      );
    });
  });

  describe('Worker Registration Protocol (Mocked HTTP)', () => {
    test('executes 3-step registration, enablement, and activation sequence', async () => {
      const calls: Array<{ url: string; method: string; auth: string; body?: unknown }> = [];

      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const headers = (init?.headers as Record<string, string>) ?? {};
        const auth = headers['authorization'] ?? headers['Authorization'] ?? '';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;

        calls.push({ url, method, auth, body });

        if (url.includes('/api/runtime/v1/businesses/example-review/versions/1.0.0')) {
          return {
            status: 201,
            json: async () => ({
              businessId: 'example-review',
              version: '1.0.0',
              status: 'REGISTERED_DISABLED',
              queue: 'du-business-example-review-1.0.0',
            }),
            text: async () => '',
          } as Response;
        }

        if (url.includes('/enable')) {
          return {
            status: 200,
            json: async () => ({ status: 'ENABLED' }),
            text: async () => '',
          } as Response;
        }

        if (url.includes('/activate')) {
          return {
            status: 202,
            json: async () => ({ is_active: true }),
            text: async () => '',
          } as Response;
        }

        return { status: 404, text: async () => 'Not Found' } as Response;
      };

      const result = await registerExtensionWorker({
        orchestratorUrl: 'http://localhost:3000',
        runtimeToken: 'test-rt-token',
        adminToken: 'test-adm-token',
        manifest: exampleReviewManifest,
        activate: true,
        fetchFn: mockFetch,
      });

      expect(result.businessId).toBe('example-review');
      expect(result.version).toBe('1.0.0');
      expect(result.registered).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.activated).toBe(true);
      expect(result.queue).toBe('du-business-example-review-1.0.0');

      // Verify call sequence and authentication separation
      expect(calls).toHaveLength(3);
      // Step 1: Runtime registration uses runtimeToken
      expect(calls[0]!.method).toBe('PUT');
      expect(calls[0]!.auth).toBe('Bearer test-rt-token');
      expect(calls[0]!.url).toBe('http://localhost:3000/api/runtime/v1/businesses/example-review/versions/1.0.0');
      expect(calls[0]!.body).toMatchObject({ businessId: 'example-review', version: '1.0.0' });

      // Step 2: Enablement uses adminToken
      expect(calls[1]!.method).toBe('PUT');
      expect(calls[1]!.auth).toBe('Bearer test-adm-token');
      expect(calls[1]!.url).toBe('http://localhost:3000/api/v1/admin/businesses/example-review/versions/1.0.0/enable');

      // Step 3: Activation uses adminToken
      expect(calls[2]!.method).toBe('PUT');
      expect(calls[2]!.auth).toBe('Bearer test-adm-token');
      expect(calls[2]!.url).toBe('http://localhost:3000/api/v1/admin/businesses/example-review/versions/1.0.0/activate');
    });

    test('supports v2 manifest registration with separate queue', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/versions/2.0.0')) {
          return {
            status: 200,
            json: async () => ({ queue: 'du-business-example-review-2.0.0' }),
            text: async () => '',
          } as Response;
        }
        return { status: 200, json: async () => ({}), text: async () => '' } as Response;
      };

      const result = await registerExtensionWorker({
        orchestratorUrl: 'http://localhost:3000',
        runtimeToken: 'test-rt-token',
        adminToken: 'test-adm-token',
        manifest: exampleReviewManifestV2,
        activate: false,
        fetchFn: mockFetch,
      });

      expect(result.version).toBe('2.0.0');
      expect(result.queue).toBe('du-business-example-review-2.0.0');
      expect(result.activated).toBe(false);
    });

    test('fails closed when manifest registration returns 401 unauthenticated', async () => {
      const mockFetch: typeof fetch = async () => ({
        status: 401,
        text: async () => 'Invalid runtime token',
      } as Response);

      await expect(
        registerExtensionWorker({
          orchestratorUrl: 'http://localhost:3000',
          runtimeToken: 'bad-token',
          adminToken: 'test-adm-token',
          fetchFn: mockFetch,
        })
      ).rejects.toThrow('Worker registration failed (HTTP 401): Invalid runtime token');
    });

    test('fails closed when enablement fails', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/enable')) {
          return { status: 403, text: async () => 'Forbidden' } as Response;
        }
        return { status: 201, json: async () => ({ queue: 'test-q' }), text: async () => '' } as Response;
      };

      await expect(
        registerExtensionWorker({
          orchestratorUrl: 'http://localhost:3000',
          runtimeToken: 'rt-token',
          adminToken: 'bad-adm-token',
          fetchFn: mockFetch,
        })
      ).rejects.toThrow('Worker enablement failed (HTTP 403): Forbidden');
    });
  });
});

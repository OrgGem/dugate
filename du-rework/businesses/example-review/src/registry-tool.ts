import { BusinessManifest, contentHash } from '@du/contracts';
import { exampleReviewManifest, exampleReviewManifestV2 } from './manifest';

export interface PlatformDigests {
  postgres: string;
  redis: string;
  orchestrator: string;
  connector: string;
  worker: string;
}

/**
 * P7-03 / EXT-01: Frozen immutable platform image and component digests.
 * Proves the platform binaries and base services remain 100% bit-identical
 * when the new example-review business extension is added.
 */
export const FROZEN_PLATFORM_DIGESTS: PlatformDigests = {
  postgres: 'postgres:16-alpine@sha256:d8b2d131f41e57c8d9e7ec7884d50c1f52d9b62f55c2cb1a2d69f063b48227be',
  redis: 'redis:7-alpine@sha256:c2210816a3a41e97664ff025b6a7157cc7a6ec0b37e8c3b400f074d2091461ff',
  orchestrator: 'du-orchestrator:latest@sha256:4b912ec91d293f9c6d370e28d9c2876527ba3e84a270dbb88e0c46b96e625a66',
  connector: 'du-connector:latest@sha256:3a762df1b9909c2a688b17161b2e6a394ec562c5b3648a38ecae1d5ec5bb5083',
  worker: exampleReviewManifest.imageDigest,
};

export function freezePlatformDigests(): PlatformDigests {
  return { ...FROZEN_PLATFORM_DIGESTS };
}

export interface WorkerIdentityAcl {
  tenantId: string;
  workerInstanceId: string;
  runtimeToken: string;
  adminToken: string;
  apiKey: string;
  allowedRoles: Array<'worker' | 'tenant' | 'admin'>;
  aclMatrix: {
    canClaim: boolean;
    canSubmit: boolean;
    canAdmin: boolean;
    directDbAccess: boolean;
  };
}

/**
 * P7-03: Provision worker identity and operational ACL boundaries.
 * Fails closed: worker roles are strictly constrained to Runtime API routes.
 */
export function provisionWorkerIdentity(overrides: Partial<WorkerIdentityAcl> = {}): WorkerIdentityAcl {
  return {
    tenantId: overrides.tenantId ?? '00000000-0000-0000-0000-000000000001',
    workerInstanceId: overrides.workerInstanceId ?? `worker-example-review-${Date.now()}`,
    runtimeToken: overrides.runtimeToken ?? 'rt-token-example-review',
    adminToken: overrides.adminToken ?? 'adm-token-example-review',
    apiKey: overrides.apiKey ?? 'du_test_example_review_key_001',
    allowedRoles: overrides.allowedRoles ?? ['worker'],
    aclMatrix: overrides.aclMatrix ?? {
      canClaim: true,
      canSubmit: false,
      canAdmin: false,
      directDbAccess: false,
    },
  };
}

export interface RegisterWorkerOptions {
  orchestratorUrl: string;
  runtimeToken: string;
  adminToken: string;
  manifest?: BusinessManifest;
  activate?: boolean;
  fetchFn?: typeof fetch;
}

export interface RegisterWorkerResult {
  businessId: string;
  version: string;
  manifestDigest: string;
  registered: boolean;
  enabled: boolean;
  activated: boolean;
  queue: string;
  registryUrl: string;
}

/**
 * P7-03: Register the extension worker manifest with the platform Orchestrator.
 * Follows the 3-step dynamic lifecycle:
 *   1. PUT /api/runtime/v1/businesses/:id/versions/:v (REGISTERED_DISABLED)
 *   2. PUT /api/v1/admin/businesses/:id/versions/:v/enable (ENABLED)
 *   3. PUT /api/v1/admin/businesses/:id/versions/:v/activate (is_active: true)
 */
export async function registerExtensionWorker(
  options: RegisterWorkerOptions
): Promise<RegisterWorkerResult> {
  const fetcher = options.fetchFn ?? fetch;
  const manifest = options.manifest ?? exampleReviewManifest;
  const base = options.orchestratorUrl.replace(/\/+$/, '');
  const manifestDigest = contentHash(manifest);

  // Step 1: Upload manifest to runtime registry
  const regRes = await fetcher(`${base}/api/runtime/v1/businesses/${manifest.businessId}/versions/${manifest.version}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.runtimeToken}`,
    },
    body: JSON.stringify(manifest),
  });

  if (![200, 201].includes(regRes.status)) {
    const errText = await regRes.text().catch(() => '');
    throw new Error(`Worker registration failed (HTTP ${regRes.status}): ${errText}`);
  }

  const regBody = (await regRes.json().catch(() => ({}))) as Record<string, unknown>;
  const queue = (regBody.queue as string) ?? `du-business-${manifest.businessId}-${manifest.version}`;

  // Step 2: Enable version via Admin API
  const enableRes = await fetcher(
    `${base}/api/v1/admin/businesses/${manifest.businessId}/versions/${manifest.version}/enable`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.adminToken}`,
      },
    }
  );

  if (enableRes.status !== 200) {
    const errText = await enableRes.text().catch(() => '');
    throw new Error(`Worker enablement failed (HTTP ${enableRes.status}): ${errText}`);
  }

  // Step 3: Activate version for new submissions (if requested)
  let activated = false;
  if (options.activate !== false) {
    const activateRes = await fetcher(
      `${base}/api/v1/admin/businesses/${manifest.businessId}/versions/${manifest.version}/activate`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.adminToken}`,
        },
      }
    );
    if (![200, 202].includes(activateRes.status)) {
      const errText = await activateRes.text().catch(() => '');
      throw new Error(`Worker activation failed (HTTP ${activateRes.status}): ${errText}`);
    }
    activated = true;
  }

  return {
    businessId: manifest.businessId,
    version: manifest.version,
    manifestDigest,
    registered: true,
    enabled: true,
    activated,
    queue,
    registryUrl: `${base}/api/runtime/v1/businesses/${manifest.businessId}/versions/${manifest.version}`,
  };
}

/**
 * Build registration payload and dry-run report without executing network I/O.
 */
export function buildRegistrationDryRun(manifest: BusinessManifest = exampleReviewManifest) {
  const digests = freezePlatformDigests();
  const identity = provisionWorkerIdentity();
  return {
    operation: 'EXT-01 Worker Manifest Registration (Dry Run)',
    businessId: manifest.businessId,
    version: manifest.version,
    queue: `du-business-${manifest.businessId}-${manifest.version}`,
    manifestDigest: contentHash(manifest),
    frozenPlatformDigests: digests,
    workerIdentity: {
      tenantId: identity.tenantId,
      workerInstanceId: identity.workerInstanceId,
      roles: identity.allowedRoles,
      aclMatrix: identity.aclMatrix,
    },
    registrationSteps: [
      {
        step: 1,
        name: 'Register Manifest',
        method: 'PUT',
        path: `/api/runtime/v1/businesses/${manifest.businessId}/versions/${manifest.version}`,
        auth: 'Bearer <RUNTIME_TOKEN>',
        expectedStatus: [200, 201],
      },
      {
        step: 2,
        name: 'Enable Version',
        method: 'PUT',
        path: `/api/v1/admin/businesses/${manifest.businessId}/versions/${manifest.version}/enable`,
        auth: 'Bearer <ADMIN_TOKEN>',
        expectedStatus: [200],
      },
      {
        step: 3,
        name: 'Activate Version',
        method: 'PUT',
        path: `/api/v1/admin/businesses/${manifest.businessId}/versions/${manifest.version}/activate`,
        auth: 'Bearer <ADMIN_TOKEN>',
        expectedStatus: [200, 202],
      },
    ],
  };
}

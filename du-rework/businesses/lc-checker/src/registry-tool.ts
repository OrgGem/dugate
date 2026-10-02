import { BusinessManifest, contentHash } from '@du/contracts';

import { lcCheckerManifest } from './manifest';

/**
 * Worker manifest registration against the platform Orchestrator.
 *
 * Follows the same three-step dynamic lifecycle example-review established:
 *   1. PUT /api/runtime/v1/businesses/:id/versions/:v        -> REGISTERED_DISABLED
 *   2. PUT /api/v1/admin/businesses/:id/versions/:v/enable   -> ENABLED
 *   3. PUT /api/v1/admin/businesses/:id/versions/:v/activate -> is_active
 *
 * Unlike the example-review tool this one does NOT ship a table of "frozen platform
 * digests". Those values are a claim that the platform binaries are bit-identical, and
 * inventing them here would be evidence nobody measured. A deployment that needs the claim
 * reads the digests from the built images.
 */

export interface RegisterLcCheckerOptions {
  readonly orchestratorUrl: string;
  readonly runtimeToken: string;
  readonly adminToken: string;
  readonly manifest?: BusinessManifest;
  readonly activate?: boolean;
  readonly fetchFn?: typeof fetch;
}

export interface RegisterLcCheckerResult {
  readonly businessId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly registered: boolean;
  readonly enabled: boolean;
  readonly activated: boolean;
  readonly queue: string;
  readonly registryUrl: string;
}

async function assertOk(response: Response, what: string, accepted: readonly number[]): Promise<void> {
  if (accepted.includes(response.status)) return;
  const detail = await response.text().catch(() => '');
  throw new Error(what + ' failed (HTTP ' + response.status + '): ' + detail);
}

export function expectedQueue(manifest: BusinessManifest = lcCheckerManifest): string {
  return 'du-business-' + manifest.businessId + '-' + manifest.version;
}

export async function registerLcCheckerWorker(
  options: RegisterLcCheckerOptions
): Promise<RegisterLcCheckerResult> {
  const fetcher = options.fetchFn ?? fetch;
  const manifest = options.manifest ?? lcCheckerManifest;
  const base = options.orchestratorUrl.replace(/\/+$/, '');
  const registryUrl = base + '/api/runtime/v1/businesses/' + manifest.businessId + '/versions/' + manifest.version;
  const manifestDigest = contentHash(manifest);

  const registered = await fetcher(registryUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.runtimeToken },
    body: JSON.stringify(manifest),
  });
  await assertOk(registered, 'Worker manifest registration', [200, 201]);
  const ack = (await registered.json().catch(() => ({}))) as { queue?: string };
  const queue = ack.queue ?? expectedQueue(manifest);

  const enabled = await fetcher(
    base + '/api/v1/admin/businesses/' + manifest.businessId + '/versions/' + manifest.version + '/enable',
    { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.adminToken } }
  );
  await assertOk(enabled, 'Worker enablement', [200]);

  let activated = false;
  if (options.activate !== false) {
    const activation = await fetcher(
      base + '/api/v1/admin/businesses/' + manifest.businessId + '/versions/' + manifest.version + '/activate',
      { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.adminToken } }
    );
    await assertOk(activation, 'Worker activation', [200, 202]);
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
    registryUrl,
  };
}

/** Build the registration plan without any network I/O. Safe to print in a receipt. */
export function buildRegistrationDryRun(manifest: BusinessManifest = lcCheckerManifest) {
  const base = 'http://orchestrator:3000';
  const prefix = '/' + manifest.businessId + '/versions/' + manifest.version;
  return {
    operation: 'P9-02 LC checker worker manifest registration (dry run)',
    businessId: manifest.businessId,
    version: manifest.version,
    queue: expectedQueue(manifest),
    manifestDigest: contentHash(manifest),
    connectorSlots: (manifest.actions[0]?.connectorSlots ?? []).map((slot) => slot.name),
    handlerKinds: [...manifest.runtime.handlerKinds],
    registrationSteps: [
      {
        step: 1,
        name: 'Register manifest',
        method: 'PUT',
        path: base + '/api/runtime/v1/businesses' + prefix,
        auth: 'Bearer <RUNTIME_TOKEN>',
        expectedStatus: [200, 201],
      },
      {
        step: 2,
        name: 'Enable version',
        method: 'PUT',
        path: base + '/api/v1/admin/businesses' + prefix + '/enable',
        auth: 'Bearer <ADMIN_TOKEN>',
        expectedStatus: [200],
      },
      {
        step: 3,
        name: 'Activate version',
        method: 'PUT',
        path: base + '/api/v1/admin/businesses' + prefix + '/activate',
        auth: 'Bearer <ADMIN_TOKEN>',
        expectedStatus: [200, 202],
      },
    ],
  };
}

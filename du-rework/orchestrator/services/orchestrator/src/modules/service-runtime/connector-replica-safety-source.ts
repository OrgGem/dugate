import {
  ConnectorReplicaControlAckSchema,
  ConnectorReplicaRuntimeObservationSchema,
  type ConnectorReplicaControlCommand,
  type ConnectorReplicaRuntimeReadRequest,
} from '@du/contracts';
import { HttpError } from '../../http/errors';
import type { ReplicaRuntimeSafetySource } from '../maintenance/replica-runtime-safety';

export interface ConnectorReplicaSafetySourceOptions {
  /** Exact trusted per-Connector URL selected from server configuration. */
  baseUrl: string;
  /** Mints a new short-lived connector:runtime-control JWT for each call. */
  authorizationForRequest(): string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function safeBaseUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('CONNECTOR_RUNTIME_CONTROL_URL_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash) throw new Error('CONNECTOR_RUNTIME_CONTROL_URL_INVALID');
  return parsed.toString().replace(/\/+$/, '');
}

function identity(input: Parameters<ReplicaRuntimeSafetySource['observe']>[0]): ConnectorReplicaRuntimeReadRequest | null {
  if (input.service !== 'connector') return null;
  return {
    slot: input.slot,
    runtimeIdentity: input.runtimeIdentity,
    replicaId: input.replicaId,
    revision: input.revision,
    imageDigest: input.imageDigest,
  };
}

export function createConnectorReplicaSafetySource(options: ConnectorReplicaSafetySourceOptions): ReplicaRuntimeSafetySource {
  const baseUrl = safeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;

  async function call(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: options.authorizationForRequest() },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function parsedObservation(body: ConnectorReplicaRuntimeReadRequest) {
    try {
      const response = await call('/internal/admin/runtime-control/observe', body);
      if (response.status !== 200) return null;
      const parsed = ConnectorReplicaRuntimeObservationSchema.safeParse(await response.json());
      if (!parsed.success) return null;
      return {
        ...parsed.data,
        work: {
          ...parsed.data.work,
          // Connector owns invocation counts; Orchestrator maintenance jobs
          // are not part of a Connector replica's work domain.
          maintenanceExecutions: { applicable: false as const, count: null },
        },
      };
    } catch { return null; }
  }

  async function control(
    path: '/drain' | '/resume',
    input: Parameters<ReplicaRuntimeSafetySource['requestDrain']>[0] | Parameters<ReplicaRuntimeSafetySource['requestResume']>[0],
  ) {
    if (input.service !== 'connector') throw new HttpError(404, 'NOT_FOUND', 'Connector replica not found');
    const command: ConnectorReplicaControlCommand = {
      slot: input.slot,
      runtimeIdentity: input.runtimeIdentity,
      replicaId: input.replicaId,
      revision: input.expectedRevision,
      expectedRevision: input.expectedRevision,
      imageDigest: input.expectedImageDigest,
      expectedImageDigest: input.expectedImageDigest,
      expectedControlRevision: input.expectedControlRevision,
      reason: input.reason,
    };
    let response: Response;
    try { response = await call(`/internal/admin/runtime-control${path}`, command); }
    catch { throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector runtime control is unavailable'); }
    if (response.status === 409) throw new HttpError(409, 'STATE_CONFLICT', 'Connector replica control revision changed');
    if (response.status !== 200) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector runtime control is unavailable');
    const parsed = ConnectorReplicaControlAckSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector runtime control response is invalid');
    return parsed.data;
  }

  return {
    async observe(input) {
      const request = identity(input);
      return request ? parsedObservation(request) : null;
    },
    requestDrain: (input) => control('/drain', input),
    requestResume: (input) => control('/resume', input),
  };
}

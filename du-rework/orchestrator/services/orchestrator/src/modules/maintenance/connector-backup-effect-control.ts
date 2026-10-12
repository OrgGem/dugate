import {
  ConnectorBackupEffectFenceCommandSchema,
  ConnectorBackupEffectFenceObservationRequestSchema,
  ConnectorBackupEffectFenceObservationSchema,
  type ConnectorBackupEffectFenceCommand,
  type ConnectorBackupEffectFenceObservation,
  type ConnectorBackupEffectFenceObservationRequest,
  type ConnectorReplicaIdentity,
} from '@du/contracts';
import type { ConnectorManagementAuthorizationProvider } from '../connectors/management-service-identity';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ConnectorBackupEffectTarget extends ConnectorReplicaIdentity {
  serviceId: string;
  controlBaseUrl: string;
}

export interface ConnectorBackupEffectControl {
  observe(target: ConnectorBackupEffectTarget, request: ConnectorBackupEffectFenceObservationRequest): Promise<ConnectorBackupEffectFenceObservation>;
  hold(target: ConnectorBackupEffectTarget, command: ConnectorBackupEffectFenceCommand): Promise<ConnectorBackupEffectFenceObservation>;
  release(target: ConnectorBackupEffectTarget, command: ConnectorBackupEffectFenceCommand): Promise<void>;
}

function unavailable(): Error { return new Error('CONNECTOR_BACKUP_EFFECT_CONTROL_UNAVAILABLE'); }

function endpoint(base: string, suffix: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
  url.pathname = suffix;
  return url.toString();
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map((part) => Buffer.from(part))).toString('utf8')) as unknown; }
  catch { throw unavailable(); }
}

export function createConnectorBackupEffectControl(input: {
  authorizationForRequest: ConnectorManagementAuthorizationProvider;
  fetchImpl?: typeof fetch;
}): ConnectorBackupEffectControl {
  const fetchImpl = input.fetchImpl ?? fetch;
  async function post<T>(target: ConnectorBackupEffectTarget, path: string, body: unknown): Promise<T> {
    let authorization: string;
    try { authorization = input.authorizationForRequest('connector:runtime-control'); }
    catch { throw unavailable(); }
    if (!authorization.startsWith('Bearer ') || authorization.length <= 7) throw unavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(endpoint(target.controlBaseUrl, path), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return await readJson(response) as T;
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  function checkTarget(target: ConnectorBackupEffectTarget): void {
    if (!target || !target.serviceId || target.runtimeIdentity !== target.replicaId) throw unavailable();
  }
  function identity(target: ConnectorBackupEffectTarget) {
    return { slot: target.slot, runtimeIdentity: target.runtimeIdentity, replicaId: target.replicaId,
      revision: target.revision, imageDigest: target.imageDigest };
  }
  function checkObservation(target: ConnectorBackupEffectTarget, value: unknown): ConnectorBackupEffectFenceObservation {
    const parsed = ConnectorBackupEffectFenceObservationSchema.safeParse(value);
    if (!parsed.success || parsed.data.slot !== target.slot || parsed.data.runtimeIdentity !== target.runtimeIdentity
      || parsed.data.replicaId !== target.replicaId || parsed.data.revision !== target.revision
      || parsed.data.imageDigest !== target.imageDigest) throw unavailable();
    return parsed.data;
  }
  return {
    async observe(target, request) {
      checkTarget(target);
      const parsedRequest = ConnectorBackupEffectFenceObservationRequestSchema.parse(request);
      if (parsedRequest.slot !== target.slot || parsedRequest.runtimeIdentity !== target.runtimeIdentity
        || parsedRequest.replicaId !== target.replicaId || parsedRequest.revision !== target.revision
        || parsedRequest.imageDigest !== target.imageDigest) throw unavailable();
      return checkObservation(target, await post(target, '/internal/admin/runtime-control/backup-effect-fence/observe', parsedRequest));
    },
    async hold(target, command) {
      checkTarget(target);
      const parsedCommand = ConnectorBackupEffectFenceCommandSchema.parse(command);
      if (parsedCommand.action !== 'HOLD' || parsedCommand.slot !== target.slot
        || parsedCommand.runtimeIdentity !== target.runtimeIdentity || parsedCommand.replicaId !== target.replicaId
        || parsedCommand.revision !== target.revision || parsedCommand.imageDigest !== target.imageDigest) throw unavailable();
      return checkObservation(target, await post(target, '/internal/admin/runtime-control/backup-effect-fence/hold', parsedCommand));
    },
    async release(target, command) {
      checkTarget(target);
      const parsedCommand = ConnectorBackupEffectFenceCommandSchema.parse(command);
      if (parsedCommand.action !== 'RELEASE' || parsedCommand.slot !== target.slot
        || parsedCommand.runtimeIdentity !== target.runtimeIdentity || parsedCommand.replicaId !== target.replicaId
        || parsedCommand.revision !== target.revision || parsedCommand.imageDigest !== target.imageDigest) throw unavailable();
      const value = await post<unknown>(target, '/internal/admin/runtime-control/backup-effect-fence/release', parsedCommand);
      if (!value || typeof value !== 'object' || (value as { released?: unknown }).released !== true
        || (value as { fenceRevision?: unknown }).fenceRevision !== parsedCommand.fenceRevision) throw unavailable();
    },
  };
}

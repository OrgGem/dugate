import { timingSafeEqual } from 'node:crypto';
import {
  OrchestratorIsolatedRestoreObservationSchema,
  OrchestratorServiceRuntimeControlCommandSchema,
  OrchestratorServiceRuntimeObservationSchema,
} from '@du/contracts';
import { HttpError, zodIssuesToProblem } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/service-runtime';
const ROUTES = new Set([`${PREFIX}/identity`, `${PREFIX}/observation`, `${PREFIX}/drain`, `${PREFIX}/resume`]);

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorize(ctx: RouteContext): void {
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const expected = ctx.config.serviceRuntime?.controlToken;
  const authorization = ctx.headers.authorization ?? '';
  if (!expected || !authorization.startsWith('Bearer ') || !constantTimeEquals(authorization.slice(7), expected)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'dedicated Orchestrator service-runtime identity is required');
  }
  if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'service-runtime control does not accept query parameters');
  if (!ctx.serviceRuntime) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'service-runtime control is not configured');
}

function parseCommand(body: unknown) {
  const parsed = OrchestratorServiceRuntimeControlCommandSchema.safeParse(body);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

export async function handleInternalServiceRuntimeRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (!ROUTES.has(ctx.pathname)) return null;
  authorize(ctx);
  const runtime = ctx.serviceRuntime!;
  if (ctx.pathname === `${PREFIX}/identity`) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'service-runtime identity requires GET');
    return { status: 200, body: { service: 'orchestrator', ...runtime.identity } };
  }
  if (ctx.pathname === `${PREFIX}/observation`) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'service-runtime observation requires GET');
    const identity = runtime.identity;
    const observation = await runtime.observeReplica({ ...identity, service: 'orchestrator', scope: { kind: 'platform' } });
    if (!observation) throw new HttpError(503, 'SERVICE_RUNTIME_UNAVAILABLE', 'service-runtime observation is unavailable or stale');
    const schema = ctx.config.isolatedRuntimeMode === 'restore-rehearsal'
      ? OrchestratorIsolatedRestoreObservationSchema
      : OrchestratorServiceRuntimeObservationSchema;
    const parsed = schema.safeParse(observation);
    if (!parsed.success) throw new HttpError(503, 'SERVICE_RUNTIME_UNAVAILABLE', 'service-runtime observation is incomplete');
    return { status: 200, body: parsed.data };
  }
  if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'service-runtime control requires POST');
  const command = parseCommand(ctx.body);
  const expectedAction = ctx.pathname.endsWith('/drain') ? 'drain' : 'resume';
  if (command.action !== expectedAction) throw new HttpError(422, 'INVALID_SCHEMA', 'control path does not match the command action');
  const input = {
    service: 'orchestrator' as const,
    slot: command.slot,
    runtimeIdentity: command.runtimeIdentity,
    replicaId: command.replicaId,
    expectedRevision: command.revision,
    expectedImageDigest: command.imageDigest,
    expectedControlRevision: command.expectedControlRevision,
    reason: command.reason,
  };
  const result = command.action === 'drain'
    ? await runtime.requestDrain(input)
    : await runtime.requestResume(input);
  return { status: 200, body: result };
}

import { readIdempotencyKey } from '../../modules/idempotency/idempotency';
import {
  adminWorkbenchPrincipal,
  previewProfileGroupV2,
  submitProfileGroupV2,
  submitProfileEndpointTest,
  submitPromptWizard,
} from '../../modules/admin-workbench/service';
import { resolveAdminActionAuthAsync } from '../../modules/admin-actions/rbac';
import { HttpError } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/admin-workbench';

export async function handleInternalAdminWorkbenchRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Admin workbench operations require POST');
  if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Admin workbench operations do not accept query parameters');
  const auth = await resolveAdminActionAuthAsync(ctx.config, ctx.headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (auth.kind === 'cookie' && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  // Viewer denial happens before parsing user data or touching any service.
  adminWorkbenchPrincipal(auth);
  const idempotencyKey = readIdempotencyKey(ctx.headers);
  const suffix = ctx.pathname.slice(PREFIX.length);
  if (suffix === '/test-endpoint') {
    return { status: 202, body: await submitProfileEndpointTest(ctx, auth, ctx.body, idempotencyKey) };
  }
  if (suffix === '/prompt-wizard') {
    return { status: 202, body: await submitPromptWizard(ctx, auth, ctx.body, idempotencyKey) };
  }
  // PC-05: v2 profile-group preview/submit. Same admin session/CSRF/tenant
  // gates as the v1 suffixes above; the group is derived from the explicitly
  // selected key, never chosen from the group list.
  if (suffix === '/v2/preview') {
    return { status: 200, body: await previewProfileGroupV2(ctx, auth, ctx.body) };
  }
  if (suffix === '/v2/submit') {
    return { status: 202, body: await submitProfileGroupV2(ctx, auth, ctx.body, idempotencyKey) };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Admin workbench route was not found');
}

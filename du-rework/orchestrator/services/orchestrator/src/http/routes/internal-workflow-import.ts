import { WorkflowImportPreviewRequestSchema } from '@du/contracts';
import { previewWorkflowImport } from '../../modules/workflow-import/preview';
import { resolveAdminActionAuthAsync } from '../../modules/admin-actions/rbac';
import { adminWorkbenchPrincipal } from '../../modules/admin-workbench/service';
import { HttpError } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/workflow-import';

export async function handleInternalWorkflowImportRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  if (ctx.pathname !== `${PREFIX}/preview`) throw new HttpError(404, 'NOT_FOUND', 'workflow import route was not found');
  if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'workflow import preview requires POST');
  if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow import preview does not accept query parameters');

  const auth = await resolveAdminActionAuthAsync(ctx.config, ctx.headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (auth.kind === 'cookie' && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  const principal = adminWorkbenchPrincipal(auth);
  const parsed = WorkflowImportPreviewRequestSchema.safeParse(ctx.body);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow import source is invalid or exceeds the 512 KiB bound');
  if (principal.role === 'tenant_operator' && principal.tenantId !== parsed.data.tenantId) {
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  }
  return { status: 200, body: previewWorkflowImport(parsed.data) };
}

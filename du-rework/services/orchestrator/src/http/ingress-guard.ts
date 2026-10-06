/**
 * PM-M02-ROUTE: the ingress audience fence between the two JSON listeners.
 *
 * A caller-supplied header cannot establish ingress identity, so each server
 * closure passes a LITERAL audience (`public` or `internal`) into request
 * handling. Nothing in here reads Host, Forwarded, X-Forwarded-*, a bearer type,
 * a query parameter or a remote address.
 */
import { HttpError } from './errors';

export type IngressAudience = 'public' | 'internal';

/**
 * Whether the PUBLIC listener may dispatch this normalized pathname.
 *
 * Rule order matters: `/api/v1/admin` is a descendant of `/api/v1`, so the
 * admin exclusion runs BEFORE the broader public-prefix check. Deny returns a
 * standard generic 404 for every method, valid privileged credential or not —
 * never a distinguishable 403, and never a hint that the route exists.
 */
export function isPublicIngressAllowed(pathname: string): boolean {
  // Health stays on both listeners (wire behavior unchanged by this packet).
  if (pathname === '/health' || pathname === '/api/v1/health') return true;

  // Deny families first — in this order: admin, runtime, internal, unknown.
  if (pathname === '/api/v1/admin' || pathname.startsWith('/api/v1/admin/')) return false;
  if (pathname === '/api/runtime' || pathname.startsWith('/api/runtime/')) return false;
  if (pathname === '/api/internal' || pathname.startsWith('/api/internal/')) return false;

  // The public family only. Anything else is not a public surface.
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

/**
 * The guard. `internal` never denies here: the internal listener keeps public,
 * admin and runtime handlers available, and each handler still enforces its own
 * API-key / admin / business / usage / Connector authorization.
 */
export function assertIngressAllowed(audience: IngressAudience, pathname: string): void {
  if (audience === 'internal') return;
  if (isPublicIngressAllowed(pathname)) return;
  // HttpError so the listener boundary renders the STANDARD generic 404
  // problem response. A plain Error would be classified as an unexpected
  // exception and answered 500 — wrong status, and it would log a listener
  // error for a request that is simply not public.
  throw new HttpError(404, 'NOT_FOUND', 'Not Found');
}

/**
 * Boots the Admin shell sub-server on an OS-assigned port with the
 * W47-O stub fetchers. Returns the resolved URL so the Playwright
 * spec can `goto()` it.
 *
 * NO DB, NO Redis, NO platform HTTP.
 */

import {
  createAdminShellServer,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';
import type { AdminShellHandle } from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';
import { stubFetchers } from './stubs';

export interface HarnessHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHarness(): Promise<HarnessHandle> {
  // The bare token (no `role:<r>:` prefix) is the adminToken per the
  // shell's `deriveRoleFromToken` semantics (shell-router.js:113-130):
  //   - `presented === adminToken` → role=admin (exact match)
  //   - `presented === role:<roleStr>:<value>` AND `value === adminToken`
  //     → role=roleStr (parsed)
  // Previously we set `adminToken = 'role:admin:harness-secret-token'`,
  // which made admin exact-match work but caused operator/viewer
  // logins to fall through to the parser where `value !== adminToken`,
  // returning 401 for every non-admin interaction test. Setting
  // `adminToken = 'harness-secret-token'` lets the parser branch
  // succeed for all three roles; the admin exact-match branch is
  // never reached for `role:admin:harness-secret-token` (it takes the
  // parsed path instead — same result).
  const adminToken = 'harness-secret-token';
  const handle: AdminShellHandle = createAdminShellServer({
    port: 0,
    host: '127.0.0.1',
    cookieSecret: 'harness-cookie-secret-32-bytes-or-more',
    adminToken,
    sectionFetchers: stubFetchers,
  });
  const { url } = await handle.listen();
  return {
    url,
    port: handle.port,
    close: () => handle.close(),
  };
}

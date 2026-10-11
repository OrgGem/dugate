# AWEB08 restore default admin-web path — smoke receipt

Started (UTC): 2026-10-08 17:43:16.
Scope: du-rework only. Source lease: orchestrator/services/orchestrator/src/app/admin/shell-server.ts.

## Fail-first

Cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
Command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb08-per-route-flag.test.ts
Exit code: 1
Literal failure summary:
~~~text
FAIL tests/aweb08-per-route-flag.test.ts
  ● AWEB-08-prep per-route rollout flag › partial allow-list → listed routes 200; others one consistent 404 with legacy link
    Expected: 200
    Received: 404
  ● AWEB-08-prep per-route rollout flag › unknown names are dropped; the rest of the list still applies
    Expected: 200
    Received: 404
  ● AWEB-08-prep per-route rollout flag › deliberately empty list (commas only) gates everything but the root
    Expected: 200
    Received: 404
Test Suites: 1 failed, 1 total
Tests:       3 failed, 4 passed, 7 total
Ran all test suites matching tests/aweb08-per-route-flag.test.ts.
JEST_EXIT=1
~~~

## Change and checks

Only the requested default was changed relative to the starting worktree:
~~~diff
-const DEFAULT_ADMIN_WEB_PATH = 'admin';
+const DEFAULT_ADMIN_WEB_PATH = '/admin/web';
~~~
The BFF dispatch remains before the admin-web handler, and isAdminWebPath still excludes isBffPath routes.

Post-change test command (same cwd): node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb08-per-route-flag.test.ts
Exit code: 0
Literal result:
~~~text
Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
Ran all test suites matching tests/aweb08-per-route-flag.test.ts.
JEST_EXIT=0
~~~

Typecheck command (same cwd): node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Exit code: 0
Literal result: TSC_EXIT=0; no diagnostics.

Current git diff -- du-rework/orchestrator/services/orchestrator/src/app/admin/shell-server.ts against HEAD follows. The task's default constant now matches HEAD, so it is shown separately above. Remaining hunks are worktree changes already present before this task; BFF order and isBffPath guard are preserved.
~~~diff
diff --git a/du-rework/orchestrator/services/orchestrator/src/app/admin/shell-server.ts b/du-rework/orchestrator/services/orchestrator/src/app/admin/shell-server.ts
index 2879ef5..827a548 100644
--- a/du-rework/orchestrator/services/orchestrator/src/app/admin/shell-server.ts
+++ b/du-rework/orchestrator/services/orchestrator/src/app/admin/shell-server.ts
@@ -129,7 +129,7 @@ export interface CreateAdminShellServerOptions {
    * Default OFF: when neither this option nor the `DU_ADMIN_WEB` env flag is
    * set the route does not exist and the legacy rendered shell is untouched.
    * Tests inject here; the platform uses the env flag
-   * (`DU_ADMIN_WEB=1` → `/admin/web`, or `DU_ADMIN_WEB=/path`).
+   * (`DU_ADMIN_WEB=1` → `admin`, or `DU_ADMIN_WEB=/path`).
    */
   adminWeb?: AdminWebMountOptions;
   /**
@@ -297,9 +297,9 @@ function writeResponse(res: ServerResponse, payload: AdminShellResponse, correla
 // it is unset nothing changes for the legacy routes.
 //
 // Serving contract:
-//   - `/admin/web`, `/admin/web/`, and any non-asset deep link -> index.html,
+//   - `admin`, `admin/`, and any non-asset deep link -> index.html,
 //     `cache-control: no-store`, strict CSP, and the session gate above.
-//   - `/admin/web/assets/<hashed-file>` -> immutable (max-age 1 year), a small
+//   - `admin/assets/<hashed-file>` -> immutable (max-age 1 year), a small
 //     content-type allow-list; a missing asset is a 404 (never the SPA HTML).
 //   - No session -> 302 to `/admin/login` (same destination as the rendered
 //     shell's protected-route gate).
@@ -308,7 +308,7 @@ function writeResponse(res: ServerResponse, payload: AdminShellResponse, correla
 
 /** Options for the static Admin Web mount (Vite build served by this shell). */
 export interface AdminWebMountOptions {
-  /** URL path prefix. Default: `/admin/web`. */
+  /** URL path prefix. Default: `admin`. */
   path?: string;
   /** Absolute directory holding the Vite build (index.html + assets/). */
   distDir: string;
@@ -336,7 +336,7 @@ const ADMIN_WEB_ROUTE_NAMES = [
   'overview',
   'profiles',
   // Swagger UI surface. Recognised so a deployment can opt into
-  // /admin/web/api-docs via DU_ADMIN_WEB_ROUTES without the name being
+  // admin/api-docs via DU_ADMIN_WEB_ROUTES without the name being
   // dropped as unknown (and the route answering the generic 404).
   'api-docs',
   'api-keys',
@@ -477,6 +477,9 @@ function resolveAdminWebMount(
 }
 
 function isAdminWebPath(pathname: string, base: string): boolean {
+  if (isBffPath(pathname) || pathname === '/admin/login' || pathname === '/admin/logout') {
+    return false;
+  }
   return pathname === base || pathname.startsWith(base + '/');
 }
 
@@ -811,11 +814,6 @@ export function createAdminShellServer(
       const qIdx = url.indexOf('?');
       const pathname = qIdx < 0 ? url : url.slice(0, qIdx);
       const query = qIdx < 0 ? '' : url.slice(qIdx + 1);
-      if (adminWebMount && isAdminWebPath(pathname, adminWebMount.path)) {
-        lastRouteId = 'admin-web';
-        await handleAdminWebRequest(req, res, pathname, adminWebMount, config, correlationId);
-        return;
-      }
       if (adminWebMount && isBffPath(pathname)) {
         lastRouteId = 'admin-bff';
         const bffRequest = buildRequest(req, pathname, query, '');
@@ -830,6 +828,11 @@ export function createAdminShellServer(
         );
         return;
       }
+      if (adminWebMount && isAdminWebPath(pathname, adminWebMount.path)) {
+        lastRouteId = 'admin-web';
+        await handleAdminWebRequest(req, res, pathname, adminWebMount, config, correlationId);
+        return;
+      }
       const bodyText =
         (req.method ?? 'GET').toUpperCase() === 'POST' ? await readBody(req) : '';
       const request = buildRequest(req, pathname, query, bodyText);
~~~

This is a smoke receipt for independent review; it does not claim verification complete. No commit, git add, push, or edits outside the source lease and this requested receipt were made.


# Admin Web local Vite process

Run `.orchestrator\apps\admin-web\scripts\start-local.ps1` from PowerShell or `bash orchestrator/apps/admin-web/scripts/start-local.sh` from the `du-rework` root. This starts the Vite development server at `http://127.0.0.1:5173/admin/`; it does not build or start Orchestrator.

Start Orchestrator first with its Admin Shell/BFF enabled (`DU_ADMIN_WEB=1`) on port 3001. This launcher proxies `/admin/api/*`, `/admin/login`, `/admin/logout`, and `/admin/oidc/callback` to `http://127.0.0.1:3001`, preserving the app's same-origin session-cookie and CSRF design. It does not send platform tokens from the browser. The public API is on 3000 and the internal Runtime API on 3002; Redis is 6379 and Connector is 8080. The browser uses the 3001 BFF and does not connect directly to those service ports.

The Vite process uses `PORT=5173` and binds to loopback. If the Admin Shell is not running, static UI routes may load but BFF/auth calls will fail until port 3001 is available. Configure authentication and backend secrets in the root `.env.local` used by Orchestrator; this Vite launcher does not load or expose that file.

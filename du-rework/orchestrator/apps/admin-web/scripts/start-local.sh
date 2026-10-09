#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$PROJECT_DIR"
while [[ ! -f "$WORKSPACE_ROOT/pnpm-workspace.yaml" ]]; do
  PARENT="$(dirname "$WORKSPACE_ROOT")"
  [[ "$PARENT" != "$WORKSPACE_ROOT" ]] || { echo 'Could not find the du-rework workspace root.' >&2; exit 1; }
  WORKSPACE_ROOT="$PARENT"
done

export PORT=5173
export HOST=127.0.0.1
export ORCHESTRATOR_PORT=3000
export ORCHESTRATOR_HOST=127.0.0.1
export ORCHESTRATOR_INTERNAL_PORT=3002
export ORCHESTRATOR_INTERNAL_HOST=127.0.0.1
export ORCHESTRATOR_INTERNAL_BASE_URL=http://127.0.0.1:3002
export ADMIN_SHELL_PORT=3001
export ADMIN_SHELL_HOST=127.0.0.1
export ADMIN_SHELL_BASE_URL=http://127.0.0.1:3001
export RUNTIME_URL=http://127.0.0.1:3002/api/runtime/v1
export CONNECTOR_PORT=8080
export CONNECTOR_URL=http://127.0.0.1:8080
export REDIS_URL=redis://127.0.0.1:6379

echo 'Admin Web: http://127.0.0.1:5173/admin/'
echo 'BFF and auth proxy target: http://127.0.0.1:3001'
cd "$PROJECT_DIR"
exec node --input-type=module - <<'NODE'
import { createServer } from 'vite';

const target = process.env.ADMIN_SHELL_BASE_URL;
const paths = ['/admin/api', '/admin/login', '/admin/logout', '/admin/oidc/callback'];
const proxy = Object.fromEntries(paths.map((route) => [route, { target, changeOrigin: false }]));
const server = await createServer({
  configFile: 'vite.config.ts',
  server: {
    host: process.env.HOST,
    port: Number(process.env.PORT),
    strictPort: true,
    proxy,
  },
});

await server.listen();
server.printUrls();
console.log(`Admin BFF/auth requests proxy to ${target}.`);
const closed = new Promise((resolve) => server.httpServer?.once('close', resolve));
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  void server.close().catch((error) => {
    console.error('Admin Web shutdown failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await closed;
NODE

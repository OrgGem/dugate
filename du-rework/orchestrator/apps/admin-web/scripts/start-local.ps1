$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkspaceRoot = $ProjectDir
while ($WorkspaceRoot -and -not (Test-Path -LiteralPath (Join-Path $WorkspaceRoot 'pnpm-workspace.yaml'))) {
  $WorkspaceRoot = Split-Path -Parent $WorkspaceRoot
}
if (-not $WorkspaceRoot) { throw 'Could not find the du-rework workspace root.' }

$env:PORT = '5173'
$env:HOST = '127.0.0.1'
$env:ORCHESTRATOR_PORT = '3000'
$env:ORCHESTRATOR_HOST = '127.0.0.1'
$env:ORCHESTRATOR_INTERNAL_PORT = '3002'
$env:ORCHESTRATOR_INTERNAL_HOST = '127.0.0.1'
$env:ORCHESTRATOR_INTERNAL_BASE_URL = 'http://127.0.0.1:3002'
$env:ADMIN_SHELL_PORT = '3001'
$env:ADMIN_SHELL_HOST = '127.0.0.1'
$env:ADMIN_SHELL_BASE_URL = 'http://127.0.0.1:3001'
$env:RUNTIME_URL = 'http://127.0.0.1:3002/api/runtime/v1'
$env:CONNECTOR_PORT = '8080'
$env:CONNECTOR_URL = 'http://127.0.0.1:8080'
$env:REDIS_URL = 'redis://127.0.0.1:6379'

Write-Host 'Admin Web: http://127.0.0.1:5173/admin/'
Write-Host 'BFF and auth proxy target: http://127.0.0.1:3001'
$Bootstrap = @'
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
'@
Push-Location $ProjectDir
try {
  $Bootstrap | & node --input-type=module -
  $ServiceExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $ServiceExitCode

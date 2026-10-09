const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const orchestratorRoot = path.resolve(__dirname, '../../..');
const appShellPath = path.join(orchestratorRoot, 'apps/admin-web/src/app-shell/app-shell.tsx');
const toastPath = path.join(orchestratorRoot, 'apps/admin-web/src/components/ui/toast.tsx');
const appShell = fs.readFileSync(appShellPath, 'utf8');
const toast = fs.existsSync(toastPath) ? fs.readFileSync(toastPath, 'utf8') : '';
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

check(/export function ToastProvider\b/.test(toast), 'toast.tsx must export ToastProvider');
check(/export function useToast\b/.test(toast), 'toast.tsx must export useToast');
check(/export function ToastViewport\b/.test(toast), 'toast.tsx must export ToastViewport');
check(/success\s*\(/.test(toast) && /error\s*\(/.test(toast), 'toast hook must expose success and error feedback');
check(/role="status"|role="alert"/.test(toast), 'toast messages must have an accessible announcement role');
check(/export class GlobalErrorBoundary\b/.test(toast), 'toast.tsx must export a global render error boundary');
check(/getDerivedStateFromError/.test(toast), 'error boundary must capture render errors');
check(/this\.state\.errorMessage\s*\?\?\s*'Unavailable'/.test(toast), 'error boundary must show the error message or Unavailable');
check(!/error\.stack|stackTrace/.test(toast), 'error boundary must not render a fake stack');
check(/<GlobalErrorBoundary\b/.test(appShell), 'AppShell must mount the global error boundary');
check(/<ToastProvider\b/.test(appShell), 'AppShell must mount the toast provider around screens');
check(/<GlobalErrorBoundary>[\s\S]*<ToastProvider>[\s\S]*<AppShellContent\s*\/>[\s\S]*<\/ToastProvider>[\s\S]*<\/GlobalErrorBoundary>/.test(appShell), 'boundary must wrap the shell and provider must wrap its content');
check(/aria-label="System health"/.test(appShell), 'AppShell must keep the Lane A health strip');
check(/<Outlet\s*\/>/.test(appShell), 'AppShell must keep routed screens mounted');

process.stdout.write(`PASS admin toast/error boundary offline harness (${assertions} assertions)\n`);

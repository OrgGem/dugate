/** @type {import('jest').Config} */
// Offline unit config (R2-A): excludes the suites that boot the real app
// against PG :5433 / Redis :6380 (the DB-window protocol). Patterns are
// separator-free on purpose — test paths use backslashes on Windows.
const base = require('./jest.config.cjs');

/** @type {string[]} */
const liveSuites = [
  'admin-action-rbac-live\\.test\\.ts$',
  'admin-audit\\.test\\.ts$',
  'admin-base-routes\\.test\\.ts$',
  'admin-error-boundary\\.test\\.ts$',
  'admin-shell-live-pane\\.test\\.ts$',
  'artifact-grant-fencing\\.test\\.ts$',
  'artifacts-fencing-pg\\.test\\.ts$',
  'blob-wire-binary\\.test\\.ts$',
  'ingress-bounded\\.test\\.ts$',
  'migrations\\.test\\.ts$',
  'operation-tenant-fence\\.test\\.ts$',
  'runtime\\.test\\.ts$',
  'usage-summary\\.test\\.ts$',
  'webhook-reclaim-fence\\.live\\.test\\.ts$',
  'workspace-reference\\.test\\.ts$',
];

module.exports = {
  ...base,
  testPathIgnorePatterns: liveSuites,
};

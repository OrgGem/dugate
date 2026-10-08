const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const logName = process.argv[2] ?? 'harness-readiness-node24-2026-10-07.log';
if (!/^[A-Za-z0-9._-]+\.log$/.test(logName)) {
  throw new Error('log filename must be a simple .log name');
}
const jestArgs = [
  'node_modules/.pnpm/node_modules/jest/bin/jest.js',
  '--config',
  'tests/workflow-api/jest.config.cjs',
  '--runInBand',
  ...process.argv.slice(3),
];
const run = spawnSync(process.execPath, jestArgs, {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: process.env,
  // The full WFA suite can emit >1 MiB of output (ajv/stack traces). Node's
  // default maxBuffer (~1 MiB) kills the child and truncates the receipt
  // without a 'Tests:' summary, which looks like a test failure. 64 MiB
  // keeps the receipt complete for the current and near-future suites.
  maxBuffer: 64 * 1024 * 1024,
});
const exitCode = run.status ?? 1;
const receipt = [
  `cwd: ${process.cwd()}`,
  `node: ${process.version}`,
  `command: node ${jestArgs.join(' ')}`,
  '',
  'stdout:',
  run.stdout ?? '',
  'stderr:',
  run.stderr ?? '',
  // A spawn-level error (e.g. an overrun buffer or a failed exec) is a
  // harness failure, not a test failure; surface it instead of silently
  // reporting exit 1 with no summary.
  ...(run.error ? [`spawnError: ${run.error.message}`] : []),
  `exit: ${exitCode}`,
].join('\n');
const logPath = path.join(process.cwd(), 'tests/workflow-api/logs', logName);
fs.writeFileSync(logPath, receipt, 'utf8');
process.stdout.write(receipt);
process.exitCode = exitCode;

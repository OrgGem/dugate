const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = ['--filter', '@du/orchestrator', 'test', '--', 'tests/enc-meta-sentinel-outbox-source-url.test.ts'];
const result = spawnSync('pnpm', args, { cwd: process.cwd(), encoding: 'utf8', shell: true });
const code = typeof result.status === 'number' ? result.status : 1;
const body = [`COMMAND=pnpm ${args.join(' ')}`, `STDOUT:\n${result.stdout ?? ''}`, `STDERR:\n${result.stderr ?? ''}`, `LITERAL_EXIT_CODE=${code}`, result.error ? `SPAWN_ERROR=${result.error.message}` : ''].filter(Boolean).join('\n\n');
fs.writeFileSync('coordination/reports/raw/vfy-counter-fixes-808-outbox-writer-suite.txt', body, 'utf8');
console.log(`outbox_writer_suite_exit=${code}`);
process.exitCode = code;
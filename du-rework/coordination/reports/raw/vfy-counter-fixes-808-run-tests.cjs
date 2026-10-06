const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const tests = ['gate-authenticate-808.test.ts', 'legacy-payload-migration.test.ts'];
let failed = false;
for (let run = 1; run <= 3; run += 1) {
  for (const test of tests) {
    const args = ['--filter', '@du/orchestrator', 'test', '--', `tests/${test}`];
    const result = spawnSync('pnpm', args, { cwd: process.cwd(), encoding: 'utf8', shell: true });
    const code = typeof result.status === 'number' ? result.status : 1;
    const file = path.join('coordination', 'reports', 'raw', `vfy-counter-fixes-808-${test.replace('.test.ts', '')}-run${run}.txt`);
    const body = [
      `COMMAND=pnpm ${args.join(' ')}`,
      `STDOUT:\n${result.stdout ?? ''}`,
      `STDERR:\n${result.stderr ?? ''}`,
      `LITERAL_EXIT_CODE=${code}`,
      result.error ? `SPAWN_ERROR=${result.error.message}` : '',
    ].filter(Boolean).join('\n\n');
    fs.writeFileSync(file, body, 'utf8');
    console.log(`${test} run${run} exit=${code}`);
    if (code !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
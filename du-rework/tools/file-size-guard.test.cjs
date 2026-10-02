'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  classifyPath,
  countPhysicalLines,
  evaluateCounts,
  GRANDFATHERED_DEBT,
} = require('./file-size-guard.cjs');

test('LF and CRLF files with the same content have the same physical line count', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'du-file-size-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const lfPath = path.join(directory, 'lf.ts');
  const crlfPath = path.join(directory, 'crlf.ts');
  fs.writeFileSync(lfPath, 'first\nsecond\nthird');
  fs.writeFileSync(crlfPath, 'first\r\nsecond\r\nthird');

  const lfCount = countPhysicalLines(fs.readFileSync(lfPath, 'utf8'));
  const crlfCount = countPhysicalLines(fs.readFileSync(crlfPath, 'utf8'));
  assert.equal(lfCount, 3);
  assert.equal(crlfCount, 3);
});

test('tracked build outputs and generated/history paths have explicit exclusions', () => {
  assert.deepEqual(classifyPath('services/orchestrator/node_modules/x.ts'), {
    kind: 'excluded-directory',
    id: 'node_modules',
  });
  assert.deepEqual(classifyPath('docs/21-openapi.json'), {
    kind: 'allowlist',
    id: 'generated-openapi',
  });
  assert.deepEqual(classifyPath('coordination/reports/receipt.ts'), {
    kind: 'allowlist',
    id: 'reports-history',
  });
  assert.deepEqual(classifyPath('coordination/coordinator-state.json'), {
    kind: 'allowlist',
    id: 'state-json',
  });
});

test('baseline debts do not fail, while an unallowlisted oversize or cleared debt regrowth does', () => {
  const baselineCounts = new Map([
    ...GRANDFATHERED_DEBT.entries(),
    ['services/orchestrator/src/new-route.ts', 2001],
  ]);
  const baselineResult = evaluateCounts(baselineCounts);
  assert.equal(baselineResult.oversized.length, 4);
  assert.equal(baselineResult.failures.length, 1);
  assert.equal(baselineResult.failures[0].file, 'services/orchestrator/src/new-route.ts');

  const clearedFileRegrowth = evaluateCounts(
    new Map([['services/orchestrator/tests/admin-shell-render.test.ts', 2001]]),
  );
  assert.equal(clearedFileRegrowth.failures.length, 1);

  const clearedDebtRegrowth = evaluateCounts(
    new Map([['services/orchestrator/src/server.ts', 2001]]),
    new Map(),
  );
  assert.equal(clearedDebtRegrowth.failures.length, 1);
});

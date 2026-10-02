#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WARN_LINES = 1500;
const FAIL_LINES = 2000;

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.sql', '.ps1', '.sh', '.go', '.rs',
]);

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.cache', '__pycache__',
]);

// These are existing, reviewed debts. Remove a path from this list in the
// same change that takes it below 2,001 lines; a later crossing then fails.
// The stored count records the baseline receipt and is not a maximum: existing
// debt is reported but does not fail the whole repository before refactoring.
const PLAN_BASELINE_COUNTS = new Map([
  ['services/orchestrator/src/server.ts', 4299],
  ['services/orchestrator/tests/runtime.test.ts', 3869],
  ['services/orchestrator/tests/admin-shell-render.test.ts', 2815],
  ['businesses/document-core/tests/multi-container-e2e.integration.test.ts', 2261],
  ['services/orchestrator/tests/admin-operations-list-pagination.test.ts', 2031],
]);

// Current exemptions are a subset of the original plan snapshot. These two
// paths were already cleared in the working tree: one is below threshold and
// one was deleted. They intentionally no longer receive grandfathering, so a
// later reappearance above 2,000 lines is caught as a regression.
const GRANDFATHERED_DEBT = new Map([
  ['services/orchestrator/src/server.ts', 4299],
  ['services/orchestrator/tests/runtime.test.ts', 3869],
  ['businesses/document-core/tests/multi-container-e2e.integration.test.ts', 2261],
]);

// Exact/prefix allowlist for tracked generated or historical artifacts. The
// guard prints counts for every category so exclusions are visible in output.
const ALLOWLIST = [
  {
    id: 'lockfiles',
    reason: 'dependency lock/history, not hand-authored application code',
    matches: (file) => /(^|\/)([^/]+\.lock|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/i.test(file),
  },
  {
    id: 'generated-openapi',
    reason: 'generated OpenAPI snapshot',
    matches: (file) => file === 'docs/21-openapi.json',
  },
  {
    id: 'reports-history',
    reason: 'coordination receipts and historical reports',
    matches: (file) => file.startsWith('coordination/reports/'),
  },
  {
    id: 'state-json',
    reason: 'generated coordination state',
    matches: (file) => new Set([
      'coordination/agent-watch-state.json',
      'coordination/coordinator-schedule-state.json',
      'coordination/coordinator-state.json',
    ]).has(file),
  },
  {
    id: 'generated-inventory',
    reason: 'generated test inventory',
    matches: (file) => file === 'docs/28-test-inventory.md',
  },
];

function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const separators = text.match(/\r\n|\n|\r/g);
  const separatorCount = separators ? separators.length : 0;
  return separatorCount + (/\r\n$|\n$|\r$/.test(text) ? 0 : 1);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classifyPath(relativePath) {
  const file = relativePath.replaceAll('\\', '/');
  const allowed = ALLOWLIST.find((entry) => entry.matches(file));
  if (allowed) return { kind: 'allowlist', id: allowed.id };

  const segments = file.split('/');
  const excludedDirectory = segments.find((segment) => EXCLUDED_DIRECTORIES.has(segment));
  if (excludedDirectory) return { kind: 'excluded-directory', id: excludedDirectory };

  if (!CODE_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) {
    return { kind: 'non-code' };
  }
  return { kind: 'code' };
}

function evaluateCounts(fileCounts, legacyDebt = GRANDFATHERED_DEBT) {
  const warnings = [];
  const oversized = [];
  const failures = [];

  for (const [file, lines] of [...fileCounts].sort(([left], [right]) => compareStrings(left, right))) {
    if (lines >= WARN_LINES) warnings.push({ file, lines });
    if (lines > FAIL_LINES) {
      const debt = legacyDebt.has(file);
      const entry = { file, lines, baseline: debt ? legacyDebt.get(file) : undefined, debt };
      oversized.push(entry);
      if (!debt) failures.push(entry);
    }
  }
  return { warnings, oversized, failures };
}

function readTrackedPaths() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function runGuard() {
  const paths = readTrackedPaths();
  const categoryCounts = new Map(ALLOWLIST.map(({ id }) => [id, 0]));
  const excludedDirectoryCounts = new Map([...EXCLUDED_DIRECTORIES].map((id) => [id, 0]));
  let nonCodeCount = 0;
  let codeCount = 0;
  const missingPaths = [];
  const fileCounts = new Map();

  for (const relativePath of paths) {
    const classification = classifyPath(relativePath);
    if (classification.kind === 'allowlist') {
      categoryCounts.set(classification.id, categoryCounts.get(classification.id) + 1);
      continue;
    }
    if (classification.kind === 'excluded-directory') {
      excludedDirectoryCounts.set(classification.id, excludedDirectoryCounts.get(classification.id) + 1);
      continue;
    }
    if (classification.kind === 'non-code') {
      nonCodeCount += 1;
      continue;
    }

    const absolutePath = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      missingPaths.push(relativePath.replaceAll('\\', '/'));
      continue;
    }
    const text = fs.readFileSync(absolutePath, 'utf8');
    fileCounts.set(relativePath.replaceAll('\\', '/'), countPhysicalLines(text));
    codeCount += 1;
  }

  const result = evaluateCounts(fileCounts);
  console.log(`Tracked hand-authored code files: ${codeCount}`);
  console.log(`Ignored tracked non-code extensions: ${nonCodeCount}`);
  console.log('Ignored tracked allowlist (category: count — reason):');
  for (const entry of ALLOWLIST) {
    console.log(`  ${entry.id}: ${categoryCounts.get(entry.id)} — ${entry.reason}`);
  }
  console.log('Ignored tracked generated/build directories:');
  for (const [directory, count] of [...excludedDirectoryCounts].sort(([a], [b]) => compareStrings(a, b))) {
    console.log(`  ${directory}: ${count}`);
  }
  if (missingPaths.length > 0) {
    console.log(`Tracked code files absent from working tree (deleted/unreadable): ${missingPaths.length}`);
    for (const missingPath of missingPaths.sort(compareStrings)) console.log(`  ${missingPath}`);
  }
  console.log('Original plan baseline entries (baseline -> current working tree):');
  const trackedPathSet = new Set(paths.map((file) => file.replaceAll('\\', '/')));
  for (const [file, baselineLines] of [...PLAN_BASELINE_COUNTS].sort(([left], [right]) => compareStrings(left, right))) {
    const currentLines = fileCounts.get(file);
    if (currentLines !== undefined) {
      const state = currentLines > FAIL_LINES
        ? (GRANDFATHERED_DEBT.has(file) ? 'grandfathered legacy debt' : 'unallowlisted; threshold regression')
        : (GRANDFATHERED_DEBT.has(file) ? 'below threshold; retire stale exemption with refactor' : 'cleared; regrowth is guarded');
      console.log(`  ${baselineLines} -> ${currentLines} lines (${state}): ${file}`);
    } else {
      const state = trackedPathSet.has(file) ? 'missing from working tree' : 'not tracked/eligible';
      console.log(`  ${baselineLines} -> unavailable (${state}): ${file}`);
    }
  }

  console.log(`Warnings (>= ${WARN_LINES} lines): ${result.warnings.length}`);
  for (const warning of result.warnings) {
    const oversized = result.oversized.find((entry) => entry.file === warning.file);
    const tag = oversized ? (oversized.debt ? 'baseline debt, grandfathered' : 'FAIL: new oversize') : 'WARN';
    console.log(`  ${tag}: ${warning.lines} ${warning.lines === 1 ? 'line' : 'lines'} — ${warning.file}`);
  }
  console.log(`Files over ${FAIL_LINES} lines: ${result.oversized.length}`);
  if (result.failures.length > 0) {
    console.error(`FAIL: ${result.failures.length} new file(s) exceed ${FAIL_LINES} lines.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: no new files exceed ${FAIL_LINES} lines; ${result.oversized.length} existing baseline debt file(s) are grandfathered.`);
  }
}

if (require.main === module) runGuard();

module.exports = {
  CODE_EXTENSIONS,
  EXCLUDED_DIRECTORIES,
  GRANDFATHERED_DEBT,
  PLAN_BASELINE_COUNTS,
  WARN_LINES,
  FAIL_LINES,
  classifyPath,
  countPhysicalLines,
  evaluateCounts,
};

#!/usr/bin/env node
/**
 * LIVE-GATES step 2 (Claude review §10.7-5 / §11.4-5) — migration applied-state.
 *
 * Verifies on the CANDIDATE database (never assumed from the bake):
 *   - `schema_migrations` has exactly one applied row for 0035 and 0036;
 *   - the columns those migrations add exist:
 *       operations.callback_policy
 *       webhook_deliveries.mode
 *       webhook_deliveries.callback_policy
 *       profile_bindings.callback_policy  (0036)
 *   - with `--via-container`: `node dist/migrate-cli.js status` reports ZERO
 *     pending migrations (proves the shipped image's migration set is applied).
 *
 * Usage:
 *   node tools/live-gates/check-migrations.cjs \
 *     --pg-url postgresql://du:...@127.0.0.1:5433/du_orchestrator_test --via-container
 *
 * Exit: 0 PASS, 1 mismatch, 2 config/prereq.
 */
'use strict';

const path = require('node:path');
const {
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_CONFIG,
  REPO_ROOT,
  requireFromOrchestrator,
  defaultReportsDir,
  parseArgs,
  loadEnvFile,
  configError,
  writeReport,
  resolveDatabaseUrl,
  runCompose,
} = require('./lib/live-common.cjs');

const DEFAULT_EXPECTED_MIGRATIONS = ['0035', '0036'];
const DEFAULT_EXPECTED_COLUMNS = [
  ['operations', 'callback_policy'],
  ['webhook_deliveries', 'mode'],
  ['webhook_deliveries', 'callback_policy'],
  ['profile_bindings', 'callback_policy'],
];

async function checkDatabase(args, lines, summary) {
  const { Client } = requireFromOrchestrator('pg');
  const client = new Client({
    connectionString: resolveDatabaseUrl(args),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const ledger = await client.query('SELECT sequence, filename FROM schema_migrations ORDER BY sequence');
    summary.appliedCount = ledger.rowCount;
    summary.migrations = ledger.rows.map((row) => ({ sequence: row.sequence, filename: row.filename }));
    for (const number of summary.expectedMigrations) {
      const matches = ledger.rows.filter((row) => String(row.filename).startsWith(`${number}_`));
      if (matches.length !== 1) {
        summary.failures.push(`migration ${number}: expected exactly one applied row, found ${matches.length}`);
      } else {
        lines.push(`migration ${number} applied: ${matches[0].filename} (sequence ${matches[0].sequence})`);
      }
    }
    for (const [table, column] of summary.expectedColumns) {
      const found = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
        [table, column],
      );
      if (found.rowCount !== 1) {
        summary.failures.push(`column missing: ${table}.${column}`);
      } else {
        lines.push(`column present: ${table}.${column}`);
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

function checkViaContainer(args, lines, summary) {
  const service = args['compose-service'] ?? 'orchestrator';
  const result = runCompose(['exec', '-T', service, 'node', 'dist/migrate-cli.js', 'status'], {
    timeoutMs: Number(args['timeout-ms'] ?? 120_000),
  });
  summary.containerStatus = { exit: result.status, stdout: result.stdout.trim().split('\n').slice(-3) };
  if (result.status !== 0) {
    summary.failures.push(`migrate-cli status exited ${result.status}`);
    lines.push(`migrate-cli stderr: ${result.stderr.trim().slice(0, 500)}`);
    return;
  }
  const line = result.stdout.split('\n').reverse().find((entry) => entry.includes('migration status'));
  if (!line) {
    summary.failures.push('migrate-cli status output not recognised (no migration status log line)');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    summary.failures.push('migrate-cli status output is not JSON');
    return;
  }
  summary.pendingCount = Array.isArray(parsed.pending) ? parsed.pending.length : null;
  summary.appliedCountFromContainer = parsed.appliedCount;
  summary.totalCount = parsed.totalCount;
  const pendingList = Array.isArray(parsed.pending) ? parsed.pending : null;
  lines.push(
    `container status: applied=${parsed.appliedCount} total=${parsed.totalCount} `
    + `pending=${pendingList === null ? '(field omitted; applied==total implies none)' : JSON.stringify(pendingList)}`,
  );
  if (pendingList !== null && pendingList.length > 0) {
    summary.failures.push(`image has pending migrations: ${pendingList.join(', ')}`);
  } else if (pendingList === null && parsed.appliedCount !== parsed.totalCount) {
    // The structured logger can omit an empty array; an absent `pending` is
    // only trustworthy when the counters already prove nothing is behind.
    summary.failures.push(
      `pending field absent and applied (${parsed.appliedCount}) != total (${parsed.totalCount})`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args['env-file'] ?? path.join(REPO_ROOT, '.env.docker'));
  const reportsDir = args['report-dir'] ?? defaultReportsDir();
  const lines = [];
  const expectedMigrations = String(args.expect ?? DEFAULT_EXPECTED_MIGRATIONS.join(','))
    .split(',').map((part) => part.trim()).filter(Boolean);
  const expectedColumns = args['expect-columns']
    ? String(args['expect-columns']).split(',').map((part) => part.trim().split('.')).map(([t, c]) => [t, c])
    : DEFAULT_EXPECTED_COLUMNS;
  const summary = {
    expectedMigrations,
    expectedColumns,
    failures: [],
    viaContainer: args['via-container'] === true,
  };

  if (args['dry-run'] === true) {
    return writeReport(reportsDir, 'check-migrations', {
      step: 'check-migrations',
      mode: 'dry-run',
      pass: true,
      summary,
    }, [`plan: migrations=${expectedMigrations.join(',')} columns=${expectedColumns.map(([t, c]) => `${t}.${c}`).join(',')}`, 'database not contacted (dry-run)']);
  }

  await checkDatabase(args, lines, summary);
  if (args['via-container'] === true) checkViaContainer(args, lines, summary);

  const pass = summary.failures.length === 0;
  for (const failure of summary.failures) lines.push(`FAILURE: ${failure}`);
  return writeReport(reportsDir, 'check-migrations', {
    step: 'check-migrations',
    mode: 'live',
    pass,
    summary,
  }, lines);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[live-gates] migrations config/prereq error: ${error.message}\n`);
    process.exit(error.harnessConfig ? EXIT_CONFIG : EXIT_FAIL);
  });

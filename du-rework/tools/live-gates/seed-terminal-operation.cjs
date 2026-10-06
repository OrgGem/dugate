#!/usr/bin/env node
/**
 * LIVE-GATES pre-step — seed a SYNTHETIC terminal operation.
 *
 * The accepted dispatcher probe inserts one `webhook_deliveries` row, which
 * needs an `operations` row (FK). On a fresh candidate DB there is no terminal
 * operation, so this pre-step creates:
 *   - one synthetic tenant (name prefixed `live-gates-`), and
 *   - one SUCCEEDED operation for it, labeled in `correlation_id` with
 *     `live-gates-synthetic-<uuid>`.
 * The operation does NOT come from a real business run; it exists only to
 * satisfy the FK for the dispatcher gate. Operation scheduling is out of scope
 * per the accepted harness boundary (reviewer §12.3).
 *
 * Usage:
 *   node tools/live-gates/seed-terminal-operation.cjs \
 *     [--pg-url postgresql://...] [--report-dir <dir>]
 * Prints one JSON line: {"tenantId":"...","operationId":"...","correlationId":"..."}.
 *
 * Exit: 0 seeded, 2 config/prereq.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXIT_PASS,
  EXIT_CONFIG,
  REPO_ROOT,
  requireFromOrchestrator,
  parseArgs,
  loadEnvFile,
  ensureDir,
  resolveDatabaseUrl,
} = require('./lib/live-common.cjs');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args['env-file'] ?? path.join(REPO_ROOT, '.env.docker'));
  const { Client } = requireFromOrchestrator('pg');
  const client = new Client({ connectionString: resolveDatabaseUrl(args), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const tenant = await client.query(
      `INSERT INTO tenants (name) VALUES ('live-gates synthetic tenant') RETURNING id`,
    );
    const tenantId = tenant.rows[0].id;
    const correlationId = `live-gates-synthetic-${crypto.randomUUID()}`;
    const operation = await client.query(
      `INSERT INTO operations
         (tenant_id, business_id, business_version, action, state, state_version, correlation_id)
       VALUES ($1, 'document-core', '1.0.0', 'ingest', 'SUCCEEDED', 1, $2)
       RETURNING id`,
      [tenantId, correlationId],
    );
    const receipt = { tenantId, operationId: operation.rows[0].id, correlationId };
    const reportDir = args['report-dir'];
    if (typeof reportDir === 'string' && reportDir.length > 0) {
      ensureDir(reportDir);
      fs.writeFileSync(path.join(reportDir, 'seed-terminal-operation.json'), JSON.stringify(receipt, null, 2), 'utf8');
    }
    process.stdout.write(JSON.stringify(receipt) + '\n');
    return EXIT_PASS;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[live-gates] seed-terminal-operation config/prereq error: ${error.message}\n`);
    process.exit(error.harnessConfig ? EXIT_CONFIG : 1);
  });

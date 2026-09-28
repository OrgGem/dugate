#!/usr/bin/env node
/**
 * CLI migration runner (R08-06 / P2-01).
 *
 * Usage:
 *   npm run migrate           — apply all pending migrations
 *   npm run migrate:status    — show which migrations are applied/pending
 *   npm run migrate:verify    — verify all migrations are applied (read-only)
 *
 * Requires DATABASE_URL env var.
 *
 * Production deployment order:
 *   1. Set DATABASE_URL to the production database.
 *   2. npm run migrate   (applies pending SQL, verifies after)
 *   3. npm start          (server boots with autoMigrate=false — verify-only, no hidden writes)
 *
 * This CLI is an explicit operator opt-in. It applies pending migrations to
 * whatever database DATABASE_URL points to, including empty ones (first
 * deployment). The boot-time guard in server.ts (autoMigrate=false default)
 * prevents accidental schema creation at startup — use this CLI first.
 */

import { createDb } from './db/db';
import { migrate, migrationStatus, verifyMigrations } from './db/migrations';
import { createLogger, safeErrorForLog } from '@du/observability';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'migrations' } });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  logger.error('migration command cannot start', { errorCode: 'DATABASE_URL_REQUIRED' });
  process.exit(1);
}

const command = process.argv[2] ?? 'migrate';

async function main() {
  const db = createDb(DATABASE_URL!);

  try {
    switch (command) {
      case 'migrate': {
        const result = await migrate(db);
        if (result.applied.length === 0) {
          logger.info('database is up-to-date', { pendingMigrationCount: 0 });
        } else {
          logger.info('migrations applied', {
            appliedCount: result.applied.length,
            migrations: result.applied,
          });
        }
        // Verify after applying.
        await verifyMigrations(db);
        logger.info('migration verification passed');
        break;
      }

      case 'status': {
        const status = await migrationStatus(db);
        logger.info('migration status', {
          appliedCount: status.applied,
          totalCount: status.total,
          pending: status.pending,
        });
        break;
      }

      case 'verify': {
        await verifyMigrations(db);
        logger.info('schema verification passed');
        break;
      }

      default:
        logger.error('unknown migration command', { errorCode: 'UNKNOWN_MIGRATION_COMMAND' });
        process.exit(1);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  logger.error('migration command failed', { error: safeErrorForLog(err) });
  process.exit(1);
});

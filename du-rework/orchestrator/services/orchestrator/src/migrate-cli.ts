#!/usr/bin/env node
/** Explicit operator entrypoint for Orchestrator migrations. */

import { join } from 'node:path';
import { createDb } from './db/db';
import {
  baselineMigrationsReviewed,
  loadMigrationFiles,
  migrate,
  migrationStatus,
  verifyMigrations,
  type MigrationFile,
} from './db/migrations';
import {
  migrationApplyReport,
  migrationBaselineReport,
  migrationFailureReport,
  migrationStatusReport,
  migrationVerifyReport,
} from './migration-cli-report';

const command = process.argv[2] ?? 'migrate';
const databaseUrl = process.env.DATABASE_URL;

function writeReport(report: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function main(): Promise<void> {
  if (!databaseUrl) {
    writeReport({
      type: 'migration-command-error',
      service: 'orchestrator',
      command: ['migrate', 'status', 'verify', 'baseline-reviewed'].includes(command) ? command : 'unknown',
      outcome: 'failed',
      errorCode: 'DATABASE_URL_REQUIRED',
      detail: 'Set DATABASE_URL in the process environment before running the migration command.',
    });
    process.exitCode = 1;
    return;
  }

  let db: ReturnType<typeof createDb> | undefined;
  let files: MigrationFile[] = [];
  let report: Record<string, unknown>;
  try {
    db = createDb(databaseUrl);
    files = loadMigrationFiles(join(__dirname, '../migrations'));
    switch (command) {
      case 'migrate': {
        const result = await migrate(db);
        await verifyMigrations(db);
        report = migrationApplyReport(result.applied, await migrationStatus(db), files);
        break;
      }
      case 'status': {
        const status = await migrationStatus(db);
        report = migrationStatusReport(status, files);
        if (status.unknownChecksums.length > 0 || status.integrityProblems.length > 0) process.exitCode = 1;
        break;
      }
      case 'verify':
        await verifyMigrations(db);
        report = migrationVerifyReport(await migrationStatus(db), files);
        break;
      case 'baseline-reviewed': {
        const result = await baselineMigrationsReviewed(db);
        report = migrationBaselineReport(result.baselined, await migrationStatus(db), files);
        break;
      }
      default:
        throw new Error('unknown migration command');
    }
  } catch (error) {
    report = migrationFailureReport(command, error, files);
    process.exitCode = 1;
  }

  try {
    await db?.close();
  } catch (error) {
    if (process.exitCode !== 1) {
      report = migrationFailureReport(command, error, files);
      process.exitCode = 1;
    }
  }
  writeReport(report!);
}

void main().catch(() => {
  writeReport({
    type: 'migration-command-error',
    service: 'orchestrator',
    command: ['migrate', 'status', 'verify', 'baseline-reviewed'].includes(command) ? command : 'unknown',
    outcome: 'failed',
    errorCode: 'MIGRATION_COMMAND_FAILED',
    detail: 'The migration command failed before a safe report could be produced.',
  });
  process.exitCode = 1;
});

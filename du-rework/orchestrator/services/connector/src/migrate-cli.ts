#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConnectorMigrations, type ConnectorMigrationFile } from './db/migration-runner';
import { PgSqlClient } from './db/pg-client';
import {
  connectorMigrationApplyReport,
  connectorMigrationBaselineReport,
  connectorMigrationFailureReport,
  connectorMigrationStatusReport,
  connectorMigrationVerifyReport,
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
      service: 'connector',
      command: ['migrate', 'status', 'verify', 'baseline-reviewed'].includes(command) ? command : 'unknown',
      outcome: 'failed',
      errorCode: 'DATABASE_URL_REQUIRED',
      detail: 'Set DATABASE_URL in the process environment before running the migration command.',
    });
    process.exitCode = 1;
    return;
  }

  let database: PgSqlClient | undefined;
  let files: ConnectorMigrationFile[] = [];
  let report: Record<string, unknown>;
  try {
    const configuredDirectory = process.env.CONNECTOR_MIGRATION_DIRECTORY;
    const sourceDirectory = join(__dirname, '../src/db/migrations');
    const builtDirectory = join(__dirname, 'db/migrations');
    const migrationDirectory = configuredDirectory
      ?? (existsSync(sourceDirectory) ? sourceDirectory : builtDirectory);
    if (!existsSync(migrationDirectory)) throw new Error('Connector migration directory is unavailable.');
    files = loadConnectorMigrations(migrationDirectory);
    database = new PgSqlClient({ connectionString: databaseUrl, migrationDirectory });

    switch (command) {
      case 'migrate': {
        const before = await database.migrationStatus();
        await database.migrate();
        const after = await database.migrationStatus();
        const applied = before.pending.filter((filename) => !after.pending.includes(filename));
        await database.verifyMigrations();
        report = connectorMigrationApplyReport(applied, after, files);
        break;
      }
      case 'status': {
        const status = await database.migrationStatus();
        report = connectorMigrationStatusReport(status, files);
        if (status.unknownChecksums.length > 0 || status.integrityProblems.length > 0) process.exitCode = 1;
        break;
      }
      case 'verify':
        await database.verifyMigrations();
        report = connectorMigrationVerifyReport(await database.migrationStatus(), files);
        break;
      case 'baseline-reviewed': {
        const result = await database.baselineMigrationsReviewed();
        report = connectorMigrationBaselineReport(result.baselined, await database.migrationStatus(), files);
        break;
      }
      default:
        throw new Error('unknown migration command');
    }
  } catch (error) {
    report = connectorMigrationFailureReport(command, error, files);
    process.exitCode = 1;
  }

  try {
    await database?.close();
  } catch (error) {
    if (process.exitCode !== 1) {
      report = connectorMigrationFailureReport(command, error, files);
      process.exitCode = 1;
    }
  }
  writeReport(report!);
}

void main().catch(() => {
  writeReport({
    type: 'migration-command-error',
    service: 'connector',
    command: ['migrate', 'status', 'verify', 'baseline-reviewed'].includes(command) ? command : 'unknown',
    outcome: 'failed',
    errorCode: 'MIGRATION_COMMAND_FAILED',
    detail: 'The Connector migration command failed before a safe report could be produced.',
  });
  process.exitCode = 1;
});

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { join } from 'node:path';
import type { SqlClient, SqlResult } from './sql';
import {
  baselineConnectorMigrationsReviewed,
  connectorMigrationStatus,
  migrateConnector,
  verifyConnectorMigrations,
  type ConnectorMigrationStatus,
} from './migration-runner';

export interface PgConnectorOptions extends PoolConfig {
  migrationDirectory?: string;
}

export class PgSqlClient implements SqlClient {
  public readonly pool: Pool;
  private readonly migrationDirectory: string;

  public constructor(options: PgConnectorOptions) {
    const { migrationDirectory, ...poolOptions } = options;
    this.pool = new Pool(poolOptions);
    this.migrationDirectory = migrationDirectory ?? join(__dirname, 'migrations');
  }

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.pool.query(text, parameters as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? undefined };
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(new PgTransactionClient(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async migrate(): Promise<void> {
    await migrateConnector(this.pool, this.migrationDirectory);
  }

  public async verifyMigrations(): Promise<void> {
    await verifyConnectorMigrations(this.pool, this.migrationDirectory);
  }

  public async migrationStatus(): Promise<ConnectorMigrationStatus> {
    return connectorMigrationStatus(this.pool, this.migrationDirectory);
  }

  public async baselineMigrationsReviewed(): Promise<{ baselined: string[] }> {
    return baselineConnectorMigrationsReviewed(this.pool, this.migrationDirectory);
  }

  public async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgTransactionClient implements SqlClient {
  public constructor(private readonly client: PoolClient) {}

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<QueryResultRow>(text, parameters as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? undefined };
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

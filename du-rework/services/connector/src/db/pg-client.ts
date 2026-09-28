import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqlClient, SqlResult } from './sql';

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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS connector_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const version of [
      '001_connector',
      '002_connector_poll_recovery',
      '003_connector_quota_carry',
      '004_connector_poll_backoff',
      '005_connector_polling_state',
      '006_connector_revision_lifecycle',
      '007_connector_credential_source',
      '008_connector_revision_binding',
    ]) {
      const applied = await this.pool.query(
        'SELECT version FROM connector_schema_migrations WHERE version = $1',
        [version],
      );
      if (applied.rowCount) continue;
      const migration = await readFile(join(this.migrationDirectory, `${version}.sql`), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration);
        await client.query('INSERT INTO connector_schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
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

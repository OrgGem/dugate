import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Thin pg wrapper. The slice keeps SQL in services; db.ts owns pooling and
 * transaction scoping only. Worker never touches this (docs 04: runtime API
 * is the only worker-facing boundary).
 */

export interface Db {
  pool: Pool;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
  tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 10 });
  return {
    pool,
    query: (text, params) => pool.query(text, params as never[]),
    async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db, migrationSql: string[]): Promise<void> {
  for (const sql of migrationSql) {
    await db.query(sql);
  }
}

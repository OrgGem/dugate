export interface SqlResult<Row extends object = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number;
}

export interface SqlClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T>;
}

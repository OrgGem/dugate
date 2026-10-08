// Read-only PG poller for the WFA-T26 diagnosis: captures the connector ledger and task rows
// while the focused jest run executes. SELECT only; no writes, no DDL.
const { Client } = require(
  'D:/Git/dugate/du-rework/orchestrator/services/orchestrator/node_modules/pg',
);

const CONNECTION =
  process.env.WFA_DATABASE_URL ?? 'postgresql://du_wfa:du_wfa_test_only@127.0.0.1:55498/du_workflow_api_test';
const DURATION_MS = Number(process.env.POLL_MS ?? 60000);
const INTERVAL_MS = 150;

const started = Date.now();
const seen = new Set();

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

(async () => {
  const c = new Client({ connectionString: CONNECTION });
  await c.connect();
  console.log(`poller: connected ${CONNECTION} at ${stamp()}`);
  let tick = 0;
  while (Date.now() - started < DURATION_MS) {
    tick += 1;
    try {
      const schemas = await c.query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_name IN ('connector_invocations','tasks')`,
      );
      const invSchemas = schemas.rows.filter((r) => r.table_name === 'connector_invocations').map((r) => r.table_schema);
      const taskSchemas = schemas.rows.filter((r) => r.table_name === 'tasks').map((r) => r.table_schema);
      if (tick === 1 || tick % 20 === 0) {
        console.log(`[${stamp()}] schemas: inv=${JSON.stringify(invSchemas)} tasks=${JSON.stringify(taskSchemas)}`);
      }
      for (const schema of invSchemas) {
        let rows = { rows: [] };
        try {
          rows = await c.query(`SELECT * FROM "${schema}".connector_invocations ORDER BY created_at`);
        } catch (error) {
          console.log(`[${stamp()}] INV query error in ${schema}: ${error.message}`);
        }
        for (const row of rows.rows) {
          const pick = (key) => {
            const value = row[key];
            return value instanceof Date ? value.toISOString() : value;
          };
          const sig = `inv|${schema}|${row.invocation_id}|${row.state}|${row.error_code}|${row.attempts}|${pick('updated_at')}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          console.log(`[${stamp()}] INV schema=${schema} id=${String(row.invocation_id).slice(0, 12)} state=${row.state} error=${row.error_code} attempts=${row.attempts} pollAttempts=${row.provider_poll_attempts} created=${pick('created_at')} updated=${pick('updated_at')} quotaLease=${pick('quota_lease_expires_at')} pollLease=${pick('poll_lease_expires_at')}`);
        }
      }
      for (const schema of taskSchemas) {
        const rows = await c.query(
          `SELECT task_key, state, attempt, max_attempts, lease_epoch, error_code, due_at, updated_at
             FROM "${schema}".tasks ORDER BY updated_at DESC LIMIT 4`,
        ).catch(() => ({ rows: [] }));
        for (const row of rows.rows) {
          const sig = `task|${schema}|${row.task_key}|${row.state}|${row.attempt}|${row.lease_epoch}|${row.error_code}|${row.due_at?.toISOString?.() ?? row.due_at}|${row.updated_at}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          console.log(`[${stamp()}] TASK schema=${schema} key=${row.task_key} state=${row.state} attempt=${row.attempt}/${row.max_attempts} epoch=${row.lease_epoch} error=${row.error_code} due=${row.due_at?.toISOString?.() ?? row.due_at} updated=${row.updated_at?.toISOString?.() ?? row.updated_at}`);
        }
      }
    } catch (error) {
      console.log(`[${stamp()}] poll error: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  await c.end();
  console.log(`poller: done at ${stamp()}`);
})().catch((error) => {
  console.error('POLLER_ERR ' + error.message);
  process.exit(3);
});

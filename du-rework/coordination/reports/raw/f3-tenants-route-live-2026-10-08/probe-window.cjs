// F-3 window probe (temporary, outside the repo). Read-only.
const { Client } = require(
  'D:/Git/dugate/du-rework/orchestrator/services/orchestrator/node_modules/pg',
);

const CONNECTION =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';

(async () => {
  const c = new Client({ connectionString: CONNECTION });
  await c.connect();
  const v = await c.query('select version()');
  const db = await c.query('select current_database() as db, current_user as usr');
  const cols = await c.query(
    "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='tenants' order by ordinal_position",
  );
  const idx = await c.query(
    "select indexname, indexdef from pg_indexes where tablename='tenants' order by indexname",
  );
  const t = await c.query('select id::text, name, state from tenants order by lower(name), id');
  const sessions = await c.query(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()",
  );
  const migr = await c.query(
    "select to_regclass('public.schema_migrations') is not null as has_ledger",
  ).catch(() => ({ rows: [{ has_ledger: null }] }));
  console.log('version=' + String(v.rows[0].version).split(',')[0]);
  console.log('db=' + db.rows[0].db + ' user=' + db.rows[0].usr);
  console.log('tenants_count=' + t.rows.length);
  console.log('other_sessions=' + sessions.rows[0].n);
  console.log('has_schema_migrations=' + migr.rows[0].has_ledger);
  console.log('columns=' + JSON.stringify(cols.rows));
  console.log('indexes=' + JSON.stringify(idx.rows.map((r) => r.indexname)));
  console.log('tenants=' + JSON.stringify(t.rows.slice(0, 40)));
  await c.end();
})().catch((e) => {
  console.error('PROBE_ERR ' + e.message);
  process.exit(3);
});

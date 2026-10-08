const { Client } = require('D:/Git/dugate/du-rework/orchestrator/services/orchestrator/node_modules/pg');
(async () => {
  const c = new Client({ connectionString: 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test' });
  await c.connect();
  const schemas = await c.query("select nspname from pg_namespace where nspname like 'du_test_f3%' or nspname like 'f3_probe%' order by nspname");
  const sessions = await c.query("select count(*)::int n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()");
  const tenants = await c.query('select count(*)::int n from tenants');
  console.log('leftover_isolation_schemas=' + JSON.stringify(schemas.rows.map(r => r.nspname)));
  console.log('other_sessions=' + sessions.rows[0].n);
  console.log('public_tenants=' + tenants.rows[0].n);
  await c.end();
})().catch(e => { console.error('PROBE_ERR ' + e.message); process.exit(3); });
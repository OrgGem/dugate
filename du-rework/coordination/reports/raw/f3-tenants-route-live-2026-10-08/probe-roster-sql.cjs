// F-3 probe: run the EXACT roster SQL shapes from src/modules/admin-read/tenant-list.ts
// against a throwaway schema, to explain the scoped+cursor result. Read/write only in a
// probe schema that is dropped at the end.
const { Client } = require(
  'D:/Git/dugate/du-rework/orchestrator/services/orchestrator/node_modules/pg',
);

const CONNECTION = 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const SCHEMA = 'f3_probe_' + Math.random().toString(16).slice(2, 10);

const A = 'f3a11111-1111-4111-8111-f3a111111111';
const B = 'f3b22222-2222-4222-8222-f3b222222222';
const C = 'f3c33333-3333-4333-8333-f3c333333333';
const D = '00000000-0000-0000-0000-000000000001';

(async () => {
  const c = new Client({ connectionString: CONNECTION });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA "${SCHEMA}"`);
    await c.query(`SET search_path = "${SCHEMA}", public`);
    await c.query('CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL, state text NOT NULL DEFAULT \'ACTIVE\')');
    await c.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1,'default','ACTIVE'),($2,'f3roster-alpha','ACTIVE'),($3,'f3roster-bravo','ACTIVE'),($4,'f3roster-charlie','SUSPENDED')`,
      [D, A, B, C],
    );
    console.log('--- oracle order ---');
    const all = await c.query('SELECT id::text, name FROM tenants ORDER BY lower(name), id');
    console.log(JSON.stringify(all.rows));

    const PAGE_SQL = (where, limitParam) =>
      `SELECT id, name, state FROM tenants${where} ORDER BY lower(name) ASC, id ASC LIMIT ${limitParam}`;

    console.log('--- unscoped + forward cursor at A (expect B,C) ---');
    const unscoped = await c.query(
      PAGE_SQL(' WHERE (lower(name), id) > ((SELECT lower(name) FROM tenants WHERE id = $1), $1::uuid)', '$2'),
      [A, 3],
    );
    console.log(JSON.stringify(unscoped.rows));

    console.log('--- scoped B + forward cursor at A (expected B by the doc, observed?) ---');
    const scoped = await c.query(
      PAGE_SQL(
        ' WHERE id = $1 AND (lower(name), id) > ((SELECT lower(name) FROM tenants WHERE id = $2), $2::uuid)',
        '$3',
      ),
      [B, A, 3],
    );
    console.log(JSON.stringify(scoped.rows));

    console.log('--- scoped B without cursor ---');
    const scopedNoCursor = await c.query(PAGE_SQL(' WHERE id = $1', '$2'), [B, 3]);
    console.log(JSON.stringify(scopedNoCursor.rows));

    console.log('--- subquery alone ---');
    const sub = await c.query('SELECT lower(name) AS n FROM tenants WHERE id = $1', [A]);
    console.log(JSON.stringify(sub.rows));

    console.log('--- row-value comparison alone (no scope) ---');
    const cmp = await c.query(
      `SELECT id::text, name, (lower(name), id) > ((SELECT lower(name) FROM tenants WHERE id = $1), $1::uuid) AS beyond FROM tenants ORDER BY lower(name), id`,
      [A],
    );
    console.log(JSON.stringify(cmp.rows));
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
    await c.end();
  }
})().catch((e) => {
  console.error('PROBE_ERR ' + e.message);
  process.exit(3);
});

/* Bounded readiness gate: never print connection strings or database errors. */
'use strict';
const { createRequire } = require('node:module');
async function waitForDatabase({ Client, connectionString, timeoutMs = 60000, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const deadline = Date.now() + timeoutMs;
  do {
    const client = new Client({ connectionString, connectionTimeoutMillis: 2000, query_timeout: 2000 });
    try { await client.connect(); await client.query('SELECT 1'); return; }
    catch (error) {
      if (['28P01', '28000', '3D000'].includes(error.code)) throw new Error('Database authentication or database name is invalid');
      if (Date.now() >= deadline) throw new Error('Database readiness timed out');
    } finally { await client.end().catch(() => {}); }
    await pause(1000);
  } while (Date.now() < deadline);
  throw new Error('Database readiness timed out');
}
module.exports = { waitForDatabase };
if (require.main === module) {
  const { Client } = createRequire('/app/package.json')('pg');
  waitForDatabase({ Client, connectionString: process.env.DATABASE_URL }).catch(() => {
    process.stderr.write('Database startup readiness failed; server was not started.\n'); process.exitCode = 1;
  });
}

'use strict';
// Run only inside the disposable --network=container:du-migration-test-pg fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { Pool } = createRequire('/app/package.json')('pg');
const { migrate, verifyMigrations } = require('/fixture/orchestrator/migrations.js');
const { migrateConnector, verifyConnectorMigrations } = require('/fixture/connector/migration-runner.js');
const base = 'postgresql://postgres@127.0.0.1:5432/';
const admin = new Pool({ connectionString: base+'postgres' });
function wrap(pool) { return {pool, query:(...args)=>pool.query(...args), async tx(fn) {const c=await pool.connect(); try {await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result;} catch(e) {await c.query('ROLLBACK'); throw e;} finally {c.release();}},close:()=>pool.end()}; }
async function database(name) { assert.match(name,/^migration_test_[a-z_]+$/); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${name}`); return new Pool({connectionString:base+name}); }
async function main() {
 const pool=await database('migration_test_orchestrator'); const db=wrap(pool);
 const dir='/fixture/sql-orchestrator';
 const first=await migrate(db,dir); assert.equal(first.applied.length,fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).length); await verifyMigrations(db,dir);
 const tenant=()=>pool.query('SELECT id,name,state FROM tenants');
 assert.deepEqual((await tenant()).rows,[{id:'00000000-0000-0000-0000-000000000001',name:'default',state:'ACTIVE'}]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys')).rows[0].n,0);
 assert.equal((await migrate(db,dir)).applied.length,0);
 await Promise.all([migrate(db,dir),migrate(wrap(new Pool({connectionString:base+'migration_test_orchestrator',max:1})),dir)]);
 assert.equal((await tenant()).rowCount,1);
 await pool.query("UPDATE tenants SET name='customized',state='SUSPENDED'"); await migrate(db,dir);
 const customized=(await tenant()).rows.find(x=>x.name==='customized'); assert.equal(customized.state,'SUSPENDED'); assert.equal((await tenant()).rows.filter(x=>x.name==='default').length,1);
 await pool.query('DELETE FROM tenants'); await pool.query("INSERT INTO tenants(id,name) VALUES ('00000000-0000-0000-0000-000000000002','default')");
 await migrate(db,dir); assert.equal((await tenant()).rowCount,1); assert.equal((await tenant()).rows[0].id,'00000000-0000-0000-0000-000000000002');
 await pool.query('DELETE FROM tenants'); await migrate(db,dir); assert.equal((await tenant()).rowCount,1);
 assert.deepEqual((await pool.query('SELECT name,version FROM required_data_bootstrap')).rows,[{name:'default-tenant',version:1}]);
 await pool.query("UPDATE required_data_bootstrap SET version=2"); await assert.rejects(migrate(db,dir),/newer than this image/); await pool.query('UPDATE required_data_bootstrap SET version=1');
 console.log('PASS Orchestrator fresh/existing/rerun/concurrent/custom preservation/default recovery/future-version guard; no API key fixtures');
 const cp=await database('migration_test_connector'); const cd='/fixture/sql-connector';
 const both=await Promise.all([migrateConnector(cp,cd),migrateConnector(cp,cd)]); assert.ok(both.some(x=>x.applied.length>0)); await verifyConnectorMigrations(cp,cd); assert.equal((await migrateConnector(cp,cd)).applied.length,0);
 console.log('PASS Connector fresh/concurrent/rerun/checksum verification');
 const fp=await database('migration_test_failure'); const fd=wrap(fp); fs.mkdirSync('/tmp/bad-migrations');
 fs.writeFileSync('/tmp/bad-migrations/0001_failure.sql','CREATE TABLE rollback_probe(id int); THIS IS INVALID SQL;');
 await assert.rejects(migrate(fd,'/tmp/bad-migrations'));
 assert.equal((await fp.query("SELECT to_regclass('rollback_probe') x")).rows[0].x,null);
 assert.equal((await fp.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,0);
 fs.writeFileSync('/tmp/bad-migrations/0001_failure.sql','CREATE TABLE rollback_probe(id int);'); await migrate(fd,'/tmp/bad-migrations'); await verifyMigrations(fd,'/tmp/bad-migrations');
 console.log('PASS failed migration rollback/no false ledger/successful retry');
 await Promise.all([pool.end(),cp.end(),fp.end(),admin.end()]);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});

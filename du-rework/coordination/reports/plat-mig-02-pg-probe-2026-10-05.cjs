const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'services/orchestrator/src/modules/connectors/probe-authorization.ts'), 'utf8');
const match = source.match(/`(SELECT p\.api_key_id[\s\S]*?)`/);
if (!match) throw new Error('Authorization SQL not found in current source');
const argumentsProvided = process.argv.slice(2);
if (argumentsProvided.some((argument) => argument !== '--mutate-tenant-predicate')) throw new Error('Unknown argument');
// Mutation applies only to the SQL string in this private harness, never source files.
const authorizationSql = argumentsProvided.includes('--mutate-tenant-predicate')
  ? match[1].replace('p.tenant_id = $2', '$2 IS NOT NULL')
  : match[1];
const query = authorizationSql.replaceAll('$1', "'key-a'").replaceAll('$2', "'tenant-a'");
const mismatchedPrincipalQuery = authorizationSql.replaceAll('$1', "'key-a'").replaceAll('$2', "'tenant-b'");
function check(label, expected, checkedQuery = query) {
  return `DO $$ DECLARE actual integer; BEGIN SELECT count(*) INTO actual FROM (${checkedQuery}) probe;
    IF actual <> ${expected} THEN RAISE EXCEPTION '${label}: expected ${expected}, got %', actual; END IF;
    RAISE NOTICE '${label} PASS'; END $$;`;
}
const sql = `BEGIN;
CREATE TEMP TABLE api_keys (id text PRIMARY KEY, tenant_id text, status text);
CREATE TEMP TABLE profile_bindings (profile_id text, revision integer, api_key_id text, tenant_id text,
  enabled boolean, connector_bindings jsonb);
CREATE TEMP TABLE profile_active_revisions (profile_id text, revision integer);
INSERT INTO api_keys VALUES ('key-a', 'tenant-a', 'ACTIVE'), ('key-b', 'tenant-b', 'ACTIVE');
INSERT INTO profile_bindings VALUES
 ('own',1,'key-a','tenant-a',true,'{"slot":{"connectorId":"old","revision":1}}'),
 ('own',2,'key-a','tenant-a',true,'{"slot":{"connectorId":"connector-a","revision":1}}'),
 ('foreign',1,'key-b','tenant-b',true,'{"slot":{"connectorId":"foreign","revision":1}}');
INSERT INTO profile_active_revisions VALUES ('own',2), ('foreign',1);
${check('OWN_PUBLISHED_ONLY', 1)}
${check('PRINCIPAL_TENANT_MISMATCH_DENIED', 0, mismatchedPrincipalQuery)}
DO $$ DECLARE connector text; BEGIN SELECT connector_bindings->'slot'->>'connectorId' INTO connector
 FROM (${query}) probe; IF connector <> 'connector-a' THEN RAISE EXCEPTION 'Old revision selected'; END IF;
 RAISE NOTICE 'REVISION_POINTER PASS'; END $$;
UPDATE profile_bindings SET enabled=false WHERE profile_id='own';
${check('DISABLED_DENIED', 0)}
UPDATE profile_bindings SET enabled=true WHERE profile_id='own';
UPDATE api_keys SET status='REVOKED' WHERE id='key-a';
${check('REVOKED_DENIED', 0)}
UPDATE api_keys SET status='ACTIVE',tenant_id='tenant-b' WHERE id='key-a';
${check('TENANT_JOIN_DENIED', 0)}
UPDATE api_keys SET tenant_id='tenant-a' WHERE id='key-a';
DELETE FROM profile_active_revisions WHERE profile_id='own';
${check('MISSING_POINTER_DENIED', 0)}
ROLLBACK;`;
const result = spawnSync('docker', ['exec', '-i', 'du-live-postgres', 'psql', '-U', 'du', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  input: sql, encoding: 'utf8', timeout: 30000,
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;

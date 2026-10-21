import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadMigrationFiles, migrationChecksum } from '../src/db/migrations';

/**
 * PC-02 offline migration invariants (no database).
 *
 * The live counterpart (`profile-control-plane-migration.test.ts`, gated by
 * DU_LIVE_INFRA=1) proves the DDL behaves; this suite proves the FILE cannot
 * regress in the ways that only show up at boot:
 *
 *   - a destructive statement that no down migration can undo;
 *   - `CREATE INDEX CONCURRENTLY`, which the runner's per-file transaction
 *     cannot execute;
 *   - dropping an object name an earlier migration declared, which trips the
 *     runner's declared-object drift guard and blocks every startup;
 *   - `key_mode` gaining a DEFAULT, which would turn a forgotten writer into a
 *     privilege decision instead of a fail-closed denial.
 *
 * Precedent for asserting on migration file content:
 * tests/migration-artifact-sync.test.cjs.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILENAME = '0070_profile_control_plane_storage.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, FILENAME), 'utf8');

/** Same extractor the runner uses (`declaredSchemaObjects`). */
function declaredObjects(source: string): string[] {
  const names: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/--.*$/, '');
    const match = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/i.exec(line);
    if (match) names.push(match[1]!.toLowerCase());
  }
  return names;
}

describe('PC-02 0070 migration file invariants', () => {
  test('sequence 0070 exists exactly once and the directory stays well-ordered', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name));
    expect(files.filter((name) => name.startsWith('0070_'))).toEqual([FILENAME]);
    expect(files.filter((name) => name.startsWith('0069_'))).toEqual(['0069_required_data.sql']);
    // loadMigrationFiles throws on a duplicate sequence; a clean call is the proof.
    const loaded = loadMigrationFiles(MIGRATIONS_DIR);
    const sequences = loaded.map((file) => file.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    // PC-05 added 0071 after this packet's file, so the assertion is "at least
    // 0071" rather than a hardcoded maximum: a later packet may append 0072
    // without re-breaking PC-02's guarantee.
    expect(Math.max(...sequences)).toBeGreaterThanOrEqual(71);
    // 0070 must still be applied before anything that depends on it.
    const indexOf0070 = loaded.findIndex((file) => file.filename === FILENAME);
    expect(indexOf0070).toBeGreaterThanOrEqual(0);
    expect(loaded[indexOf0070 + 1]?.sequence).toBe(71);
  });

  test('the file is LF-only so the ledger checksum is checkout-independent', () => {
    expect(sql.includes('\r')).toBe(false);
    expect(migrationChecksum(sql)).toMatch(/^[a-f0-9]{64}$/);
    // CRLF normalisation must be a no-op for this file.
    expect(migrationChecksum(sql)).toBe(migrationChecksum(sql.replace(/\r\n/g, '\n')));
  });

  test('contains no destructive or runner-hostile statement', () => {
    const withoutComments = sql.replace(/--.*$/gm, '');
    for (const forbidden of [
      /\bDROP\s+TABLE\b/i,
      /\bALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bSET\s+NOT\s+NULL\b/i,
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
      /^\s*BEGIN\s*;/im,
      /^\s*COMMIT\s*;/im,
    ]) {
      expect(withoutComments).not.toMatch(forbidden);
    }
    // The only index drop is the 0028 name, and it is re-created below.
    const drops = [...withoutComments.matchAll(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)].map((m) => m[1]!.toLowerCase());
    expect(drops).toEqual(['profile_names_identity']);
    expect(declaredObjects(sql)).toContain('profile_names_identity');
  });

  test('every declared object is created by this file (no self-dropped object)', () => {
    const declared = declaredObjects(sql);
    expect(declared.length).toBeGreaterThan(0);
    // Comments are stripped so prose that names an object cannot satisfy a match.
    const statements = sql.replace(/--.*$/gm, '');
    for (const name of declared) {
      // A name this file drops AFTER creating would trip the runner's drift
      // guard on the very next startup.
      const dropIndex = statements.search(new RegExp(`DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?${name}\\b`, 'i'));
      if (dropIndex === -1) continue;
      const createIndex = statements.search(
        new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b`, 'i'),
      );
      expect(createIndex).toBeGreaterThan(dropIndex);
    }
    expect(new Set(declared)).toEqual(new Set([
      'api_keys_id_tenant_unique',
      'profile_group_api_keys',
      'profile_group_api_keys_group_active',
      'profile_names_identity',
      'profile_names_group_identity',
      'profile_group_revisions_author',
    ]));
  });

  test('block 1: key_mode exists, has no DEFAULT, and never assigns GROUP_MANAGED', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS key_mode text\b/);
    expect(sql).not.toMatch(/key_mode\s+text[^;\n]*DEFAULT/i);
    expect(sql).toMatch(/CHECK \(key_mode IS NULL OR key_mode IN \('GROUP_MANAGED', 'LEGACY_STANDALONE', 'UNMANAGED_LEGACY'\)\)/);

    const update = /UPDATE api_keys k([\s\S]*?)WHERE k\.key_mode IS NULL;/.exec(sql);
    expect(update).not.toBeNull();
    const body = update![1]!;
    expect(body).not.toContain('GROUP_MANAGED');
    expect(body).toContain("'LEGACY_STANDALONE'");
    expect(body).toContain("'UNMANAGED_LEGACY'");
    // Evidence-only classification over exactly these four relations.
    for (const relation of ['profile_api_keys', 'profile_bindings', 'profile_names', 'profile_group_revisions']) {
      expect(body).toContain(`FROM ${relation}`);
    }
    expect(sql.match(/UPDATE api_keys k/g)).toHaveLength(1);
  });

  test('block 2: tenant-safe FK target on api_keys', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS api_keys_id_tenant_unique\s+ON api_keys \(id, tenant_id\)/);
  });

  test('block 3: group authority columns and closed enums', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'API_KEY'/);
    expect(sql).toMatch(/CHECK \(auth_mode IN \('API_KEY'\)\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS auth_authority text NOT NULL DEFAULT 'CHILD_PROJECTION'/);
    expect(sql).toMatch(/CHECK \(auth_authority IN \('CHILD_PROJECTION', 'GROUP_GRANT'\)\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS access_version bigint NOT NULL DEFAULT 1/);
    expect(sql).toMatch(/CHECK \(access_version > 0\)/);
  });

  test('block 4: grant ledger with both composite tenant FKs', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS profile_group_api_keys/);
    expect(sql).toMatch(/api_key_id\s+uuid PRIMARY KEY/);
    expect(sql).toMatch(/FOREIGN KEY \(group_id, tenant_id\)\s+REFERENCES profile_groups \(group_id, tenant_id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(api_key_id, tenant_id\)\s+REFERENCES api_keys \(id, tenant_id\)/);
    expect(sql).toMatch(/CHECK \(state IN \('ACTIVE', 'REVOKED'\)\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS profile_group_api_keys_group_active[\s\S]*?WHERE state = 'ACTIVE'/);
  });

  test('block 5: author ids relaxed and Admin attribution added', () => {
    for (const table of ['profile_bindings', 'profile_names', 'profile_group_revisions']) {
      const relaxed = new RegExp(`ALTER TABLE ${table}\\s+ALTER COLUMN api_key_id DROP NOT NULL;`);
      expect(sql).toMatch(relaxed);
    }
    expect(sql.match(/ALTER COLUMN api_key_id DROP NOT NULL;/g)).toHaveLength(3);
    for (const table of ['profile_bindings', 'profile_group_revisions']) {
      const block = new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS created_by text[\\s\\S]*?created_by_sub text;`);
      expect(sql).toMatch(block);
    }
    expect(sql).toMatch(/CHECK \(api_key_id IS NOT NULL OR created_by IS NOT NULL\)/);
    expect(sql).toMatch(/CHECK \(api_key_id IS NOT NULL OR group_id IS NOT NULL\)/);
  });

  test('block 6: request_defaults is a non-null JSON object with an empty default', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS request_defaults jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(sql).toMatch(/CHECK \(jsonb_typeof\(request_defaults\) = 'object'\)/);
  });

  test('block 7: identity index is re-created under its original name, then the group index', () => {
    // Dropping the name without re-creating it trips the runner's drift guard
    // for 0028 and blocks migrate/status/verify and the startup schema gate.
    expect(sql).toMatch(/DROP INDEX IF EXISTS profile_names_identity;/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS profile_names_identity\s+ON profile_names \(tenant_id, api_key_id, business_id, business_version, action, profile_name\)\s+WHERE group_id IS NULL;/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS profile_names_group_identity\s+ON profile_names \(tenant_id, group_id, profile_name\)\s+WHERE group_id IS NOT NULL;/,
    );
    const identityPos = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS profile_names_identity');
    const dropPos = sql.indexOf('DROP INDEX IF EXISTS profile_names_identity');
    expect(identityPos).toBeGreaterThan(dropPos);
  });

  test('block 8: author lookup index is partial on the optional column', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS profile_group_revisions_author\s+ON profile_group_revisions \(api_key_id\)\s+WHERE api_key_id IS NOT NULL;/,
    );
  });
});

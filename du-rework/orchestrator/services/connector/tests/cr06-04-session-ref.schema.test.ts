import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConnectorMigrations } from '../src/db/migration-runner';

/**
 * CR06-04 — offline schema pin for the connector migration 009 that stores the
 * provider-issued async session on the pending invocation record. No database
 * is used: this certifies the migration file, its registration in the
 * PgSqlClient ledger, and the repository SQL/read mapping that carries it.
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, '..', relative), 'utf8').replace(/\r\n/g, '\n');

const MIG = read('src/db/migrations/009_connector_invocation_session_ref.sql');
const REPOSITORY = read('src/db/repository.ts');
const MIGRATION_CATALOG = loadConnectorMigrations(join(__dirname, '..', 'src', 'db', 'migrations'));

describe('CR06-04 migration 009 — connector invocation session_ref', () => {
  it('adds the nullable session_ref column replay-safely', () => {
    expect(MIG).toMatch(/ALTER TABLE connector_invocations\n\s+ADD COLUMN IF NOT EXISTS session_ref TEXT;/);
    expect(MIG).not.toMatch(/NOT NULL/);
  });

  it('is discovered in the migration catalog after 008', () => {
    const filenames = MIGRATION_CATALOG.map((migration) => migration.filename);
    const after008 = filenames.indexOf('008_connector_revision_binding.sql');
    const after009 = filenames.indexOf('009_connector_invocation_session_ref.sql');
    expect(after008).toBeGreaterThanOrEqual(0);
    expect(after009).toBeGreaterThan(after008);
  });

  it('stores the session on markPending and maps it back on read', () => {
    expect(REPOSITORY).toMatch(/session_ref = COALESCE\(\$9, session_ref\)/);
    // SEC-ENC-02: the session column is sealed on write and opened on read
    // through the invocation crypto seam (slot-bound AAD), not returned raw.
    expect(REPOSITORY).toMatch(/slot: 'connector_invocations\.session_ref'/);
    expect(REPOSITORY).toMatch(/private async openSessionRef/);
  });
});

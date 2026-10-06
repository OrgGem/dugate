import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CR06-04 — offline schema pin for the connector migration 009 that stores the
 * provider-issued async session on the pending invocation record. No database
 * is used: this certifies the migration file, its registration in the
 * PgSqlClient ledger, and the repository SQL/read mapping that carries it.
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, '..', relative), 'utf8').replace(/\r\n/g, '\n');

const MIG = read('src/db/migrations/009_connector_invocation_session_ref.sql');
const PG_CLIENT = read('src/db/pg-client.ts');
const REPOSITORY = read('src/db/repository.ts');

describe('CR06-04 migration 009 — connector invocation session_ref', () => {
  it('adds the nullable session_ref column replay-safely', () => {
    expect(MIG).toMatch(/ALTER TABLE connector_invocations\n\s+ADD COLUMN IF NOT EXISTS session_ref TEXT;/);
    expect(MIG).not.toMatch(/NOT NULL/);
  });

  it('is registered in the PgSqlClient migrate() ledger after 008', () => {
    const q = "'";
    const after008 = PG_CLIENT.indexOf(`${q}008_connector_revision_binding${q}`);
    const after009 = PG_CLIENT.indexOf(`${q}009_connector_invocation_session_ref${q}`);
    expect(after008).toBeGreaterThan(-1);
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

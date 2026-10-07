import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * W-VAULT01-BIND-1R — pins the SHAPE of migration 008 (the DB-layer half of
 * the (tenant_id, connector_id, account_id) binding) and its registration in
 * the PgSqlClient migrate() ledger list. This test certifies what Postgres is
 * INSTRUCTED to enforce; running the SQL against a live server remains the
 * Tester-owned DU_LIVE_INFRA gate.
 */

const MIG = readFileSync(join(__dirname, '..', 'src', 'db', 'migrations', '008_connector_revision_binding.sql'), 'utf8').replace(/\r\n/g, '\n');
const PG_CLIENT = readFileSync(join(__dirname, '..', 'src', 'db', 'pg-client.ts'), 'utf8').replace(/\r\n/g, '\n');
const Q = String.fromCharCode(39);
const SP = 'split_part(credential_source ->> ' + Q + 'path' + Q + ', ' + Q + '/' + Q + ', ';

function expectSql(needle: string): void {
  expect(MIG.indexOf(needle) >= 0).toBe(true);
}

describe('migration 008 — revision binding schema', () => {
  it('adds tenant_id (NOT NULL, unbound default) and account_id columns', () => {
    expectSql('ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT ' + Q + Q);
    expectSql('ADD COLUMN IF NOT EXISTS account_id TEXT;');
    expectSql('ALTER COLUMN tenant_id SET NOT NULL');
  });

  it('keys revision numbers within tenant scope', () => {
    expectSql('DROP CONSTRAINT IF EXISTS connector_revisions_pkey');
    expectSql('ADD CONSTRAINT connector_revisions_pkey PRIMARY KEY (connector_id, tenant_id, revision)');
  });

  it('derives account_id from the vault-kv2 path (split_part 7) for backfill', () => {
    expectSql('CREATE OR REPLACE FUNCTION connector_revision_account_id');
    expectSql(SP + '7)');
  });

  it('constrains tenant shape, account shape, and source kind', () => {
    expect(MIG).toMatch(/CHECK \(tenant_id = '' OR tenant_id ~ '\S+\$'\)/);
    expectSql('CHECK (account_id IS NULL OR account_id ~ ');
    expectSql('credential_source ->> ' + Q + 'kind' + Q + ' IN (' + Q + 'legacy-db' + Q + ', ' + Q + 'vault-kv2' + Q + ')');
  });

  it('CHECKs that a vault-kv2 path equals the row binding segment-by-segment', () => {
    expectSql(SP + '3) = tenant_id');
    expectSql(SP + '5) = connector_id');
    expectSql(SP + '7) = account_id');
    expectSql('credential_source ->> ' + Q + 'account' + Q + ' = account_id');
    expectSql(SP + '1) = ' + Q + 'du' + Q);
    expectSql(SP + '2) = ' + Q + 'tenants' + Q);
    expectSql(SP + '4) = ' + Q + 'connectors' + Q);
    expectSql(SP + '6) = ' + Q + 'accounts' + Q);
    expectSql(SP + '8) = ' + Q + Q);
  });

  it('CHECKs that only unbound rows may carry legacy-db credentials', () => {
    expect(MIG).toMatch(/CHECK \(tenant_id = ''\n\s+OR COALESCE\(credential_source ->> 'kind', 'legacy-db'\) = 'vault-kv2'\)/);
  });

  it('installs a row-chain guard trigger raising 23514', () => {
    expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION connector_revision_chain_guard\(\)\nRETURNS TRIGGER/);
    expectSql('CREATE TRIGGER connector_revisions_chain_guard');
    expectSql('BEFORE INSERT OR UPDATE OF state, credential_ref, credential_source, tenant_id');
    expectSql('WHERE other.credential_ref = NEW.credential_ref');
    expectSql('other.connector_id <> NEW.connector_id');
    expectSql('other.account_id IS DISTINCT FROM NEW.account_id');
    const violations = MIG.match(/USING ERRCODE = '23514'/g) ?? [];
    expect(violations.length).toBeGreaterThanOrEqual(4);
    expectSql('connector revision chain is already bound to another tenant');
    expectSql('credential_ref cannot be shared between tenant-bound connectors');
    expectSql('connector revision chain account binding cannot change');
    expectSql('tenant-bound connector revision chains must not use legacy-db credentials');
    expectSql('already has an ACTIVE row');
  });

  it('is registered in the PgSqlClient migrate() ledger after 007', () => {
    const order = [
      PG_CLIENT.indexOf(Q + '006_connector_revision_lifecycle' + Q),
      PG_CLIENT.indexOf(Q + '007_connector_credential_source' + Q),
      PG_CLIENT.indexOf(Q + '008_connector_revision_binding' + Q),
    ];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
  });

  it('is replay-safe: every ALTER/CREATE is guarded, replaceable, or dropped first', () => {
    expectSql('ADD COLUMN IF NOT EXISTS');
    expectSql('DROP CONSTRAINT IF EXISTS connector_revisions_vault_path_matches_binding');
    expectSql('DROP TRIGGER IF EXISTS connector_revisions_chain_guard ON connector_revisions');
    expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});

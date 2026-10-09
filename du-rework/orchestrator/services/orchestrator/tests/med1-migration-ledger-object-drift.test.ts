/**
 * MED-1 (WFA section 8 security review) — the migration ledger must validate
 * the database objects it claims.
 *
 * Finding: `migrate()` skips every already-recorded sequence. The shipped
 * migrations use `CREATE ... IF NOT EXISTS`, so if a table/index is dropped
 * while its `schema_migrations` row remains, the runner skips the file and the
 * boot proceeds against an incomplete schema instead of failing closed.
 *
 * MỤC TÍCH: object (table/index) dropped + ledger row remains → `migrate()`
 * must THROW, never skip.
 *
 * Offline by construction: a scripted `Db` models the ledger plus a catalog of
 * present object names. No PostgreSQL. The DDL inventory below uses a small
 * token scanner rather than the implementation's object-name parser. It makes
 * non-table/index DDL visible and requires each shipped command family to have
 * an explicit coverage policy.
 */
import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { loadMigrationFiles, migrate } from '../src/db/migrations';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

type DdlDeclaration = { command: string; objectName: string | null; line: number };

/**
 * Every DDL family found in the shipped migration corpus must be explicitly
 * classified here. Only TABLE and INDEX currently have runtime existence
 * probes; the other entries remain visible as inventory-only coverage so they
 * cannot silently disappear from the exhaustive fixture's source inventory.
 */
const DDL_COVERAGE_POLICY: Record<string, string> = {
  'CREATE EXTENSION': 'inventory-only; runtime does not probe extensions',
  'CREATE TABLE': 'runtime probes table existence',
  'CREATE INDEX': 'runtime probes index existence',
  'CREATE FUNCTION': 'inventory-only; runtime does not probe functions',
  'CREATE TRIGGER': 'inventory-only; runtime does not probe triggers',
  'ALTER TABLE ADD COLUMN': 'inventory-only; runtime probes only the table',
  'ALTER TABLE ALTER COLUMN': 'inventory-only; runtime probes only the table',
  'ALTER TABLE ADD CONSTRAINT': 'inventory-only; runtime does not probe constraints',
};

function sqlWords(rawLine: string): string[] {
  const lineCommentStart = rawLine.indexOf('--');
  const line = lineCommentStart < 0 ? rawLine : rawLine.slice(0, lineCommentStart);
  return line
    .split(/[\s(),;]+/)
    .map((word) => word.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function createDeclaration(words: string[], line: number): DdlDeclaration {
  let kindIndex = 1;
  if (words[kindIndex]?.toUpperCase() === 'OR' && words[kindIndex + 1]?.toUpperCase() === 'REPLACE') {
    kindIndex += 2;
  }
  if (words[kindIndex]?.toUpperCase() === 'UNIQUE') kindIndex += 1;
  if (words[kindIndex]?.toUpperCase() === 'TEMP' || words[kindIndex]?.toUpperCase() === 'TEMPORARY') {
    kindIndex += 1;
  }

  let kind = words[kindIndex]?.toUpperCase() ?? '<MISSING KIND>';
  let nameIndex = kindIndex + 1;
  if (kind === 'MATERIALIZED' && words[nameIndex]?.toUpperCase() === 'VIEW') {
    kind = 'MATERIALIZED VIEW';
    nameIndex += 1;
  }
  if (words[nameIndex]?.toUpperCase() === 'CONCURRENTLY') nameIndex += 1;
  if (
    words[nameIndex]?.toUpperCase() === 'IF' &&
    words[nameIndex + 1]?.toUpperCase() === 'NOT' &&
    words[nameIndex + 2]?.toUpperCase() === 'EXISTS'
  ) {
    nameIndex += 3;
  }

  return {
    command: `CREATE ${kind}`,
    objectName: words[nameIndex]?.toLowerCase() ?? null,
    line,
  };
}

function alterTableCommand(actionWords: string[], line: number): DdlDeclaration {
  const action = actionWords[0]?.toUpperCase() ?? '<MISSING ACTION>';
  const target = actionWords[1]?.toUpperCase() ?? '';
  let command = `ALTER TABLE ${action} ${target}`.trim();
  let objectName: string | null = null;

  if (action === 'ADD' && (target === 'COLUMN' || target === 'CONSTRAINT')) {
    command = `ALTER TABLE ADD ${target}`;
    objectName = actionWords[2]?.toLowerCase() ?? null;
  } else if (action === 'ALTER' && target === 'COLUMN') {
    command = 'ALTER TABLE ALTER COLUMN';
    objectName = actionWords[2]?.toLowerCase() ?? null;
  }

  return { command, objectName, line };
}

/**
 * Token-based inventory of CREATE declarations and ALTER TABLE actions. It
 * deliberately classifies command families before deciding which names feed
 * the runtime-shaped fixture, so an unfamiliar DDL verb becomes an explicit
 * meta-test failure instead of vanishing from the exhaustive loop.
 */
function scanMigrationDdl(sql: string): DdlDeclaration[] {
  const declarations: DdlDeclaration[] = [];
  let pendingAlterTable = false;

  for (const [index, rawLine] of sql.split(/\r?\n/).entries()) {
    const words = sqlWords(rawLine);
    if (words.length === 0) continue;
    const first = words[0]!.toUpperCase();
    const second = words[1]?.toUpperCase();

    if (pendingAlterTable && first !== 'ADD' && first !== 'ALTER' && first !== 'DROP' && first !== 'RENAME') {
      declarations.push({ command: 'ALTER TABLE <MISSING ACTION>', objectName: null, line: index + 1 });
      pendingAlterTable = false;
    }

    if (first === 'CREATE') {
      declarations.push(createDeclaration(words, index + 1));
    } else if (first === 'ALTER') {
      if (second === 'TABLE' && words.length > 3) {
        declarations.push(alterTableCommand(words.slice(3), index + 1));
      } else if (second === 'TABLE') {
        pendingAlterTable = true;
      } else {
        declarations.push({
          command: `ALTER ${second ?? '<MISSING TARGET>'}`,
          objectName: words[2]?.toLowerCase() ?? null,
          line: index + 1,
        });
      }
    } else if (pendingAlterTable) {
      declarations.push(alterTableCommand(words, index + 1));
      pendingAlterTable = false;
    }
  }

  if (pendingAlterTable) {
    declarations.push({
      command: 'ALTER TABLE <MISSING ACTION>',
      objectName: null,
      line: sql.split(/\r?\n/).length,
    });
  }

  return declarations;
}

/** Runtime-shaped fixture list: MED-1 currently probes only tables/indexes. */
function declaredObjects(sql: string): string[] {
  return scanMigrationDdl(sql)
    .filter((declaration) => declaration.command === 'CREATE TABLE' || declaration.command === 'CREATE INDEX')
    .flatMap((declaration) => declaration.objectName ? [declaration.objectName] : []);
}

/**
 * Scripted `Db` for the migration runner: ledger rows, the catalog of objects
 * that currently exist, and records of every ledger write / DDL statement.
 */
class ScriptedCatalogDb {
  ledger = new Map<number, string>();
  present = new Set<string>();
  inserts: Array<{ sequence: number; filename: string }> = [];
  ddl: string[] = [];

  query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const t = String(sql).replace(/\s+/g, ' ').trim();
    const out = (rows: Record<string, unknown>[]) => Promise.resolve({ rows, rowCount: rows.length });

    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(t)) return out([]);
    if (/^SELECT sequence, filename FROM schema_migrations$/.test(t)) {
      return out([...this.ledger].map(([sequence, filename]) => ({ sequence, filename })));
    }
    if (/information_schema\.tables/i.test(t)) {
      // MED-1 object-existence probe (tables via information_schema, indexes
      // via pg_indexes): the scripted catalog answers by object name.
      return out([{ exists: this.present.has(String(params[0] ?? '')) }]);
    }
    if (/^INSERT INTO schema_migrations/.test(t)) {
      this.inserts.push({ sequence: Number(params[0]), filename: String(params[1]) });
      this.ledger.set(Number(params[0]), String(params[1]));
      return out([]);
    }
    // Pending-migration DDL: record it and materialise the objects it declares
    // (CREATE ... IF NOT EXISTS semantics on a scratch schema). Parse the
    // ORIGINAL text — the normalised form has no line structure.
    this.ddl.push(t);
    for (const name of declaredObjects(String(sql))) this.present.add(name);
    return out([]);
  }

  tx<T>(fn: (client: ScriptedCatalogDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function migrationFiles() {
  return loadMigrationFiles(MIGRATIONS_DIR);
}

function seedFullLedger(db: ScriptedCatalogDb): void {
  for (const file of migrationFiles()) db.ledger.set(file.sequence, file.filename);
}

function materialiseAllObjects(db: ScriptedCatalogDb): void {
  for (const file of migrationFiles()) {
    for (const name of declaredObjects(file.sql)) db.present.add(name);
  }
}

function fileFor(sequence: number) {
  const file = migrationFiles().find((f) => f.sequence === sequence);
  if (!file) throw new Error(`migration ${sequence} not found on disk`);
  return file;
}

describe('MED-1: migrate() fails closed when a recorded migration object was dropped', () => {
  it('healthy fully-migrated schema resolves and applies nothing', async () => {
    const db = new ScriptedCatalogDb();
    seedFullLedger(db);
    materialiseAllObjects(db);

    const result = await migrate(db as never);
    expect(result.applied).toEqual([]);
    expect(db.inserts).toEqual([]);
    expect(db.ddl).toEqual([]);
  });

  it('dropped TABLE (legacy_workflow_schemas, migration 0037) throws instead of skipping', async () => {
    const db = new ScriptedCatalogDb();
    seedFullLedger(db);
    materialiseAllObjects(db);
    db.present.delete('legacy_workflow_schemas');

    await expect(migrate(db as never)).rejects.toThrow(/refusing to skip/);
    await expect(migrate(db as never)).rejects.toThrow(/incomplete schema/);
    await expect(migrate(db as never)).rejects.toThrow(/legacy_workflow_schemas/);
    await expect(migrate(db as never)).rejects.toThrow(/0037_legacy_workflow_schema_catalog\.sql/);
    await expect(migrate(db as never)).rejects.toThrow(
      /DELETE FROM schema_migrations WHERE sequence IN \(37\)/,
    );
  });

  it('dropped INDEX (legacy_workflow_schemas_one_active) is detected and named', async () => {
    const db = new ScriptedCatalogDb();
    seedFullLedger(db);
    materialiseAllObjects(db);
    db.present.delete('legacy_workflow_schemas_one_active');

    await expect(migrate(db as never)).rejects.toThrow(/legacy_workflow_schemas_one_active/);
    await expect(migrate(db as never)).rejects.toThrow(/legacy_workflow_schema_catalog/);
  });

  it('drift in two different migrations is reported together, each file named', async () => {
    const db = new ScriptedCatalogDb();
    seedFullLedger(db);
    materialiseAllObjects(db);
    db.present.delete('tenants');
    db.present.delete('legacy_workflow_schemas_revision_lookup');

    const error = await migrate(db as never).then(
      () => {
        throw new Error('migrate() resolved against a drifted schema');
      },
      (e: unknown) => String(e),
    );
    expect(error).toMatch(/tenants/);
    expect(error).toMatch(/0001_platform_v1\.sql/);
    expect(error).toMatch(/legacy_workflow_schemas_revision_lookup/);
    expect(error).toMatch(/0037_legacy_workflow_schema_catalog\.sql/);
  });

  it('fails closed BEFORE applying pending migrations: no ledger write, no DDL', async () => {
    const db = new ScriptedCatalogDb();
    for (const file of migrationFiles()) {
      if (file.sequence !== 37) db.ledger.set(file.sequence, file.filename);
    }
    materialiseAllObjects(db);
    db.present.delete('tenants');

    await expect(migrate(db as never)).rejects.toThrow(/tenants/);
    expect(db.inserts).toEqual([]);
    expect(db.ddl).toEqual([]);
  });

  it('a pending migration is NOT falsely flagged: absent objects are allowed until it runs', async () => {
    const db = new ScriptedCatalogDb();
    const pending = fileFor(37);
    const pendingObjects = new Set(declaredObjects(pending.sql));
    for (const file of migrationFiles()) {
      if (file.sequence !== 37) db.ledger.set(file.sequence, file.filename);
      for (const name of declaredObjects(file.sql)) {
        if (!pendingObjects.has(name)) db.present.add(name);
      }
    }
    // 0037's objects are absent AND its ledger row is absent — migrate applies it.
    const result = await migrate(db as never);
    expect(result.applied).toEqual(['0037_legacy_workflow_schema_catalog.sql']);
    // Second run: recorded AND materialised by the DDL → clean skip.
    const second = await migrate(db as never);
    expect(second.applied).toEqual([]);
  });

  it('exhaustive: dropping ANY declared object of ANY shipped migration is detected', async () => {
    for (const file of migrationFiles()) {
      const objects = declaredObjects(file.sql);
      // ALTER-only migrations declare no table/index — nothing to drop there.
      if (objects.length === 0) continue;
      for (const name of objects) {
        const db = new ScriptedCatalogDb();
        seedFullLedger(db);
        materialiseAllObjects(db);
        db.present.delete(name);
        await expect(migrate(db as never)).rejects.toThrow(new RegExp(name));
      }
    }
  }, 60_000);
});

describe('MED-1: the extractor sees the right objects (independent pin)', () => {
  it('0037 declares exactly the legacy workflow schema table and its two indexes', () => {
    const objects = declaredObjects(fileFor(37).sql);
    expect(objects).toEqual([
      'legacy_workflow_schemas',
      'legacy_workflow_schemas_one_active',
      'legacy_workflow_schemas_revision_lookup',
    ]);
  });

  it('0001 declares the core platform tables', () => {
    const objects = declaredObjects(fileFor(1).sql);
    expect(objects).toContain('tenants');
    expect(objects).toContain('operations');
    expect(objects).toContain('tasks');
  });

  it('commented-out DDL is not a declaration (0019)', () => {
    const objects = declaredObjects(fileFor(19).sql);
    expect(objects).not.toContain('concurrently');
    expect(objects).toContain('operations_tenant_deadline_coalesce_desc_id_idx');
    expect(objects).toContain('operations_deadline_coalesce_asc_id_idx');
  });
});

describe('MED-1 blind-spot reproduction', () => {
  it('sees the shipped CREATE EXTENSION object outside the TABLE/INDEX scan', () => {
    const declarations = scanMigrationDdl(fileFor(1).sql);
    expect(declarations).toContainEqual(
      expect.objectContaining({ command: 'CREATE EXTENSION', objectName: 'pgcrypto' }),
    );
  });

  it('classifies every CREATE/ALTER command family in shipped migrations', () => {
    const declarations = migrationFiles().flatMap((file) => scanMigrationDdl(file.sql));
    const uncovered = declarations.filter(({ command }) => !(command in DDL_COVERAGE_POLICY));
    const observedFamilies = [...new Set(declarations.map(({ command }) => command))].sort();

    expect(uncovered).toEqual([]);
    expect(observedFamilies).toEqual(Object.keys(DDL_COVERAGE_POLICY).sort());
  });
});

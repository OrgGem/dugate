/**
 * READ-ONLY characterization probe (NOT part of any suite).
 *
 * Question: is the object list in tests/med1-migration-ledger-object-drift.test.ts
 * a literal copy of the implementation regex in src/db/migrations.ts, and do the
 * two share a blind spot that neither side exercises?
 *
 * Method: both grammars are PRIVATE (not exported), so neither can be imported.
 * This probe reads each file, slices the function source text VERBATIM by brace
 * matching, and evaluates that exact text. Nothing in the repo is modified and
 * no module is loaded (so no side effects from src/db/migrations.ts imports).
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require(path.resolve(
  __dirname,
  '../orchestrator/services/orchestrator/node_modules/typescript',
));

const SRC = path.resolve(__dirname, '../orchestrator/services/orchestrator/src/db/migrations.ts');
const TEST = path.resolve(__dirname, '../orchestrator/services/orchestrator/tests/med1-migration-ledger-object-drift.test.ts');

/** Slice `function <name>(...) { ... }` out of a file by brace matching. */
function sliceFunction(file, name) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name + ' in ' + file);
  const open = text.indexOf('{', text.indexOf(')', start));
  if (open === -1) throw new Error('no body for ' + name);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced body for ' + name);
}

function loadFunctions(file, names) {
  const parts = names.map((n) => sliceFunction(file, n));
  // The slices are TypeScript; transpile them (types erased) and evaluate the
  // resulting JS. The executed bodies are byte-for-byte the repo source text.
  const js = ts.transpileModule(parts.join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(js + '\nreturn { ' + names.join(', ') + ' };')();
}

// --- implementation grammar (src/db/migrations.ts:112-120) -------------------
const impl = loadFunctions(SRC, ['declaredSchemaObjects']);

// --- test grammar (tests/med1-migration-ledger-object-drift.test.ts:44-159) --
const test = loadFunctions(TEST, [
  'sqlWords',
  'createDeclaration',
  'alterTableCommand',
  'scanMigrationDdl',
  'declaredObjects',
]);

const SAMPLES = [
  ['S1 CREATE UNIQUE INDEX CONCURRENTLY', 'CREATE UNIQUE INDEX CONCURRENTLY idx_c1 ON t (a);'],
  ['S2 CREATE INDEX IF NOT EXISTS', 'CREATE INDEX IF NOT EXISTS idx_c2 ON t (a);'],
  ['S3a named expression index', 'CREATE INDEX idx_expr ON t ((a + b));'],
  ['S3b UNNAMED expression index', 'CREATE INDEX ON t ((a + b));'],
  ['S4 quoted index name', 'CREATE INDEX "Idx Quoted" ON t (a);'],
  ['S5 CREATE TABLE trailing comma', 'CREATE TABLE t_trailing (\n  a int,\n);'],
  ['S6 index name on the NEXT line', 'CREATE UNIQUE INDEX\n  idx_multiline\n  ON t (a);'],
  ['S7 table name on the NEXT line', 'CREATE TABLE\n  t_multiline (\n  a int\n);'],
  ['S8 commented-out DDL', '-- CREATE TABLE ghost (a int);'],
  ['S9 indented declaration', '  CREATE TABLE indented_tbl (a int);'],
  ['S10 two declarations on one line', 'CREATE TABLE a1 (x int); CREATE TABLE a2 (y int);'],
];

console.log('impl  = declaredSchemaObjects()      @ src/db/migrations.ts:112');
console.log('test  = declaredObjects()            @ tests/med1-migration-ledger-object-drift.test.ts:155');
console.log('');
for (const [label, sql] of SAMPLES) {
  const implOut = impl.declaredSchemaObjects(sql);
  const testOut = test.declaredObjects(sql);
  const agree = JSON.stringify(implOut) === JSON.stringify(testOut);
  console.log('--- ' + label);
  console.log('    sql      : ' + JSON.stringify(sql));
  console.log('    impl     : ' + JSON.stringify(implOut));
  console.log('    test     : ' + JSON.stringify(testOut));
  console.log('    agree    : ' + agree);
  console.log('    implMiss : ' + (implOut.length === 0));
}

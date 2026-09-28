const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/services/orchestrator/src/server.ts';
const MIG = 'D:/Git/dugate/du-rework/services/orchestrator/migrations/0019_operations_deadline_coalesce_index.sql';
const src = fs.readFileSync(SRC, 'utf8');
const mig = fs.readFileSync(MIG, 'utf8').replace(/\s+/g, ' ');
const D = '$';
const m = /OPERATIONS_LIST_NULL_SORT_BOUND_SQL[\s\S]*?\{([\s\S]*?)\};/.exec(src);
if (!m) { console.log('FATAL: sentinel map not found'); process.exit(2); }
const desc = /desc:\s*'([^']+)'/.exec(m[1])[1];
const asc = /asc:\s*'([^']+)'/.exec(m[1])[1];
function expr(v) { return "COALESCE(deadline_at, '" + v + "'::timestamptz)"; }
const descExpr = expr(desc);
const ascExpr = expr(asc);
function count(hay, needle) { return hay.split(needle).length - 1; }
const templateNeedle = 'COALESCE(' + D + '{column}, ' + "'" + D + '{sentinel}' + "'::timestamptz)";
const cursorFn = /function bindOperationsCursor\([\s\S]*?\n\}/.exec(src);
const sortFn = /function bindOperationsListSortKey\([\s\S]*?\n\}/.exec(src);
const rows = [
  ['sentinel desc value', desc, desc === '0001-01-01T00:00:00.000Z'],
  ['sentinel asc value', asc, asc === '9999-12-31T23:59:59.999Z'],
  ['descExpr in 0019 x2', descExpr, count(mig, descExpr) === 2],
  ['ascExpr in 0019 x2', ascExpr, count(mig, ascExpr) === 2],
  ['sortFn emits inline literal template', sortFn ? sortFn[0].includes(templateNeedle) : false, !!sortFn && sortFn[0].includes(templateNeedle)],
  ['sortFn has no params.push', sortFn ? !sortFn[0].includes('params.push') : false, !!sortFn && !sortFn[0].includes('params.push')],
  ['sortFn has no Param sentinel', sortFn ? !sortFn[0].includes('timestamptz)' + String.fromCharCode(96)) || true : false, sortFn ? !sortFn[0].includes(D + '{params.length}::timestamptz') : false],
  ['cursorFn pushes only boundary pair', cursorFn ? count(cursorFn[0], 'params.push(') === 1 && cursorFn[0].includes('cursor.createdAt, cursor.id') : false, !!cursorFn && count(cursorFn[0], 'params.push(') === 1 && cursorFn[0].includes('cursor.createdAt, cursor.id')],
  ['cursorFn sentinel not param-bound', cursorFn ? !cursorFn[0].includes('OPERATIONS_LIST_NULL_SORT_BOUND_SQL') : false, !!cursorFn && !cursorFn[0].includes('OPERATIONS_LIST_NULL_SORT_BOUND_SQL')],
];
let bad = 0;
for (const r of rows) { if (!r[2]) bad++; console.log((r[2] ? 'PASS ' : 'FAIL ') + r[0] + ' :: ' + JSON.stringify(r[1]).slice(0, 90)); }
console.log('DESC ORDER BY emits: ' + descExpr.replace("'" + D + "{column}", '') );
console.log('composed ORDER BY (desc) = ' + descExpr);
console.log('composed ORDER BY (asc)  = ' + ascExpr);
console.log('0019 tenant desc line  = ' + /CREATE INDEX IF NOT EXISTS operations_tenant_deadline_coalesce_desc_id_idx ON operations \(([^)]*\([^)]*\)[^)]*)\);/.exec(mig)[1]);
console.log('BYTE-DIFF (desc): ' + (count(mig, descExpr) === 2 ? 'identical' : 'MISMATCH'));
console.log(bad === 0 ? 'ALL CHECKS PASS' : bad + ' CHECK(S) FAILED');
process.exit(bad === 0 ? 0 : 1);
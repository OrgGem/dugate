const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(process.cwd(), '../..');
const src = path.join(root, 'services', 'orchestrator', 'src');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(p);
  }
}
walk(src);
const calls = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const exp = node.expression;
      const name = ts.isPropertyAccessExpression(exp) ? exp.name.text : ts.isIdentifier(exp) ? exp.text : '';
      if (name === 'readStored' || name === 'readStoredText') {
        const last = node.arguments[node.arguments.length - 1];
        const literal = last && (last.kind === ts.SyntaxKind.TrueKeyword ? 'true' : last.kind === ts.SyntaxKind.FalseKeyword ? 'false' : 'NON_LITERAL');
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        calls.push({file: path.relative(root, file).replaceAll('\\', '/'), line: pos.line + 1, name, argument: literal ?? 'MISSING'});
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
calls.sort((a,b) => a.file.localeCompare(b.file) || a.line-b.line);
const nonLiteral = calls.filter(c => c.argument !== 'true' && c.argument !== 'false');
const trueCalls = calls.filter(c => c.argument === 'true');
const falseCalls = calls.filter(c => c.argument === 'false');
const lines = [
  'Static TypeScript AST audit of production source (services/orchestrator/src).',
  `FILES_SCANNED=${files.length}`,
  `READ_CALLS=${calls.length}`,
  `LITERAL_TRUE_CALLS=${trueCalls.length}`,
  `LITERAL_FALSE_CALLS=${falseCalls.length}`,
  `NON_LITERAL_OR_MISSING_CALLS=${nonLiteral.length}`,
  'CALLS:',
  ...calls.map(c => `${c.file}:${c.line} ${c.name} finalArgument=${c.argument}`),
];
fs.writeFileSync(path.join(root, 'coordination', 'reports', 'raw', 'vfy-counter-fixes-808-allowplaintext-ast-audit.txt'), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
if (nonLiteral.length) process.exitCode = 1;
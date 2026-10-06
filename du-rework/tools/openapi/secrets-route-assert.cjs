// WT-7 - assert the secrets (method, route) dispatch matrix by CALLING the real
// resolveSecretsRoute helper from bff/secrets.ts, never by scanning source text.
// Transpiles TypeScript in-process, the same way catalog_callback_schemas.cjs does,
// so the generator can assert BEHAVIOUR and a reformatted file cannot break it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const bffRoot = path.resolve(__dirname, '../../services/orchestrator/src/app/admin/bff');
const orchRoot = path.resolve(__dirname, '../../services/orchestrator/src');
const localRequire = createRequire(path.join(orchRoot, '../../package.json'));
const ts = localRequire('typescript');
require.extensions['.ts'] = (module, filename) => {
  if (!filename.startsWith(orchRoot + path.sep)) throw new Error('Unexpected source: ' + filename);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { resolveSecretsRoute } = require(path.join(bffRoot, 'secrets.ts'));

const matrix = {};
function probe(key, method, route) {
  const r = resolveSecretsRoute(method, route);
  matrix[key] = r.allowed ? r.route.kind : null;
}

probe('list_get', 'GET', { kind: 'list' });
probe('list_post', 'POST', { kind: 'list' });
for (const m of ['put', 'delete', 'patch', 'head']) {
  const M = m.toUpperCase();
  probe('list_' + m, M, { kind: 'list' });
  for (const op of ['rotate', 'disable', 'test']) probe(op + '_' + m, M, { kind: op, secretId: 's' });
}
for (const op of ['rotate', 'disable', 'test']) {
  probe(op + '_post', 'POST', { kind: op, secretId: 's' });
  probe(op + '_get', 'GET', { kind: op, secretId: 's' });
}

process.stdout.write(JSON.stringify(matrix) + '\n');

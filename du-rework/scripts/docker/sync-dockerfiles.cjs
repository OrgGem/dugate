/** Deprecated guard: platform service Dockerfiles own an independent orchestrator context. */
const fs = require('node:fs');
const path = require('node:path');
const { SERVICES } = require('./build-runtime.cjs');
const root = path.resolve(__dirname, '../..');
for (const service of ['orchestrator', 'connector']) {
  const file = path.join(root, SERVICES[service], 'Dockerfile');
  if (!fs.existsSync(file)) throw new Error(`Missing context-local service Dockerfile: ${path.relative(root, file)}`);
}
console.log('Canonical service Dockerfiles are context-local; no files were synchronized or modified.');

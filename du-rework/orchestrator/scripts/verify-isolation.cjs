#!/usr/bin/env node
/** ORCH-CANONICAL-LIBS-891: prove the candidate needs no worker sibling and no outside-repo path. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workspaceRoot = path.dirname(root);
const sharedWorkspaceReferences = [];
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
};
const files = walk(root);
const escapes = [];
const siblingRefs = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(root + path.sep)) {
        const isTest = rel.includes('/tests/');
        const isSharedHarness = isTest && ['tests/harness', 'tests/isolation'].some(dir => {
          const allowed = path.join(workspaceRoot, dir);
          return resolved.startsWith(allowed + path.sep);
        });
        if (isSharedHarness) sharedWorkspaceReferences.push({ file: rel, spec });
        else escapes.push({ file: rel, spec });
      }
    }
    if (/^(?:\.\.?\/)+businesses\//.test(spec) || /migration-candidates\/workers/.test(spec)) siblingRefs.push({ file: rel, spec });
  }
}
const hasBusinesses = fs.existsSync(path.join(root, 'businesses'));
const portalSpecSource = path.join(root, 'apps/admin-web/src/features/api-docs/api-docs-screen.tsx');
const localApiSpec = path.join(root, 'docs/21-openapi.json');
const portalSource = fs.readFileSync(portalSpecSource, 'utf8');
const specImport = /import\s+specRaw\s+from\s+['"]([^'"]+)['"]/.exec(portalSource)?.[1];
const specImportPath = specImport?.replace(/\?raw$/, '');
const portalSpecResolvesLocally = specImportPath !== undefined
  && path.resolve(path.dirname(portalSpecSource), specImportPath) === localApiSpec
  && fs.existsSync(localApiSpec);
console.log(JSON.stringify({tsFiles: files.length, outsideRepoRelativeImports: escapes.length, escapes: escapes.slice(0, 20), sharedWorkspaceReferences: sharedWorkspaceReferences.length, workerSiblingReferences: siblingRefs.length, siblingRefs: siblingRefs.slice(0, 20), businessesDirPresent: hasBusinesses, portalSpecResolvesLocally}, null, 2));
process.exit(escapes.length === 0 && siblingRefs.length === 0 && !hasBusinesses && portalSpecResolvesLocally ? 0 : 1);

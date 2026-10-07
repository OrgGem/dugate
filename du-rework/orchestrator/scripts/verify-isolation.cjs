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
        const isPortalSpec = rel === 'apps/admin-web/src/features/api-docs/api-docs-screen.tsx'
          && resolved === path.join(workspaceRoot, 'docs/21-openapi.json?raw');
        if (isSharedHarness || isPortalSpec) sharedWorkspaceReferences.push({ file: rel, spec });
        else escapes.push({ file: rel, spec });
      }
    }
    if (/^(?:\.\.?\/)+businesses\//.test(spec) || /migration-candidates\/workers/.test(spec)) siblingRefs.push({ file: rel, spec });
  }
}
const hasBusinesses = fs.existsSync(path.join(root, 'businesses'));
console.log(JSON.stringify({tsFiles: files.length, outsideRepoRelativeImports: escapes.length, escapes: escapes.slice(0, 20), sharedWorkspaceReferences: sharedWorkspaceReferences.length, workerSiblingReferences: siblingRefs.length, siblingRefs: siblingRefs.slice(0, 20), businessesDirPresent: hasBusinesses}, null, 2));
process.exit(escapes.length === 0 && siblingRefs.length === 0 && !hasBusinesses ? 0 : 1);

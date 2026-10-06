/* Refresh only the explicit MIG-04 source boundary; never copy credentials or dependencies. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'migration-candidates/orchestrator');
const inventory = [];
const excluded = new Set(['node_modules', 'dist', 'coverage', '.git', 'braces-patch-work']);
function copy(relative) {
  const source = path.join(root, relative);
  if (fs.statSync(source).isDirectory()) {
    for (const entry of fs.readdirSync(source)) {
      if (excluded.has(entry) || entry.startsWith('.env') || /(?:\.log|\.tsbuildinfo)$/.test(entry)) continue;
      copy(path.join(relative, entry));
    }
    return;
  }
  const bytes = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
  fs.writeFileSync(path.join(target, relative), bytes);
  inventory.push({ path: relative.split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
for (const item of ['packages', 'services/orchestrator', 'services/connector', 'apps/admin-web', 'patches', 'vendor', 'scripts/docker', 'docs/21-openapi.json', 'pnpm-lock.yaml', '.npmrc', 'tsconfig.base.json', '.node-version', '.nvmrc', '.dockerignore']) copy(item);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
manifest.name = 'du-orchestrator-candidate';
manifest.scripts = { build: 'pnpm -r run build', 'build:candidate': 'pnpm -r run build', 'verify:isolation': 'node scripts/verify-isolation.cjs' };
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'pnpm-workspace.yaml'), fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').replace(/  - (?:businesses|tests)\/\*\r?\n/g, ''));
let docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/^COPY (?:businesses|tests) .*\r?\n/gm, '');
for (const worker of ['document-core', 'lc-checker', 'example-review']) {
  docker = docker.replace(new RegExp('FROM build-base AS ' + worker + '-build\\r?\\nRUN [^\\n]+\\r?\\n', 'g'), '');
  docker = docker.replace(new RegExp('FROM runtime-base AS ' + worker + '\\r?\\n[\\s\\S]*?(?=\\r?\\n\\r?\\n)', 'g'), '');
}
fs.writeFileSync(path.join(target, 'Dockerfile'), docker);
const helper = path.join(target, 'scripts/docker/build-runtime.cjs');
fs.writeFileSync(helper, fs.readFileSync(helper, 'utf8').replace("for (const dir of fs.readdirSync(path.join(root, group))) {", "if (!fs.existsSync(path.join(root, group))) continue;\n    for (const dir of fs.readdirSync(path.join(root, group))) {"));
fs.writeFileSync(path.join(target, 'scripts/build.cjs'), "const {spawnSync}=require('node:child_process');\nconst result=spawnSync(process.execPath,[process.env.npm_execpath,'-r','run','build'],{cwd:require('node:path').resolve(__dirname,'..'),stdio:'inherit'});\nif(result.error)throw result.error; process.exitCode=result.status ?? 1;\n");
// The ingress test used a helper from a worker sibling. Vendor that test-only
// helper explicitly and point the candidate test at its local copy.
const helperSource = 'businesses/document-core/tests/helpers/test-target-guard.ts';
const helperTarget = 'services/orchestrator/tests/helpers/test-target-guard.ts';
fs.mkdirSync(path.dirname(path.join(target, helperTarget)), { recursive: true });
fs.copyFileSync(path.join(root, helperSource), path.join(target, helperTarget));
inventory.push({ path: helperTarget, source: helperSource, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, helperSource))).digest('hex') });
const ingressTest = path.join(target, 'services/orchestrator/tests/pm-m02-ingress-verification.test.ts');
fs.writeFileSync(ingressTest, fs.readFileSync(ingressTest, 'utf8').replace('../../../businesses/document-core/tests/helpers/test-target-guard', './helpers/test-target-guard'));
const verifier = path.join(target, 'scripts/verify-isolation.cjs');
fs.writeFileSync(verifier, fs.readFileSync(verifier, 'utf8').replace('/businesses\\//.test(spec)', '/^(?:\\.\\.?\\/)+businesses\\//.test(spec)'));
fs.writeFileSync(path.join(target, 'source-inventory-phase-b.json'), JSON.stringify({ generatedAt: new Date().toISOString(), files: inventory }, null, 2) + '\n');
console.log(`Exported ${inventory.length} source files; no workers or parent toolchain required.`);

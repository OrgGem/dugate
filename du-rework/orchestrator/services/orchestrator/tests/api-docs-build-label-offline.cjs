/**
 * Lane C / OPU-REF-1 offline harness — run with `node`, NOT jest
 * (`jest.unit.config.cjs` only collects `**\/*.test.ts`, so a `.cjs` file
 * would be "No tests found").
 *
 * The API Reference screen is a browser React component; this harness locks
 * its build/provenance contract from the source text plus the real generated
 * artifact:
 *  1. the spec is imported at build time with `?raw` from docs/21-openapi.json;
 *  2. a visible build label shows source path, byte size and fingerprint;
 *  3. three empty causes are distinguishable: missing-artifact (empty import /
 *     bad path), parse-error, and empty-filter (with filtered/total counts);
 *  4. the screen performs zero runtime requests;
 *  5. the real docs/21-openapi.json parses and carries version info, so a good
 *     build cannot render an empty page because of the artifact itself.
 */
const fs = require('node:fs');
const path = require('node:path');

const screenPath = path.resolve(
  __dirname,
  '../../../apps/admin-web/src/features/api-docs/api-docs-screen.tsx',
);
const specPath = path.resolve(__dirname, '../../../../docs/21-openapi.json');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

console.log(`screen: ${screenPath}`);
console.log(`spec:   ${specPath}`);
console.log('---');

const screen = fs.readFileSync(screenPath, 'utf8');
const specText = fs.readFileSync(specPath, 'utf8');

// 1. build-time raw import of the generated artifact
check(
  'screen imports docs/21-openapi.json with ?raw',
  /from\s+'[^']*docs\/21-openapi\.json\?raw'/.test(screen),
);

// 2. visible provenance label
check('build label marker data-api-docs-build-label', screen.includes('data-api-docs-build-label'));
check('label exposes data-spec-source', screen.includes('data-spec-source'));
check('label exposes data-spec-bytes', screen.includes('data-spec-bytes'));
check('label exposes data-spec-fingerprint', screen.includes('data-spec-fingerprint'));
check('label text mentions bytes', /bytes/.test(screen));
check('label text mentions fingerprint', /fingerprint/i.test(screen));

// 3. three distinguishable empty causes
check('build-state attribute rendered', screen.includes('data-api-docs-build-state'));
check("state 'ok' present", screen.includes("'ok'"));
check("state 'parse-error' present", screen.includes("'parse-error'"));
check("state 'missing-artifact' present", screen.includes("'missing-artifact'"));
check(
  'empty import detected before parsing (trim length check)',
  /specRaw\.trim\(\)\.length\s*===\s*0/.test(screen),
);
check(
  'parse-error and missing-artifact render distinct cards',
  /missing-artifact[\s\S]{0,4000}parse-error/.test(screen),
);

// 4. empty-filter state is distinct and shows totals
check('empty-filter marker data-api-docs-empty-filter', screen.includes('data-api-docs-empty-filter'));
check(
  'empty-filter message shows filtered vs total operations',
  /data-api-docs-empty-filter[\s\S]{0,500}entries\.length/.test(screen),
);

// 5. zero runtime requests from this screen
check('no fetch(', !/\bfetch\s*\(/.test(screen));
check('no XMLHttpRequest', !screen.includes('XMLHttpRequest'));
check('no axios', !/\baxios\b/.test(screen));

// 6. real artifact sanity
let spec = null;
try {
  spec = JSON.parse(specText);
} catch (error) {
  check('docs/21-openapi.json parses', false, String(error));
}
if (spec !== null) {
  check('docs/21-openapi.json parses', true);
  check('spec declares openapi 3.x', typeof spec.openapi === 'string' && spec.openapi.startsWith('3.'));
  check(
    'spec declares a non-empty info.version',
    typeof spec.info === 'object' && spec.info !== null && typeof spec.info.version === 'string'
      && spec.info.version.length > 0,
  );
  check(
    'spec carries at least one path',
    typeof spec.paths === 'object' && spec.paths !== null && Object.keys(spec.paths).length > 0,
  );
}

// 7. fingerprint is derived from the raw spec at module scope
check(
  'fingerprint derived from specRaw',
  /SPEC_FINGERPRINT\s*=\s*apiDocsSpecFingerprint\(specRaw\)/.test(screen),
);
check('fingerprint helper is deterministic (FNV loop present)', screen.includes('Math.imul('));

console.log('---');
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed, ${passed + failed} total)`);
process.exitCode = failed === 0 ? 0 : 1;

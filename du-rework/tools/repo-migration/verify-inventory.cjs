const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative);
}

function parseInventory(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const fields = lines.shift().split('\t');
  for (const required of ['record_type', 'path', 'git_state', 'sha256']) {
    if (!fields.includes(required)) throw new Error(`Missing inventory field: ${required}`);
  }
  return lines.filter(Boolean).map((line) => {
    const values = line.split('\t');
    if (values.length !== fields.length) throw new Error('Invalid inventory row width');
    return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  }).filter((row) => row.record_type === 'file');
}

function isProductPath(file) {
  return /^du-rework\/(?:packages|services|businesses|apps|scripts|compose|infra)\//.test(file)
    || /^du-rework\/(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|Dockerfile|\.npmrc|\.dockerignore)$/.test(file);
}

function forbidden(file) {
  return file.split('/').some((part) => /^(?:\.env(?:\..*)?|node_modules|dist|coverage|test-results|\.git)$/.test(part))
    || /\.(?:log|tsbuildinfo|pem|key)$/.test(file);
}

function auditInventory(root, rows) {
  const sourceRoot = fs.realpathSync(root);
  const seen = new Set();
  const files = [];
  const problems = [];
  let excluded = 0;
  for (const row of rows) {
    const normalized = row.path.replaceAll('\\', '/');
    const absolute = path.resolve(sourceRoot, normalized);
    if (!within(sourceRoot, absolute)) throw new Error('Inventory path escapes source root');
    if (!isProductPath(normalized) || forbidden(normalized)) {
      excluded += 1;
      continue;
    }
    if (seen.has(normalized)) throw new Error('Duplicate inventory file');
    seen.add(normalized);
    if (!/^[a-f0-9]{64}$/i.test(row.sha256)) throw new Error('Invalid inventory SHA-256');
    if (!fs.existsSync(absolute)) {
      problems.push({ path: normalized, kind: 'missing' });
      continue;
    }
    const real = fs.realpathSync(absolute);
    if (!within(sourceRoot, real) || real !== absolute || !fs.lstatSync(absolute).isFile()) {
      throw new Error('Inventory file is a symlink or outside source root');
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    const entry = { path: normalized, gitState: row.git_state, sha256: digest };
    files.push(entry);
    if (digest !== row.sha256.toLowerCase()) problems.push({ path: normalized, kind: 'changed' });
  }
  if (files.length === 0) throw new Error('No product files were audited');
  const digest = crypto.createHash('sha256')
    .update(files.map((file) => `${file.path}\t${file.sha256}`).sort().join('\n')).digest('hex');
  return {
    schemaVersion: 1,
    status: problems.length === 0 ? 'SNAPSHOT_MATCH' : 'SNAPSHOT_DRIFT',
    generatedAt: new Date().toISOString(),
    sourceRoot,
    sourceDigest: digest,
    audited: files.length,
    untrackedIncluded: files.filter((file) => file.gitState === 'untracked').length,
    excluded,
    problems,
    files,
    limitations: ['Verifies listed files only; not a completeness or acceptance verdict.',
      'No files are copied, moved, deleted, staged or deployed.',
      'Environment files and generated outputs are excluded, including .env.example.'],
  };
}

module.exports = { within, parseInventory, isProductPath, forbidden, auditInventory };

if (require.main === module) {
  try {
    const [sourceRoot, inventoryFile, reportFile] = process.argv.slice(2);
    if (!sourceRoot || !inventoryFile || !reportFile) {
      throw new Error('Usage: node verify-inventory.cjs <repo-root> <inventory.tsv> <report.json>');
    }
    const report = auditInventory(sourceRoot, parseInventory(fs.readFileSync(inventoryFile, 'utf8')));
    const reportPath = path.resolve(reportFile);
    if (!within(fs.realpathSync(sourceRoot), reportPath) || fs.existsSync(reportPath)) {
      throw new Error('Report must be a new file within the source workspace');
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, audited: report.audited,
      untrackedIncluded: report.untrackedIncluded, drifted: report.problems.length, sourceDigest: report.sourceDigest }));
    if (report.problems.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Inventory verification failed');
    process.exitCode = 1;
  }
}

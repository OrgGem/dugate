const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseInventory, forbidden, auditInventory } = require('./verify-inventory.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'du-inventory-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('du-inventory-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const relative = 'du-rework/services/orchestrator/src/current.ts';
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, 'export const current = true;');
  return { root, absolute, row: { record_type: 'file', path: relative, git_state: 'untracked',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') } };
}

test('includes untracked product source without consulting HEAD', (t) => {
  const { root, row } = fixture(t);
  const report = auditInventory(root, [row]);
  assert.equal(report.status, 'SNAPSHOT_MATCH');
  assert.equal(report.untrackedIncluded, 1);
});

test('detects changed and missing source', (t) => {
  const { root, row, absolute } = fixture(t);
  fs.writeFileSync(absolute, 'changed');
  assert.equal(auditInventory(root, [row]).problems[0].kind, 'changed');
  fs.unlinkSync(absolute);
  assert.throws(() => auditInventory(root, [row]), /No product files/);
});

test('rejects source-root escape before filtering', (t) => {
  const { root, row } = fixture(t);
  assert.throws(() => auditInventory(root, [{ ...row, path: '../escape' }]), /escapes/);
});

test('rejects duplicate files and malformed hashes', (t) => {
  const { root, row } = fixture(t);
  assert.throws(() => auditInventory(root, [row, row]), /Duplicate/);
  assert.throws(() => auditInventory(root, [{ ...row, sha256: '' }]), /SHA-256/);
});

test('excludes environment files and generated/sensitive outputs', () => {
  for (const file of ['du-rework/.env.example', 'du-rework/services/x/.env',
    'du-rework/services/x/dist/main.js', 'du-rework/packages/x/node_modules/y/index.js',
    'du-rework/infra/provider.key']) assert.equal(forbidden(file), true);
});

test('parses BOM and rejects missing columns', () => {
  assert.equal(parseInventory('\uFEFFrecord_type\tpath\tgit_state\tsha256\nimport\tx\tu\ty\n').length, 0);
  assert.throws(() => parseInventory('record_type\tpath\n'), /Missing inventory field/);
});

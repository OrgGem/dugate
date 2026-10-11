'use strict';

const { readFileSync } = require('node:fs');

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class MockVaultFixtureError extends Error {
  constructor(message) {
    super('invalid mock vault fixture: ' + message);
    this.name = 'MockVaultFixtureError';
  }
}

function fail(message) {
  throw new MockVaultFixtureError(message);
}

function asObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label + ' must be an object');
  return value;
}

function asString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(label + ' must be a non-empty string');
  return value;
}

function asSegment(value, label) {
  const text = asString(value, label);
  if (!SEGMENT.test(text)) fail(label + ' must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');
  return text;
}

function asPrefix(value, label) {
  const text = asString(value, label);
  if (text.startsWith('/') || text.endsWith('/') || text.includes('//') || text.includes('..')) {
    fail(label + ' must be a relative prefix without traversal');
  }
  return text;
}

function asCount(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) fail(label + ' must be a positive integer');
  return value;
}

function asBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(label + ' must be a boolean');
  return value;
}

function asList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(label + ' must be an array');
  return value;
}

/** Fail-closed fixture parse: a malformed mockup must stop the boot, never half-seed. */
function loadFixture(fixturePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (error) {
    fail('cannot read ' + fixturePath + ': ' + error.message);
  }
  const root = asObject(parsed, 'fixture');
  const kv = asObject(root.kv, 'kv');
  const transit = asObject(root.transit, 'transit');
  const tokens = asObject(root.tokens, 'tokens');
  const keyRefs = asObject(transit.allowedKeyRefs, 'transit.allowedKeyRefs');
  const allowedKeyRefs = {};
  for (const [ref, name] of Object.entries(keyRefs)) {
    allowedKeyRefs[asString(ref, 'transit.allowedKeyRefs key')] = asSegment(name, 'transit.allowedKeyRefs value');
  }
  if (Object.keys(allowedKeyRefs).length === 0) fail('transit.allowedKeyRefs must not be empty');
  const metadataKeyRef = asString(transit.metadataKeyRef, 'transit.metadataKeyRef');
  const publicUploadKeyRef = asString(transit.publicUploadKeyRef, 'transit.publicUploadKeyRef');
  for (const ref of [metadataKeyRef, publicUploadKeyRef]) {
    if (!Object.prototype.hasOwnProperty.call(allowedKeyRefs, ref)) {
      fail(ref + ' must be present in transit.allowedKeyRefs');
    }
  }
  const fixture = {
    leaseDurationMs: asCount(root.leaseDurationMs, 'leaseDurationMs', 3600000),
    renewable: asBoolean(root.renewable, 'renewable', true),
    kv: {
      mount: asSegment(kv.mount, 'kv.mount'),
      allowedPrefix: asPrefix(kv.allowedPrefix, 'kv.allowedPrefix'),
      secrets: asList(kv.secrets, 'kv.secrets').map((entry, index) => {
        const item = asObject(entry, 'kv.secrets entry ' + index);
        return {
          path: asPrefix(item.path, 'kv.secrets path'),
          data: asObject(item.data, 'kv.secrets data'),
          versions: asCount(item.versions, 'kv.secrets versions', 1),
        };
      }),
    },
    transit: {
      mount: asSegment(transit.mount, 'transit.mount'),
      keys: asList(transit.keys, 'transit.keys').map((entry, index) => {
        const item = asObject(entry, 'transit.keys entry ' + index);
        return {
          name: asSegment(item.name, 'transit.keys name'),
          versions: asCount(item.versions, 'transit.keys versions', 1),
        };
      }),
      allowedKeyRefs,
      metadataKeyRef,
      publicUploadKeyRef,
    },
    tokens: {
      kv: asString(tokens.kv, 'tokens.kv'),
      encrypt: asString(tokens.encrypt, 'tokens.encrypt'),
      decrypt: asString(tokens.decrypt, 'tokens.decrypt'),
    },
  };
  const tokenValues = Object.values(fixture.tokens);
  if (new Set(tokenValues).size !== tokenValues.length) fail('tokens must be distinct');
  return fixture;
}

module.exports = { MockVaultFixtureError, loadFixture };

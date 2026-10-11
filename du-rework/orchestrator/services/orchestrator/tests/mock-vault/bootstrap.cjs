'use strict';

// DU_VAULT_MOCK gate shared by the jest globalSetup and scripts/dev.cjs.
//
// When DU_VAULT_MOCK=true the in-process mock Vault (mock-vault-service.cjs,
// seeded from mock-vault.json) boots on loopback and the DU_VAULT_* variables
// the Orchestrator reads are pointed at it, so local dev and offline tests
// need no live Vault. The flag is strict: any value other than true/false
// fails the boot instead of guessing, matching the repo-wide env discipline
// (boot-options.ts readBoolean).

const path = require('node:path');
const { startMockVaultService } = require('./mock-vault-service.cjs');

const MOCK_ENV = 'DU_VAULT_MOCK';
const FIXTURE_ENV = 'DU_VAULT_MOCK_FIXTURE';

function readStrictBoolean(env, name) {
  const raw = env[name];
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(name + ' must be true or false, got ' + JSON.stringify(raw));
}

/**
 * Boot the mock Vault and point the Orchestrator env seams at it.
 * Returns the live service (so callers can stop it), or undefined when the
 * flag is off. Throws on a malformed flag or fixture: the boot fails closed.
 */
async function applyMockVaultEnv(env = process.env) {
  if (!readStrictBoolean(env, MOCK_ENV)) return undefined;
  const fixturePath = env[FIXTURE_ENV] !== undefined && env[FIXTURE_ENV].length > 0
    ? path.resolve(env[FIXTURE_ENV])
    : path.join(__dirname, 'mock-vault.json');
  const service = await startMockVaultService({ fixturePath });
  const patch = {
    DU_VAULT_KV_OPTIONS: JSON.stringify({
      vaultAddress: service.url,
      kvMount: service.kvMount,
      requestTimeoutMs: 5000,
    }),
    DU_VAULT_KV_TOKEN: service.tokens.kv,
    DU_VAULT_TRANSIT_OPTIONS: JSON.stringify({
      vaultAddress: service.url,
      allowedKeyRefs: service.allowedKeyRefs,
      transitMount: service.transitMount,
      metadataKeyRef: service.metadataKeyRef,
      publicUploadKeyRef: service.publicUploadKeyRef,
      requestTimeoutMs: 5000,
    }),
    DU_VAULT_TRANSIT_ENC_TOKEN: service.tokens.encrypt,
    DU_VAULT_TRANSIT_DEC_TOKEN: service.tokens.decrypt,
  };
  if (env.DU_METADATA_PLAINTEXT_READ_MODE === undefined) {
    patch.DU_METADATA_PLAINTEXT_READ_MODE = 'forbid';
  }
  Object.assign(env, patch);
  return service;
}

module.exports = { MOCK_ENV, FIXTURE_ENV, applyMockVaultEnv, readStrictBoolean };

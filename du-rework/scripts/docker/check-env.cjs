#!/usr/bin/env node
// Read-only deployment configuration validation. Never print resolved secrets.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { validateRuntimeEnvironment } = require('../runtime-env.cjs');
try {
  const args = process.argv.slice(2);
  for (const arg of args) if (arg.startsWith('--') && !['--workflow', '--deploy'].includes(arg)) throw new Error('Unknown Docker check option');
  const file = path.resolve(args.find(arg => !arg.startsWith('--')) || '.env.docker');
  const env = { ...parseEnv(fs.readFileSync(file, 'utf8')), ...process.env };
  env.DU_DATA_MODE ||= 'real';
  env.DU_METADATA_PLAINTEXT_READ_MODE ||= 'forbid';
  validateRuntimeEnvironment(env, { workers: ['document-core', 'lc-checker', 'example-review'], workflow: args.includes('--workflow') });
  if (args.includes('--deploy')) validateDeploymentEnvironment(env);
  console.log('Docker runtime configuration: valid. Validate Compose rendering and provision business/profile/schema separately.');
} catch (error) {
  // Validation errors contain field names only; filesystem diagnostics can include paths.
  console.error(error.code ? 'Docker profile cannot be read.' : error.message);
  process.exitCode = 1;
}

function validateDeploymentEnvironment(env) {
  if (env.NODE_ENV !== 'production') throw new Error('NODE_ENV=production is required for deployment preflight');
  for (const key of ['DATABASE_URL', 'CONNECTOR_DATABASE_URL', 'REDIS_URL', 'DOCUMENT_CORE_DOCKER_REDIS_URL']) {
    if (!env[key]?.trim()) throw new Error(`${key} is required for external-service deployment`);
  }
  if (env.DOCUMENT_CORE_DOCKER_REDIS_URL !== env.REDIS_URL) {
    throw new Error('DOCUMENT_CORE_DOCKER_REDIS_URL must match REDIS_URL for the external deployment aggregate');
  }
  for (const key of [
    'DU_ORCHESTRATOR_RUNTIME_IDENTITY', 'DU_ORCHESTRATOR_RUNTIME_SLOT', 'DU_ORCHESTRATOR_RUNTIME_REVISION',
    'DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST', 'DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN',
    'CONNECTOR_RUNTIME_SLOT', 'CONNECTOR_RUNTIME_IDENTITY', 'CONNECTOR_REPLICA_ID',
    'CONNECTOR_RUNTIME_REVISION', 'CONNECTOR_RUNTIME_IMAGE_DIGEST', 'COST_CONTROL_CONNECTOR_TOKEN',
    'DU_CONNECTOR_BASE_URLS',
  ]) if (!env[key]?.trim()) throw new Error(`${key} is required for deployment preflight`);
  for (const key of ['DU_ORCHESTRATOR_RUNTIME_SLOT', 'CONNECTOR_RUNTIME_SLOT']) {
    if (!['blue', 'green'].includes(env[key])) throw new Error(`${key} must be blue or green`);
  }
  if (env.CONNECTOR_REPLICA_ID !== env.CONNECTOR_RUNTIME_IDENTITY) {
    throw new Error('CONNECTOR_REPLICA_ID must match CONNECTOR_RUNTIME_IDENTITY');
  }
  const digestKeys = [
    'DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST', 'CONNECTOR_RUNTIME_IMAGE_DIGEST',
    'DOCUMENT_CORE_IMAGE_DIGEST', 'LC_IMAGE_DIGEST', 'EXAMPLE_REVIEW_IMAGE_DIGEST',
  ];
  for (const key of digestKeys) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(env[key] || '')) throw new Error(`${key} must be an immutable repository image digest`);
  }
  let connectors;
  try { connectors = JSON.parse(env.DU_CONNECTOR_BASE_URLS); } catch { throw new Error('DU_CONNECTOR_BASE_URLS must be valid JSON'); }
  if (!connectors || typeof connectors !== 'object' || Array.isArray(connectors) || Object.keys(connectors).length === 0) {
    throw new Error('DU_CONNECTOR_BASE_URLS must be a non-empty connector-to-URL object');
  }
  for (const value of Object.values(connectors)) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('DU_CONNECTOR_BASE_URLS values must be absolute HTTP(S) URLs'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('DU_CONNECTOR_BASE_URLS values must be absolute HTTP(S) URLs');
    }
  }
  const workerTokens = JSON.parse(env.WORKER_IDENTITY_TOKENS_BY_BUSINESS || '{}');
  if (env.DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN === env.RUNTIME_TOKEN
      || env.DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN === env.ADMIN_TOKEN
      || env.DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN === env.COST_CONTROL_CONNECTOR_TOKEN
      || Object.values(workerTokens).includes(env.DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN)) {
    throw new Error('Orchestrator runtime-control token must be distinct from other service credentials');
  }
}

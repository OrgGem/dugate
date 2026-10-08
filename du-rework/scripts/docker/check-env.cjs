#!/usr/bin/env node
// Read-only deployment configuration validation. Never print resolved secrets.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { validateRuntimeEnvironment } = require('../runtime-env.cjs');
try {
  const args = process.argv.slice(2);
  for (const arg of args) if (arg.startsWith('--') && arg !== '--workflow') throw new Error('Unknown Docker check option');
  const file = path.resolve(args.find(arg => !arg.startsWith('--')) || '.env.docker');
  const env = { ...parseEnv(fs.readFileSync(file, 'utf8')), ...process.env };
  // Compose supplies these defaults when URLs are omitted.
  env.DATABASE_URL ||= 'postgresql://configured-by-compose';
  env.REDIS_URL ||= 'redis://valkey:6379';
  env.DU_DATA_MODE ||= 'real';
  env.DU_METADATA_PLAINTEXT_READ_MODE ||= 'forbid';
  validateRuntimeEnvironment(env, { workers: ['document-core', 'lc-checker', 'example-review'], workflow: args.includes('--workflow') });
  console.log('Docker runtime configuration: valid. Validate Compose rendering and provision business/profile/schema separately.');
} catch (error) {
  // Validation errors contain field names only; filesystem diagnostics can include paths.
  console.error(error.code ? 'Docker profile cannot be read.' : error.message);
  process.exitCode = 1;
}

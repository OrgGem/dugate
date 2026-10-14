'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const compose = fs.readFileSync(path.join(root, 'infra/docker-compose.vault-persistent.yml'), 'utf8');
const hcl = fs.readFileSync(path.join(root, 'infra/vault/server.hcl'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'infra/vault/bootstrap-persistent.ps1'), 'utf8');
const vaultIgnore = fs.readFileSync(path.join(root, 'infra/vault/.gitignore'), 'utf8');

test('optional Vault manifest is isolated, pinned, durable and loopback-only', () => {
  assert.match(compose, /hashicorp\/vault@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2/);
  assert.match(compose, /pull_policy: never/);
  assert.match(compose, /container_name: du-vault-persistent/);
  assert.match(compose, /profiles: \[persistent-vault\]/);
  assert.match(compose, /command: \[server\]/);
  assert.match(compose, /127\.0\.0\.1:\$\{DU_VAULT_HOST_PORT:-18200\}:8200/);
  assert.match(compose, /name: du-vault-persistent-data/);
  assert.match(compose, /vault-data:\/vault\/file/);
  assert.match(compose, /com\.dugate\.bootstrap-guard: exact-new-vault/);
  assert.doesNotMatch(compose, /8201:\s*8201|VAULT_DEV|dev-root-token/);
  assert.match(hcl, /storage "raft"/);
  assert.match(hcl, /path\s*=\s*"\/vault\/file"/);
  assert.match(hcl, /tls_disable\s*=\s*true/);
});

test('Vault bootstrap guards the new instance and persists protected init before unseal', () => {
  assert.match(bootstrap, /\$containerName = 'du-vault-persistent'/);
  assert.match(bootstrap, /\$expectedVolume = 'du-vault-persistent-data'/);
  assert.match(bootstrap, /\$baseUri = \[Uri\]'http:\/\/127\.0\.0\.1:18200'/);
  assert.match(bootstrap, /Test-PrivatePersistence\s+Assert-TargetContainer\s+Recover-InterruptedInitWrite/);
  assert.ok(bootstrap.indexOf("'/v1/sys/init'") < bootstrap.indexOf('Write-InitMaterial $initResponse.Raw'));
  assert.ok(bootstrap.indexOf('Write-InitMaterial $initResponse.Raw') < bootstrap.indexOf("'/v1/sys/unseal'"));
  assert.match(bootstrap, /function Wait-ForVaultReady[\s\S]*?\/v1\/sys\/health/);
  assert.match(bootstrap, /AddSeconds\(30\)/);
  assert.match(bootstrap, /FromSeconds\(2\)/);
  assert.match(bootstrap, /From-SecureString/);
  assert.match(bootstrap, /secret_shares = 5; secret_threshold = 3/);
  assert.match(bootstrap, /HTTP \{0\}/);
  assert.match(bootstrap, /Unexpected bootstrap failure \(type=\$exceptionType, line=\$scriptLine\)/);
  assert.doesNotMatch(bootstrap, /Write-(?:Host|Output)\s+\$init|Write-(?:Host|Output)\s+\$keys|docker\s+exec[^\r\n]*unseal/i);
  assert.match(vaultIgnore, /^local\/$/m);
  assert.match(vaultIgnore, /^\*\.dpapi\.txt$/m);
});

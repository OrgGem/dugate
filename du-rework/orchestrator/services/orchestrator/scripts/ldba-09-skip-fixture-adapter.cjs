'use strict';

const crypto = require('node:crypto');
const { createAdapter } = require('./ldba-03-production-adapter.cjs');

const OBJECTS = new Map([
  ['synthetic/cache/object-0', Buffer.from('synthetic-file-one')],
  ['synthetic/cache/object-1', Buffer.from('synthetic-file-two')],
]);

function fixtureContext() {
  return {
    resolveBusinessAction(slug) {
      if (slug !== 'analyze') return null;
      return { businessId: 'document', businessVersion: '1.0.0', action: 'analyze' };
    },
    async prepareConnector(row, request) {
      if (row.authType === 'BASIC_AUTH') {
        return {
          skipped: true,
          code: 'CONNECTOR_ROW_OUT_OF_SCOPE',
          reason: 'synthetic fixture uses an unsupported auth mode outside the v1 connector scope',
        };
      }
      const credentialRef = 'fixture-credential-ref:' + row.id;
      return {
        revision: {
          adapter: 'synthetic-fixture-adapter:' + row.id,
          connector_id: request.connectorId,
          tenant_id: '',
          revision: 1,
          state: request.state,
          credential_ref: credentialRef,
          config: request.config,
          credential_source: { kind: 'legacy-db', credentialRef },
          account_id: null,
        },
        secret: {
          id: 'fixture-secret-version:' + row.id,
          credential_ref: credentialRef,
          encrypted_value: Buffer.from('synthetic-fixture-ciphertext:' + row.id, 'utf8'),
        },
      };
    },
    resolveProfileName(row) {
      return 'fixture-profile-' + row.id;
    },
    normalizeConnectionsOverride(raw) {
      return Array.isArray(raw) ? raw : [];
    },
    async prepareWorkflowSchema(parsed) {
      const canonical = JSON.stringify(parsed);
      return {
        digest: 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex'),
        schemaRef: { kind: 'synthetic-fixture-envelope', canonical },
      };
    },
    async readFileCacheBytes(s3Key) {
      const bytes = OBJECTS.get(s3Key);
      if (!bytes) throw new Error('synthetic fixture object is missing');
      return Buffer.from(bytes);
    },
    artifactTokenFor(row, id) {
      return crypto.createHash('sha256').update('fixture-token:' + id).digest('hex');
    },
    artifactPurposeFor() {
      return 'input';
    },
    prepareAdminLocalUser() {
      return {
        pending: true,
        reason: 'synthetic legacy identity awaits user-presented plaintext for first-login rehash',
      };
    },
  };
}

function createFixtureAdapter(options = {}) {
  return createAdapter({ ...options, context: fixtureContext() });
}

const adapter = createFixtureAdapter();
module.exports = Object.assign(adapter, { createFixtureAdapter });

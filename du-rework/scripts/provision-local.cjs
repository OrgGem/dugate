#!/usr/bin/env node
/**
 * scripts/provision-local.cjs
 * Local development bootstrapping / provisioning script.
 * 
 * Sets up initial platform state:
 *  1. Provisions default tenants in PostgreSQL.
 *  2. Registers, enables, and activates Business Manifests (document-core, lc-checker, example-review).
 *  3. Issues a default dev API key for testing.
 *  4. Binds profiles for operations (ingest, extract, analyze, transform, generate, compare, etc.).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { Pool } = require(path.resolve(__dirname, '../orchestrator/services/orchestrator/node_modules/pg'));
const { enableAndActivateBusinessVersion } = require('./provision-local-activation.cjs');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.resolve(ROOT, '.env.local');
const env = {
  ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}),
  ...process.env,
};

const DATABASE_URL = env.DATABASE_URL || 'postgresql://du:du-test-only@localhost:5433/du_orchestrator';
const INTERNAL_URL = env.ORCHESTRATOR_INTERNAL_BASE_URL || 'http://127.0.0.1:3002';
const RUNTIME_TOKEN = env.RUNTIME_TOKEN || 'dev_runtime_token_super_secret_min_32_chars';
const ADMIN_TOKEN = env.ADMIN_TOKEN || 'dev_admin_token_super_secret_min_32_chars';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SECOND_TENANT_ID = '00000000-0000-0000-0000-000000000002';
const DEV_API_KEY = 'du_live_dev_test_api_key_1234567890abcdef';

async function main() {
  console.log('== DU-Gate Local Provisioning ==');
  console.log(`Database: ${DATABASE_URL}`);
  console.log(`Internal API: ${INTERNAL_URL}`);

  // 1. Provision Tenants
  console.log('\n[1/4] Provisioning Tenants in Database...');
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO tenants (id, name, state)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, state = 'ACTIVE'`,
      [DEFAULT_TENANT_ID, 'Default Organization']
    );
    console.log(`  + Tenant created: Default Organization (${DEFAULT_TENANT_ID})`);

    await pool.query(
      `INSERT INTO tenants (id, name, state)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, state = 'ACTIVE'`,
      [SECOND_TENANT_ID, 'Acme Corporation']
    );
    console.log(`  + Tenant created: Acme Corporation (${SECOND_TENANT_ID})`);
  } finally {
    await pool.end();
  }

  // 2. Register Business Manifests
  console.log('\n[2/4] Registering & Activating Business Manifests...');
  const manifests = [
    {
      name: 'document-core',
      manifest: require('../businesses/document-core/dist/manifest/document-core.manifest.js').documentCoreManifest,
    },
    {
      name: 'lc-checker',
      manifest: require('../businesses/lc-checker/dist/manifest.js').lcCheckerManifest,
    },
    {
      name: 'example-review',
      manifest: require('../businesses/example-review/dist/manifest.js').exampleReviewManifest,
    },
  ];

  for (const item of manifests) {
    const { businessId, version } = item.manifest;
    console.log(`  -> Processing ${businessId}@${version}...`);

    // Step A: PUT /api/runtime/v1/businesses/:id/versions/:v
    const regUrl = `${INTERNAL_URL}/api/runtime/v1/businesses/${businessId}/versions/${version}`;
    const regRes = await fetch(regUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(item.manifest),
    });

    if (![200, 201].includes(regRes.status)) {
      const err = await regRes.text().catch(() => '');
      throw new Error(`Failed to register ${businessId}@${version} (${regRes.status}): ${err}`);
    }
    console.log(`     - Registered (HTTP ${regRes.status})`);

    // Step B/C: use activation-revision CAS for enable and activation. Conflicts
    // stop provisioning for this business and require an operator refresh.
    const activation = await enableAndActivateBusinessVersion({
      fetchImpl: fetch,
      internalUrl: INTERNAL_URL,
      adminToken: ADMIN_TOKEN,
      businessId,
      version,
    });
    console.log(`     - Enabled (HTTP ${activation.enabled.status})`);
    console.log(`     - Activated (HTTP ${activation.activated.status})`);
  }

  // 3. Issue Dev API Key
  console.log('\n[3/4] Issuing Dev API Key for Default Organization...');
  const issueRes = await fetch(`${INTERNAL_URL}/api/v1/admin/actions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'apikey.issue',
      params: {
        tenantId: DEFAULT_TENANT_ID,
        apiKey: DEV_API_KEY,
        prefix: 'du_l',
      },
    }),
  });

  if (issueRes.status === 201) {
    console.log('  + API Key issued (value redacted)');
  } else if (issueRes.status === 409 || issueRes.status === 400 || issueRes.status === 500) {
    // If key already exists
    console.log(`  * API Key already exists or reported: ${issueRes.status}`);
  } else {
    const err = await issueRes.text().catch(() => '');
    console.log(`  ! Notice on apikey.issue (${issueRes.status}): ${err}`);
  }

  // 4. Bind Profiles
  console.log('\n[4/4] Binding Core Profiles to Dev API Key...');
  const coreActions = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'];
  for (const action of coreActions) {
    const bindRes = await fetch(`${INTERNAL_URL}/api/v1/admin/actions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'apikey.bind-profile',
        params: {
          apiKey: DEV_API_KEY,
          businessId: 'document-core',
          businessVersion: '1.1.0',
          action,
        },
      }),
    });
    if ([200, 201].includes(bindRes.status)) {
      console.log(`  + Profile bound for action: '${action}' -> document-core@1.1.0`);
    } else {
      const err = await bindRes.text().catch(() => '');
      console.log(`  ! Profile bind for '${action}' status: ${bindRes.status} (${err})`);
    }
  }

  // 5. Provision Sample Business Workflow
  console.log('\n[5/5] Provisioning Sample Business Workflow Schema...');
  const sampleWorkflowSchema = {
    slug: 'doc-processing-pipeline',
    name: 'Intelligent Document Processing Pipeline',
    version: 1,
    description: 'Quy trình xử lý tài liệu tự động: Tiếp nhận văn bản, trích xuất thực thể dữ liệu và kiểm tra tuân thủ chính sách.',
    input_schema: {
      type: 'object',
      properties: {
        document_type: { type: 'string', label: 'Loại tài liệu', description: 'Loại tài liệu xử lý (hóa đơn, hợp đồng, chứng từ)', default: 'contract' },
        priority: { type: 'string', label: 'Độ ưu tiên', default: 'normal' },
        auto_verify: { type: 'boolean', label: 'Tự động kiểm tra tuân thủ', default: true },
      },
    },
    nodes: [
      {
        id: 'ingest_step',
        type: 'connector',
        description: 'Tiếp nhận và chuẩn hóa tài liệu (Word, PDF, Scan)',
        connector: 'document-core',
        overrideConnector: {
          prompt: 'Ingest and normalize uploaded document format into structured text pages',
        },
      },
      {
        id: 'extract_step',
        type: 'connector',
        description: 'Trích xuất thực thể, bảng biểu và trường dữ liệu chính',
        connector: 'document-core',
        overrideConnector: {
          prompt: 'Extract structured metadata, key-value pairs, dates, amounts, and participants',
        },
      },
      {
        id: 'compliance_verify',
        type: 'connector',
        description: 'Kiểm tra quy tắc tuân thủ và phát hiện sai lệch điều khoản',
        connector: 'lc-checker',
        overrideConnector: {
          prompt: 'Verify clauses, check policy compliance and flag discrepancies against standard rules',
        },
      },
    ],
    flow: ['ingest_step', 'extract_step', 'compliance_verify'],
    output: {
      from: 'compliance_verify',
    },
  };

  const wfRes = await fetch(`${INTERNAL_URL}/api/v1/admin/actions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'workflow.provision',
      params: {
        tenantId: DEFAULT_TENANT_ID,
        schema: sampleWorkflowSchema,
      },
    }),
  });
  if ([200, 201].includes(wfRes.status)) {
    console.log(`  + Workflow schema provisioned: ${sampleWorkflowSchema.slug} (v1)`);
  } else {
    const err = await wfRes.text().catch(() => '');
    console.log(`  ! Workflow provision status: ${wfRes.status} (${err})`);
  }

  console.log('\n======================================================');
  console.log('✅ Local Provisioning Completed Successfully!');
  console.log(`- Default Tenant: ${DEFAULT_TENANT_ID} (Default Organization)`);
  console.log(`- Active Businesses: document-core (1.1.0), lc-checker (1.1.0), example-review (1.0.0)`);
  console.log(`- Sample Workflow: ${sampleWorkflowSchema.slug} (Active)`);
  console.log('- Dev API Key: configured (value redacted)');
  console.log(`- Portal URL: http://127.0.0.1:3001/admin/`);
  console.log('======================================================');
}

main().catch((err) => {
  console.error('\n❌ Provisioning failed:', err);
  process.exit(1);
});

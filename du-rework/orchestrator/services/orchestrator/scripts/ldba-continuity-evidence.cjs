'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { canonical } = require('./ldba-inventory.cjs');

const sha256 = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function assertSafe(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertSafe(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:value|prompt|credential|secret|password|token|ciphertext|raw|payload|body|content|headers|authorization|dsn|url|endpoint|bucket|config)$/i.test(key)) fail('UNSAFE_EVIDENCE_FIELD');
    assertSafe(child, `${path}.${key}`);
  }
}

function inventoryReceipt(report) {
  const receipt = {
    inventorySha256: report.inventorySha256,
    archivedSettingsSha256: report.archivedSettingsSha256,
    sourceSettingsDisposition: report.sourceSettingsDisposition,
    sourceRetirementEvidence: report.sourceRetirementEvidence,
    customerEvidence: report.customerEvidence,
  };
  assertSafe(receipt);
  return receipt;
}

async function appendEvidence(pool, input) {
  const { tenantId, sourceVersion, evidenceKind, sourceSha256, planSha256, targetSha256 = null, counts = {}, capabilities = {}, holds = [], receipt = {} } = input;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId || '') || !sourceVersion || !['inventory','reconciliation','backup','restore','runtime_probe','cutover_probe'].includes(evidenceKind)) fail('INVALID_EVIDENCE_SCOPE');
  if (!/^[a-f0-9]{64}$/.test(sourceSha256 || '') || !/^[a-f0-9]{64}$/.test(planSha256 || '') || (targetSha256 !== null && !/^[a-f0-9]{64}$/.test(targetSha256))) fail('INVALID_EVIDENCE_DIGEST');
  assertSafe(counts); assertSafe(capabilities); assertSafe(holds); assertSafe(receipt);
  const material = { tenantId, sourceVersion, evidenceKind, sourceSha256, planSha256, targetSha256, counts, capabilities, holds, receipt };
  const evidenceSha256 = sha256(material);
  await pool.query(`INSERT INTO legacy_continuity_evidence
    (evidence_id,tenant_id,source_version,evidence_kind,source_sha256,plan_sha256,evidence_sha256,target_sha256,counts,capabilities,holds,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(tenant_id,source_version,evidence_kind,evidence_sha256) DO NOTHING`,
  [randomUUID(), tenantId, sourceVersion, evidenceKind, sourceSha256, planSha256, evidenceSha256, targetSha256,
    JSON.stringify(counts), JSON.stringify(capabilities), JSON.stringify(holds), JSON.stringify(receipt)]);
  const stored = await pool.query(`SELECT source_sha256,plan_sha256,target_sha256,counts,capabilities,holds,receipt
    FROM legacy_continuity_evidence WHERE tenant_id=$1 AND source_version=$2 AND evidence_kind=$3 AND evidence_sha256=$4`,
  [tenantId, sourceVersion, evidenceKind, evidenceSha256]);
  if (stored.rowCount !== 1) fail('EVIDENCE_APPEND_NOT_CONFIRMED');
  const row = stored.rows[0];
  if (row.source_sha256 !== sourceSha256 || row.plan_sha256 !== planSha256 || row.target_sha256 !== targetSha256 || sha256({ tenantId, sourceVersion, evidenceKind, sourceSha256, planSha256, targetSha256, counts: row.counts, capabilities: row.capabilities, holds: row.holds, receipt: row.receipt }) !== evidenceSha256) fail('EVIDENCE_REPLAY_MISMATCH');
  return { evidenceSha256, replayed: true };
}

async function appendInventoryEvidence(pool, report) {
  return appendEvidence(pool, {
    tenantId: report.tenantId,
    sourceVersion: report.sourceVersion,
    evidenceKind: 'inventory',
    sourceSha256: report.sourceSha256,
    planSha256: report.planSha256,
    targetSha256: report.inventorySha256,
    counts: report.targetCounts,
    capabilities: report.capabilities,
    holds: report.issues,
    receipt: inventoryReceipt(report),
  });
}

module.exports = { appendEvidence, appendInventoryEvidence, inventoryReceipt, assertSafe, sha256 };

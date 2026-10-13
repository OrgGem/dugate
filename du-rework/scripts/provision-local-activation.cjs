'use strict';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readActivationRevision(fetchImpl, stateUrl, adminToken) {
  const response = await fetchImpl(stateUrl, {
    method: 'GET',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (response.status !== 200) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Could not read business activation revision (${response.status}): ${detail}`);
  }
  const state = await response.json().catch(() => undefined);
  if (!isRecord(state) || !Number.isSafeInteger(state.activationRevision) || state.activationRevision < 1) {
    throw new Error('Business activation state did not contain a positive activationRevision');
  }
  return state.activationRevision;
}

async function putExpectedActivationRevision(fetchImpl, url, adminToken, expectedActivationRevision, action) {
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedActivationRevision }),
  });
  if (![200, 202].includes(response.status)) {
    const detail = await response.text().catch(() => '');
    const conflict = response.status === 409 || response.status === 422
      ? 'activation revision conflict; no automatic retry was attempted'
      : `HTTP ${response.status}`;
    throw new Error(`Failed to ${action} (${conflict}): ${detail}`);
  }
  const result = await response.json().catch(() => undefined);
  if (!isRecord(result) || !Number.isSafeInteger(result.activationRevision) || result.activationRevision < 1) {
    throw new Error(`Successful ${action} response omitted a positive activationRevision`);
  }
  return { status: response.status, result };
}

async function enableAndActivateBusinessVersion({ fetchImpl = fetch, internalUrl, adminToken, businessId, version }) {
  const stateUrl = `${internalUrl.replace(/\/$/, '')}/api/v1/admin/businesses/${encodeURIComponent(businessId)}/versions`;
  const enableUrl = `${stateUrl}/${encodeURIComponent(version)}/enable`;
  const activateUrl = `${stateUrl}/${encodeURIComponent(version)}/activate`;

  const beforeEnable = await readActivationRevision(fetchImpl, stateUrl, adminToken);
  const enabled = await putExpectedActivationRevision(
    fetchImpl,
    enableUrl,
    adminToken,
    beforeEnable,
    `enable ${businessId}@${version}`,
  );

  // Refresh only after our own enable succeeds. A failed CAS is surfaced to
  // the operator without silently rereading and overwriting a concurrent edit.
  const refreshedRevision = await readActivationRevision(fetchImpl, stateUrl, adminToken);
  if (refreshedRevision !== enabled.result.activationRevision) {
    throw new Error(
      `Activation revision changed after enabling ${businessId}@${version} `
      + `(enable returned ${enabled.result.activationRevision}, current ${refreshedRevision}); `
      + 'activation was not attempted',
    );
  }
  const activated = await putExpectedActivationRevision(
    fetchImpl,
    activateUrl,
    adminToken,
    enabled.result.activationRevision,
    `activate ${businessId}@${version}`,
  );
  return { enabled, activated };
}

module.exports = { enableAndActivateBusinessVersion };

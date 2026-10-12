import { expect, test, type Page } from '@playwright/test';
import {
  INCIDENT_ID,
  KEY_ONE,
  KEY_TWO,
  OPERATION_ONE,
  PROFILE_ONE,
  PROFILE_TWO,
  TENANT_ID,
  USER_ID,
  apiKeyLifecyclePage,
  identityAssignments,
  identitySnapshot,
  identityUser,
  identityUserMutationResult,
  identityUserPage,
  incidentDetail,
  incidentListPage,
  installAdminApi,
  logServedAssets,
  maintenanceJob,
  maintenancePreview,
  maintenanceSuppressions,
  operationDetail,
  operationsPage,
  platformAdminSession,
  queueInventory,
  serviceInventory,
  signInAndOpen,
  tenantUserSession,
  waitForCall,
  type ApiCall,
  type ApiReply,
} from './orv14-full-admin-fixtures';

/**
 * ORV14 full Admin UI contract slice. The normal private shell serves a
 * verifier-owned Vite bundle; this spec intercepts only Admin API responses.
 * It verifies browser rendering, form state and request construction. It does
 * not claim PostgreSQL authorization, provider effects, or durable outcomes;
 * those require the independent API/PG receipts.
 */

const CORRELATION = 'orv14-correlation-001';
const PASSWORD_SENTINEL = 'orv14-password-sentinel-never-render-this';

function expectWrite(call: ApiCall): void {
  expect(call.csrfPresent, `${call.method} ${call.path} must carry the current CSRF token`).toBe(true);
  expect(call.idempotencyKeyPresent, `${call.method} ${call.path} must carry a fresh idempotency key`).toBe(true);
}

async function expectFixtureHandled(page: Page, unhandled: string[]): Promise<void> {
  expect(unhandled, 'all Admin API reads in this UI journey must have an explicit fixture').toEqual([]);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(PASSWORD_SENTINEL);
}

test.describe('ORV14 full Admin served UI contract', () => {
  test('operations keeps server totals/cursors and opens a correlation detail from a direct link', async ({ page }) => {
    const fixture = await installAdminApi(page, (call) => {
      if (call.method === 'GET' && call.path === '/admin/api/operations') {
        return { body: operationsPage(call.query.get('cursor')) };
      }
      if (call.method === 'GET' && call.path === `/admin/api/operations/${OPERATION_ONE}`) {
        return { body: operationDetail() };
      }
      if (call.method === 'GET' && call.path === `/admin/api/operations/${OPERATION_ONE}/deliveries`) {
        return { body: { items: [] } };
      }
      if (call.method === 'GET' && call.path === `/admin/api/operations/${OPERATION_ONE}/download`) {
        return { body: { accepted: true }, headers: { 'content-disposition': 'attachment; filename="result.json"' } };
      }
      return undefined;
    });

    await signInAndOpen(page, `operations?operation=${OPERATION_ONE}`);
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
    await expect(page.getByText('1005 total', { exact: false })).toBeVisible();
    await expect(page.getByText(CORRELATION, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download result' })).toHaveAttribute('href', `/admin/api/operations/${OPERATION_ONE}/download`);

    const firstPage = fixture.calls.find((call) => call.method === 'GET' && call.path === '/admin/api/operations');
    expect(firstPage?.query.get('tenant')).toBe(TENANT_ID);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const secondPage = await waitForCall(fixture, 'GET', '/admin/api/operations');
    expect(secondPage.query.get('cursor')).toBeTruthy();
    expect(secondPage.query.get('tenant')).toBe(TENANT_ID);

    logServedAssets(fixture, 'ORV14_FULL_ADMIN_OPERATIONS');
    await expectFixtureHandled(page, fixture.unhandled);
  });

  test('Identity replaces the complete USER key/Profile set and activates the marked legacy account through staged reset', async ({ page }) => {
    let currentUser = identityUser({ enabled: false, legacyPasswordResetRequired: true, version: 4 });
    let currentAssignments = identityAssignments(6, [PROFILE_ONE], [KEY_ONE]);
    const fixture = await installAdminApi(page, (call): ApiReply | undefined => {
      if (call.method === 'GET' && call.path === '/admin/api/identity') return { body: identitySnapshot() };
      if (call.method === 'GET' && call.path === '/admin/api/identity/users') return { body: identityUserPage(currentUser) };
      if (call.method === 'GET' && call.path === '/admin/api/parity/api-keys') return { body: apiKeyLifecyclePage() };
      if (call.method === 'GET' && call.path === `/admin/api/identity/users/${USER_ID}/assignments`) return { body: currentAssignments };
      if (call.method === 'PUT' && call.path === `/admin/api/identity/users/${USER_ID}/assignments`) {
        currentAssignments = identityAssignments(7, [PROFILE_ONE, PROFILE_TWO], [KEY_ONE, KEY_TWO]);
        return { body: currentAssignments };
      }
      if (call.method === 'POST' && call.path === `/admin/api/identity/users/${USER_ID}/password`) {
        currentUser = identityUser({ enabled: true, legacyPasswordResetRequired: false, version: 5 });
        return { body: identityUserMutationResult(currentUser) };
      }
      return undefined;
    });

    await signInAndOpen(page, 'identity');
    await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Replace assignments' })).toBeVisible();
    await page.getByRole('checkbox', { name: new RegExp(KEY_TWO) }).check();
    await page.getByRole('checkbox', { name: new RegExp(PROFILE_TWO) }).check();
    await page.getByRole('button', { name: 'Replace full assignment set' }).click();
    const assignmentWrite = await waitForCall(fixture, 'PUT', `/admin/api/identity/users/${USER_ID}/assignments`);
    expectWrite(assignmentWrite);
    expect(assignmentWrite.query.get('tenantId')).toBe(TENANT_ID);
    expect(assignmentWrite.body).toMatchObject({ expectedVersion: 6, profileIds: [PROFILE_ONE, PROFILE_TWO], apiKeyIds: [KEY_ONE, KEY_TWO] });
    await expect(page.getByText('The complete Profile and API-key assignment set was replaced and read back.')).toBeVisible();

    await page.getByLabel('New password').fill(PASSWORD_SENTINEL);
    await page.getByRole('button', { name: 'Set password, activate, revoke sessions' }).click();
    const resetWrite = await waitForCall(fixture, 'POST', `/admin/api/identity/users/${USER_ID}/password`);
    expectWrite(resetWrite);
    expect(resetWrite.query.get('tenantId')).toBe(TENANT_ID);
    expect(resetWrite.body).toMatchObject({ expectedVersion: 4, password: PASSWORD_SENTINEL });
    await expect(page.getByText(/active with the new password; existing sessions were revoked/)).toBeVisible();
    await expectFixtureHandled(page, fixture.unhandled);
    logServedAssets(fixture, 'ORV14_FULL_ADMIN_IDENTITY');
  });

  test('incident acknowledgement leaves an active source open and resolution requires matching recovery evidence', async ({ page }) => {
    let incident = incidentDetail('open', false);
    let sourceRecovered = false;
    const fixture = await installAdminApi(page, (call): ApiReply | undefined => {
      if (call.method === 'GET' && call.path === '/admin/api/incidents') return { body: incidentListPage(incident.incident.status) };
      if (call.method === 'GET' && call.path === '/admin/api/incidents/maintenance-suppressions') return { body: maintenanceSuppressions() };
      if (call.method === 'GET' && call.path === `/admin/api/incidents/${INCIDENT_ID}`) {
        if (sourceRecovered && incident.incident.status === 'acknowledged') incident = incidentDetail('acknowledged', true);
        return { body: incident };
      }
      if (call.method === 'GET' && (call.path === '/admin/api/identity/platform-assignable-users' || call.path === '/admin/api/identity/assignable-users')) {
        return { body: { items: [], nextCursor: null, total: 0, limit: 100 } };
      }
      if (call.method === 'POST' && call.path === `/admin/api/incidents/${INCIDENT_ID}/acknowledge`) {
        incident = incidentDetail('acknowledged', false);
        return { body: incident };
      }
      if (call.method === 'POST' && call.path === `/admin/api/incidents/${INCIDENT_ID}/resolve`) {
        incident = incidentDetail('resolved', true);
        return { body: incident };
      }
      return undefined;
    });

    await signInAndOpen(page, `system-operations/incidents?incident=${INCIDENT_ID}`);
    await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();
    await page.getByLabel('Acknowledgement note').fill('Response started; awaiting the worker source recovery sample.');
    await page.getByRole('button', { name: 'Acknowledge incident' }).click();
    const ack = await waitForCall(fixture, 'POST', `/admin/api/incidents/${INCIDENT_ID}/acknowledge`);
    expectWrite(ack);
    expect(ack.body).toMatchObject({ expectedVersion: 1, reason: expect.any(String) });
    await expect(page.getByRole('button', { name: 'Resolve with evidence' })).toBeDisabled();
    await expect(page.getByText('It remains open until source recovery evidence is confirmed.')).toBeVisible();

    sourceRecovered = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByLabel('Verified recovery evidence')).toContainText('Source recovered');
    await page.getByLabel('Resolution note').fill('Fresh source recovery evidence is present.');
    await page.getByRole('button', { name: 'Resolve with evidence' }).click();
    const resolution = await waitForCall(fixture, 'POST', `/admin/api/incidents/${INCIDENT_ID}/resolve`);
    expectWrite(resolution);
    expect(resolution.body).toMatchObject({ expectedVersion: 2, evidenceEventId: expect.any(String), reason: expect.any(String) });
    expect(resolution.body).toMatchObject({ evidenceEventId: '77777777-7777-4777-8777-777777777772' });
    await expect(page.getByText('Incident resolved with recorded source evidence.')).toBeVisible();
    await expectFixtureHandled(page, fixture.unhandled);
    logServedAssets(fixture, 'ORV14_FULL_ADMIN_INCIDENTS');
  });

  test('maintenance requires preview first and renders the durable UNKNOWN per-item outcome without claiming success', async ({ page }) => {
    const fixture = await installAdminApi(page, (call): ApiReply | undefined => {
      if (call.method === 'GET' && call.path === '/admin/api/maintenance/services') return { body: serviceInventory() };
      if (call.method === 'GET' && call.path === '/admin/api/maintenance/queues') return { body: queueInventory() };
      if (call.method === 'POST' && call.path === '/admin/api/maintenance/previews') return { body: maintenancePreview() };
      if (call.method === 'POST' && call.path === '/admin/api/maintenance/jobs') return { body: maintenanceJob() };
      if (call.method === 'GET' && call.path === '/admin/api/maintenance/jobs/orv14-backup-job-unknown-1') return { body: maintenanceJob() };
      return undefined;
    });

    await signInAndOpen(page, 'system-operations/maintenance');
    await expect(page.getByRole('heading', { name: 'Preview maintenance job' })).toBeVisible();
    await page.getByLabel('Job type').selectOption('backup');
    await page.getByLabel('Approved backup target').fill('orv14-synthetic-allowlisted-target');
    await page.getByLabel('Reason').fill('Verify durable per-item outcomes in the Admin UI.');
    await page.getByRole('button', { name: 'Preview targets' }).click();
    const preview = await waitForCall(fixture, 'POST', '/admin/api/maintenance/previews');
    expectWrite(preview);
    expect(preview.body).toMatchObject({ kind: 'backup', scope: { kind: 'platform' }, filters: { backupTarget: 'orv14-synthetic-allowlisted-target' } });
    await expect(page.getByText('backup preview', { exact: false })).toBeVisible();
    await expect(page.getByText('UNKNOWN', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Create durable backup job' }).click();
    const start = await waitForCall(fixture, 'POST', '/admin/api/maintenance/jobs');
    expectWrite(start);
    expect(start.body).toMatchObject({ previewId: 'orv14-backup-preview-1', expectedVersion: 'a'.repeat(64), reason: 'Verify durable per-item outcomes in the Admin UI.' });
    await expect(page.getByRole('heading', { name: /Maintenance job/ })).toBeVisible();
    await expect(page.getByText('ACK_UNKNOWN', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Maintenance per-item outcomes' }).getByText('UNKNOWN', { exact: true })).toBeVisible();
    await expectFixtureHandled(page, fixture.unhandled);
    logServedAssets(fixture, 'ORV14_FULL_ADMIN_MAINTENANCE');
  });

  test('local USER sees a tenant-scoped operation page and receives no incident-wide read surface', async ({ page }) => {
    const fixture = await installAdminApi(page, (call) => {
      if (call.method === 'GET' && call.path === '/admin/api/operations') return { body: operationsPage(call.query.get('cursor'), 'FAILED') };
      if (call.method === 'GET' && call.path === `/admin/api/operations/${OPERATION_ONE}`) return { body: operationDetail() };
      return undefined;
    }, tenantUserSession());

    await signInAndOpen(page, 'operations');
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
    const list = fixture.calls.find((call) => call.method === 'GET' && call.path === '/admin/api/operations');
    expect(list?.query.get('tenant')).toBe(TENANT_ID);
    await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeDisabled();

    await page.goto(`${process.env.AWEB01B_URL}admin/system-operations/incidents?incident=${INCIDENT_ID}`);
    await expect(page.getByRole('heading', { name: 'Incident access unavailable' })).toBeVisible();
    expect(fixture.calls.some((call) => call.path === '/admin/api/incidents' || call.path === `/admin/api/incidents/${INCIDENT_ID}`)).toBe(false);
    await expectFixtureHandled(page, fixture.unhandled);
    logServedAssets(fixture, 'ORV14_FULL_ADMIN_LOCAL_USER_SCOPE');
  });
});

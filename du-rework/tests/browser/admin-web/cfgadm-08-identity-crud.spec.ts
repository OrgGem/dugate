import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

type Role = 'ADMIN' | 'USER' | 'VIEWER';
interface UserRow {
  id: string;
  username: string;
  role: Role;
  enabled: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const SAMPLE_CIPHER = 'fixture-cipher-must-never-render';

test.describe('CFGADM-08 identity user and OIDC metadata surface', () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !TOKEN) {
      throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN must be set');
    }
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  async function loginAndOpenIdentity(page: Page): Promise<void> {
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await page.fill('input[name="token"]', TOKEN);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === '/admin');
    await page.goto(`${BASE}/admin/web/identity`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Users & sessions' })).toBeVisible();
  }

  function screenshot(page: Page, name: string): Promise<void> {
    return page.screenshot({ path: join(EVIDENCE, name), fullPage: true }).then(() => undefined);
  }

  test('create, read back, update role, and render safe OIDC metadata', async ({ page }) => {
    const users: UserRow[] = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        username: 'alice',
        role: 'VIEWER',
        enabled: true,
        locked: false,
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-05T00:00:00.000Z',
        version: 1,
      },
    ];
    let writes = 0;
    await page.route('**/admin/api/identity**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/admin/api/identity') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            users,
            capabilities: { userWriter: true },
            auth: {
              mode: 'both',
              localEnabled: true,
              oidc: {
                issuer: 'https://id.example.test',
                clientId: 'du-admin-web',
                callbackUrl: 'https://admin.example.test/admin/oidc/callback',
                scopes: ['openid', 'profile', 'email'],
                clientSecret: SAMPLE_CIPHER,
              },
            },
            passwordHash: SAMPLE_CIPHER,
          }),
        });
        return;
      }

      expect(request.headers()['x-csrf-token']).toBeTruthy();
      expect(request.headers()['idempotency-key']).toBeTruthy();
      if (request.method() === 'POST' && url.pathname === '/admin/api/identity/users') {
        const body = request.postDataJSON() as { username: string; password: string; role: Role };
        expect(body.username).toBe('bob');
        expect(body.password).toBe('Example-Only-Password-123!');
        expect(body.role).toBe('USER');
        const created: UserRow = {
          id: '10000000-0000-4000-8000-000000000002',
          username: body.username,
          role: body.role,
          enabled: true,
          locked: false,
          createdAt: '2026-10-05T00:01:00.000Z',
          updatedAt: '2026-10-05T00:01:00.000Z',
          version: 1,
        };
        users.push(created);
        writes += 1;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ user: { ...created, passwordHash: SAMPLE_CIPHER } }),
        });
        return;
      }

      const updateMatch = /^\/admin\/api\/identity\/users\/([^/]+)$/.exec(url.pathname);
      if (request.method() === 'PATCH' && updateMatch !== null) {
        const body = request.postDataJSON() as { role: Role; enabled: boolean; expectedVersion: number };
        const target = users.find((user) => user.id === decodeURIComponent(updateMatch[1] ?? ''));
        expect(target).toBeDefined();
        expect(body.expectedVersion).toBe(target?.version);
        if (target === undefined) {
          await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
          return;
        }
        target.role = body.role;
        target.enabled = body.enabled;
        target.version += 1;
        target.updatedAt = '2026-10-05T00:02:00.000Z';
        writes += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { ...target, cipherText: SAMPLE_CIPHER } }),
        });
        return;
      }
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await loginAndOpenIdentity(page);
    await expect(page.getByText('https://id.example.test')).toBeVisible();
    await expect(page.getByText('du-admin-web')).toBeVisible();
    await expect(page.getByText(/alice/)).toBeVisible();
    await page.getByLabel('Username').fill('bob');
    await page.getByLabel('Initial password').fill('Example-Only-Password-123!');
    await page.getByLabel('Role').selectOption('USER');
    await page.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByText('User bob was created and read back.')).toBeVisible();
    await expect(page.getByText('bob', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit bob' }).click();
    await page.getByLabel('Role').selectOption('ADMIN');
    await page.getByRole('button', { name: 'Save user' }).click();
    await expect(page.getByText('User bob was updated and read back.')).toBeVisible();
    await expect(page.getByText('fixture-cipher-must-never-render')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(SAMPLE_CIPHER);
    expect(writes).toBe(2);
    await screenshot(page, 'cfgadm-08-users-created-role-updated-oidc-present.png');
  });

  test('shows explicit empty OIDC metadata state', async ({ page }) => {
    const user: UserRow = {
      id: '20000000-0000-4000-8000-000000000001',
      username: 'viewer',
      role: 'VIEWER',
      enabled: true,
      locked: false,
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
      version: 1,
    };
    await page.route('**/admin/api/identity**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          users: [user],
          capabilities: { userWriter: false },
          auth: { mode: 'local', localEnabled: true, oidc: null },
        }),
      });
    });
    await loginAndOpenIdentity(page);
    await expect(page.getByText('No OIDC metadata is configured or available.')).toBeVisible();
    await expect(page.getByText('https://id.example.test')).toHaveCount(0);
    await screenshot(page, 'cfgadm-08-oidc-metadata-absent.png');
  });

  test('fails closed when the server has no user writer', async ({ page }) => {
    let mutationRequests = 0;
    await page.route('**/admin/api/identity**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') mutationRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          users: [
            {
              id: '30000000-0000-4000-8000-000000000001',
              username: 'alice',
              role: 'VIEWER',
              enabled: true,
              locked: false,
              createdAt: '2026-10-05T00:00:00.000Z',
              updatedAt: '2026-10-05T00:00:00.000Z',
              version: 1,
            },
          ],
          capabilities: { userWriter: false },
          auth: { mode: 'both', localEnabled: true, oidc: null },
        }),
      });
    });
    await loginAndOpenIdentity(page);
    await expect(page.getByRole('alert').getByText(/server has not advertised an enabled local-user writer/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create user' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit alice' })).toBeDisabled();
    await expect(page.getByLabel('Username')).toBeDisabled();
    expect(mutationRequests).toBe(0);
    await screenshot(page, 'cfgadm-08-user-writer-absent-fail-closed.png');
  });
});

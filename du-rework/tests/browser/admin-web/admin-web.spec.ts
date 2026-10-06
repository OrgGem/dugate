import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * AWEB-01b — browser-level evidence for the mounted Admin Web (React) behind
 * the Orchestrator shell's per-route flag. Runs against the harness server
 * started by `harness.ts` (source seam, port 0, NODE_ENV=test) — NOT the live
 * stack. Screenshots land in coordination/evidence/aweb01b/.
 */
const BASE = process.env.AWEB01B_URL ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';

test.describe('AWEB-01b browser evidence (harness seam)', () => {
  test.beforeAll(() => {
    if (!BASE || !TOKEN || !EVIDENCE) {
      throw new Error('AWEB01B_URL / AWEB01B_TOKEN / AWEB01B_EVIDENCE must be set');
    }
  });

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  }

  /** Console-error collector: favicon 404s are excluded, anything else fails. */
  function trackConsole(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = msg.location().url ?? '';
      if (url.includes('favicon.ico')) return;
      errors.push(`${msg.text()} @ ${url}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    return errors;
  }

  /** Token login through the real shell form; lands on /admin (legacy redirect). */
  async function login(page: Page): Promise<void> {
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await page.fill('input[name="token"]', TOKEN);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === '/admin');
  }

  async function gotoApp(page: Page): Promise<void> {
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Orchestrator Portal bootstrap is running' })).toBeVisible();
  }

  test('1. direct unauth /admin/web -> 302 login; login form renders', async ({ page }) => {
    const redirect = await page.request.get(`${BASE}/admin/web`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()['location']).toBe('/admin/login');

    await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await expect(page).toHaveTitle(/Admin/);
    await shot(page, '01-unauth-login.png');
  });

  test('2. login -> React app renders; no serious console errors', async ({ page }) => {
    const errors = trackConsole(page);
    await login(page);
    await gotoApp(page);
    await expect(page).toHaveTitle('DUGate Admin');
    expect((await page.locator('#root').innerHTML()).length).toBeGreaterThan(200);
    await expect(page.getByRole('navigation', { name: 'Admin Web Navigation' })).toBeVisible();
    await expect(page.getByText('server-session gated')).toBeVisible();
    await expect(page.getByText('Admin Web bootstrap is running')).toBeVisible();
    await shot(page, '02-login-rendered.png');
    expect(errors).toEqual([]);
  });

  test('3. reload keeps the session and re-renders the app', async ({ page }) => {
    await login(page);
    await gotoApp(page);
    await page.reload({ waitUntil: 'networkidle' });
    expect(new URL(page.url()).pathname).toBe('/admin/web');
    await expect(page.getByRole('heading', { name: 'Orchestrator Portal bootstrap is running' })).toBeVisible();
    await shot(page, '03-reload.png');
  });

  test('4. 320px viewport: no horizontal overflow; nav reachable', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await gotoApp(page);
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await expect(page.getByRole('navigation', { name: 'Admin Web Navigation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Bootstrap' })).toBeVisible();
    await shot(page, '04-320px-reflow.png');
  });

  test('5. keyboard: Tab reaches a control with a visible focus ring', async ({ page }) => {
    await login(page);
    await gotoApp(page);
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        tag: el.tagName,
        label: (el.textContent ?? '').trim().slice(0, 40),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(focus).not.toBeNull();
    expect(['A', 'BUTTON', 'INPUT']).toContain(focus!.tag);
    expect(focus!.label.length).toBeGreaterThan(0);
    expect(focus!.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(focus!.outlineWidth)).toBeGreaterThanOrEqual(1);
    await shot(page, '05-keyboard-focus.png');
  });

  test('6. theme: light + data-theme=dark render distinctly', async ({ page }) => {
    await login(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoApp(page);
    const light = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
    }));
    await shot(page, '06-theme-light.png');

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
    }));
    expect(dark.bg).not.toBe(light.bg);
    expect(dark.color).not.toBe(light.color);
    await shot(page, '07-theme-dark.png');
  });
});

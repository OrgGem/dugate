import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * CFGADM-UI-PORT-P1 - browser evidence for the Settings port (CFGADM-01/02/03/04).
 *
 * There is no settings wire and no writer action in this tree, so the ONLY honest states
 * are: catalog rendered, every write control disabled with its reason, no credential value
 * in the DOM. This spec pins exactly that, plus the standard 320px / keyboard / theme checks.
 *
 * Runner-confirmed infrastructure: tests/browser/admin-web/playwright.config.ts + harness.ts.
 * No runner, no dependency, no lockfile change. Needs AWEB01B_URL / AWEB01B_TOKEN /
 * AWEB01B_EVIDENCE like every sibling spec here. TEST ONLY.
 */

const BASE = process.env.AWEB01B_URL ?? "";
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? "";
const TOKEN = process.env.AWEB01B_TOKEN ?? "";

const SECRET_ROWS = ["ai_api_key", "openai_api_key", "s3_access_key", "s3_secret_key"];
const ALL_KEYS = [
  "ai_provider",
  "ai_api_key",
  "ai_model",
  "openai_api_key",
  "openai_base_url",
  "ai_image_prompt",
  "ai_pdf_prompt",
  "ai_docx_prompt",
  "ai_compare_prompt",
  "ai_generate_prompt",
  "s3_endpoint",
  "s3_bucket",
  "s3_access_key",
  "s3_secret_key",
  "s3_region",
  "s3_cache_ttl_hours",
  "api_secret_key",
];

test.describe("CFGADM-UI-PORT-P1 Settings port (real browser)", () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !TOKEN) {
      throw new Error("AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN must be set");
    }
    fs.mkdirSync(join(EVIDENCE, "cfgadm-port-p1"), { recursive: true });
  });

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(EVIDENCE, "cfgadm-port-p1", name), fullPage: true });
  }

  async function openSettings(page: Page): Promise<void> {
    await page.goto(`${BASE}/admin/web`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("input[name='token']")).toBeVisible();
    await page.fill("input[name='token']", TOKEN);
    await page.click("button[type='submit']");
    await page.waitForURL((url) => url.pathname === "/admin");
    await page.goto(`${BASE}/admin/web/settings`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  }

  test("1. three CFGADM groups render with all 17 legacy keys", async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole("heading", { name: "AI defaults (CFGADM-01)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Prompt defaults (CFGADM-02)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Storage and retention (CFGADM-03/04)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deployment catalog" })).toBeVisible();

    await expect(page.locator("[data-legacy-key]")).toHaveCount(17);
    for (const key of ALL_KEYS) {
      await expect(page.locator(`[data-legacy-key="${key}"]`)).toBeVisible();
    }
    await shot(page, "cfgadm-01-three-groups-17-keys.png");
  });

  test("2. every write control is disabled with an honest reason", async ({ page }) => {
    await openSettings(page);

    const apply = page.getByRole("button", { name: "Apply" });
    const replace = page.getByRole("button", { name: "Replace secret" });
    const retire = page.getByRole("button", { name: "Retire" });
    await expect(apply).toHaveCount(12);
    await expect(replace).toHaveCount(4);
    await expect(retire).toHaveCount(1);

    const buttons = page.locator("[data-write-reason]");
    await expect(buttons).toHaveCount(17);
    for (const name of ["Apply", "Replace secret", "Retire"]) {
      const group = page.getByRole("button", { name });
      const count = await group.count();
      for (let index = 0; index < count; index += 1) {
        const button = group.nth(index);
        await expect(button).toBeDisabled();
        const reason = await button.getAttribute("title");
        expect(reason).toBeTruthy();
        expect((reason ?? "").length).toBeGreaterThan(30);
        expect((reason ?? "").toLowerCase()).not.toContain("saved");
      }
    }
    await shot(page, "cfgadm-02-all-disabled-with-reasons.png");
  });

  test("3. secrets are labelled and no credential value reaches the DOM", async ({ page }) => {
    await openSettings(page);

    for (const key of SECRET_ROWS) {
      const row = page.locator(`[data-legacy-key="${key}"]`);
      await expect(row).toBeVisible();
      await expect(row.getByText("secret", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Replace secret" })).toBeDisabled();
    }

    // Nothing is editable, so no value can be read into or echoed from the DOM.
    await expect(page.locator("input")).toHaveCount(0);
    const html = await page.locator("body").innerHTML();
    expect(html).not.toContain("sk-");
    expect(html).not.toContain("AKIA");
    await shot(page, "cfgadm-03-secrets-labelled-no-value.png");
  });

  test("4. the retire row is a decision, not a write target", async ({ page }) => {
    await openSettings(page);
    const row = page.locator(`[data-legacy-key="api_secret_key"]`);
    await expect(row).toBeVisible();
    await expect(row.getByText("retire", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Retire" })).toBeDisabled();
    const reason = await row.getByRole("button", { name: "Retire" }).getAttribute("title");
    expect(reason).toContain("CONT architect");
    await shot(page, "cfgadm-04-retire-decision.png");
  });

  test("5. 320px: the settings surface reflows without horizontal overflow", async ({ page }) => {
    await openSettings(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("[data-legacy-key]")).toHaveCount(17);
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, "cfgadm-05-320px-reflow.png");
  });

  test("6. keyboard: Tab reaches a control with a visible focus ring", async ({ page }) => {
    await openSettings(page);
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        label: (el.getAttribute("aria-label") || el.textContent || "").slice(0, 40),
        outlineWidth: parseFloat(style.outlineWidth) || 0,
        outlineStyle: style.outlineStyle,
      };
    });
    expect(focus).not.toBeNull();
    expect(focus?.tag).not.toBe("BODY");
    expect(focus?.outlineStyle).not.toBe("none");
    expect(focus?.outlineWidth ?? 0).toBeGreaterThan(0);
    await shot(page, "cfgadm-06-keyboard-focus.png");
  });
});

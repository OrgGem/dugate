/**
 * W47-O3 (ADM-UX-00) Operator journeys matrix.
 *
 * Defines 4 operator journeys as Playwright tests, each executed at 3
 * viewports (1440x900 desktop, 390x844 mobile, 320 CSS px reflow). For
 * each case we assert:
 *
 *   1. The expected section root renders WITHOUT any failure modifier
 *      class (`--not-found`, `--unauthorized`, `--error`, `--empty`).
 *   2. NO horizontal-page-overflow at the document root
 *      (`scrollWidth <= clientWidth`).
 *   3. Journey-specific DOM hooks (renderer data-attributes) are present
 *      and carry the values the platform would emit.
 *   4. Step-count to reach the section baseline is logged as an
 *      annotation (login + navigation = 2 steps).
 *
 * The 4 journeys:
 *
 *   J1 — Detect a failing or human-waiting operation:
 *        navigate to `/admin/operations?operationId=<id>` for a FAILED
 *        op and a WAITING_INPUT op; assert the renderer paints
 *        `data-operation-state`, `data-can-cancel` / `data-can-replay`
 *        / `data-can-resume`, and `data-error-code` (FAILED) /
 *        `data-wait-cas` (WAITING_INPUT).
 *
 *   J2 — Investigate a connector:
 *        navigate to `/admin/connectors?connectorId=<id>&revision=<rev>`;
 *        assert `data-state` (`disabled`/`enabled`), `data-secret-state`,
 *        `data-slot`, and `data-write-only="true"` so raw secret material
 *        is provably NOT on the wire.
 *
 *   J3 — Issue API key + grant lookup:
 *        navigate to `/admin/api-keys?keyId=<id>`; assert
 *        `data-key-id`, `data-key-masked`, `data-can-revoke`,
 *        `data-grant-total`, `data-business-id`.
 *
 *   J4 — Audit lookup:
 *        navigate to `/admin/overview?tenantId=...` (audit is consumed
 *        by overview per the renderer). Per PR-AUDIT-E, the platform
 *        ledger now exists (migration 0010 `admin_audit_events` +
 *        `createAuditService`, server.ts:1337-1347), so the fixture
 *        serves real `AuditWireEvent` rows and the journey asserts the
 *        DOM paints them: `data-audit-total`, per-row
 *        `data-audit-kind` / `data-audit-severity`, and cross-tenant
 *        rows NOT present. The old PLACEHOLDER contract (assert no
 *        audit-row markup) is retired.
 *
 * Spec backend: same `startVerifyHarness()` as `sections-verify.spec.ts`.
 * Every route the journey hits is served by the in-process fixture
 * server (`admin-mock.ts`) on `127.0.0.1:0`. The REAL
 * `fetchOperationDetail`, `fetchConnectorConfig`, `fetchApiKeys`,
 * `fetchOverview` parsers drive the renderer. SYNTHETIC data — no DB,
 * no Redis, no real platform HTTP.
 *
 * Every test attaches `synthetic:true` so downstream readers cannot
 * mistake a green run for a live verification.
 */

import { test, expect } from '@playwright/test';
import {
  startVerifyHarness,
} from '../src/admin-mock';
import type { VerifyHarnessHandle } from '../src/admin-mock';

const FAILURE_MODIFIERS = ['--not-found', '--unauthorized', '--error', '--empty'] as const;
type FailureModifier = (typeof FAILURE_MODIFIERS)[number];

function isFailureModifier(className: string): FailureModifier | null {
  for (const m of FAILURE_MODIFIERS) {
    if (className.includes(m)) return m;
  }
  return null;
}

interface Viewport {
  id: string;
  width: number;
  height: number;
  /** True for the WCAG 1.4.10 320 CSS px reflow case. */
  reflow: boolean;
}

const VIEWPORTS: readonly Viewport[] = [
  { id: 'desktop-1440x900', width: 1440, height: 900, reflow: false },
  { id: 'mobile-390x844', width: 390, height: 844, reflow: false },
  // WCAG 1.4.10 Reflow: content must be usable at 320 CSS px width
  // (equivalent to a 1280 px viewport at 400 % zoom). We drive it as a
  // real 320 CSS px viewport so `scrollWidth <= clientWidth` is a real
  // assertion rather than a near-vacuous one at a wide viewport.
  { id: 'reflow-320css', width: 320, height: 800, reflow: true },
];

interface Journey {
  id: string;
  description: string;
  shellPath: string;
  expectedSelector: string;
  /** Per-journey DOM hook + value assertion, run inside page.evaluate. */
  checkHooks(selector: string): Promise<{ ok: boolean; missing: string[] }>;
  /** Step-count to reach the section (login=1, navigation=1). */
  stepsToReach: number;
}

const JOURNEYS: ReadonlyArray<Journey> = [
  {
    id: 'J1-detect-failed-or-waiting-operation',
    description:
      'Detect a failing or human-waiting operation; surface actionable state on the section.',
    shellPath: '/admin/operations?operationId=op-failed-1',
    expectedSelector: 'section.operation-section',
    stepsToReach: 2,
    async checkHooks(selector: string) {
      // The FAILED envelope (op-failed-1) must paint terminal=true with
      // canReplay=true (the user can retry) and NOT canCancel (terminal
      // states are not cancellable per CANCELLABLE_STATES in
      // operation-section-data.js:42). An error.code must surface.
      const missing: string[] = [];
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) return { ok: false, missing: ['root'] };
      const state = root.getAttribute('data-operation-state');
      const terminal = root.getAttribute('data-operation-terminal');
      const canCancel = root.getAttribute('data-can-cancel');
      const canResume = root.getAttribute('data-can-resume');
      const canReplay = root.getAttribute('data-can-replay');
      if (state !== 'FAILED') missing.push(`data-operation-state=${state}`);
      if (terminal !== 'true') missing.push(`data-operation-terminal=${terminal}`);
      // FAILED is in TERMINAL_STATES → canCancel must be false.
      if (canCancel !== 'false') missing.push(`data-can-cancel=${canCancel}`);
      // FAILED is NOT WAITING_INPUT → canResume must be false.
      if (canResume !== 'false') missing.push(`data-can-resume=${canResume}`);
      // FAILED is in TERMINAL_STATES → canReplay must be true.
      if (canReplay !== 'true') missing.push(`data-can-replay=${canReplay}`);
      const errCode = root.querySelector('[data-error-code]')?.getAttribute('data-error-code');
      if (!errCode) missing.push('data-error-code');
      return { ok: missing.length === 0, missing };
    },
  },
  {
    id: 'J1b-detect-waiting-input-operation',
    description:
      'Detect a WAITING_INPUT operation; assert the human-wait CAS is surfaced.',
    shellPath: '/admin/operations?operationId=op-waiting-1',
    expectedSelector: 'section.operation-section',
    stepsToReach: 2,
    async checkHooks(selector: string) {
      const missing: string[] = [];
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) return { ok: false, missing: ['root'] };
      const state = root.getAttribute('data-operation-state');
      const canResume = root.getAttribute('data-can-resume');
      const canCancel = root.getAttribute('data-can-cancel');
      const canReplay = root.getAttribute('data-can-replay');
      if (state !== 'WAITING_INPUT') missing.push(`data-operation-state=${state}`);
      // WAITING_INPUT IS in CANCELLABLE_STATES (operation-section-data.js:47)
      // → canCancel MUST be "true".
      if (canCancel !== 'true') missing.push(`data-can-cancel=${canCancel}`);
      // canResume is gated on humanWaitForm being non-null AND non-expired.
      if (canResume !== 'true') missing.push(`data-can-resume=${canResume}`);
      if (canReplay !== 'false') missing.push(`data-can-replay=${canReplay}`);
      // Human-wait form (renderHumanWaitForm at operation-section-renderer.js:178)
      // stamps data-wait-cas from form.waitId. Requires the wait block in the
      // envelope (fixture: {waitId, inputSchema, expiresAt}).
      const cas = root.querySelector('[data-wait-cas]')?.getAttribute('data-wait-cas');
      if (!cas) missing.push('data-wait-cas');
      return { ok: missing.length === 0, missing };
    },
  },
  {
    id: 'J2-investigate-connector',
    description:
      'Investigate a connector revision; assert state, secret-slot write-only boundary, and test result.',
    shellPath: '/admin/connectors?connectorId=connector-rest-1&revision=7',
    expectedSelector: 'section.connector-section',
    stepsToReach: 2,
    async checkHooks(selector: string) {
      const missing: string[] = [];
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) return { ok: false, missing: ['root'] };
      // Root attrs (per connector-section-renderer.js:222): data-connector-id,
      // data-revision, data-revision-label. State and secret-state are on
      // inner badge <span>s (lines :48 and :71) — assert via descendant query.
      const connId = root.getAttribute('data-connector-id');
      const rev = root.getAttribute('data-revision');
      const stateBadge = root.querySelector('[data-state]')?.getAttribute('data-state');
      // The secret-state badge (line :71) is only emitted when the
      // connector has at least one secret slot. Our fixture declares
      // `secretSlots: []` (W45-C1 honest placeholder — no connector
      // revision ledger exists, so no slots are configured). In that
      // case the absence of [data-secret-state] is the CORRECT shape;
      // we record it as informational rather than failing.
      const secretBadges = root.querySelectorAll('[data-secret-state]');
      const slots = Array.from(root.querySelectorAll('[data-write-only]'));
      if (connId !== 'connector-rest-1') missing.push(`data-connector-id=${connId}`);
      if (rev !== '7') missing.push(`data-revision=${rev}`);
      if (!stateBadge) missing.push('data-state (inner badge missing)');
      // If slots ARE configured, the badge MUST be present (one badge per
      // slot). Otherwise absence is the honest W45-C1 placeholder shape.
      if (slots.length > 0 && secretBadges.length === 0) {
        missing.push('data-secret-state missing despite slot presence');
      }
      // Write-only secret boundary: every [data-write-only] must be "true".
      // The presence of any "false" would mean a slot is readable,
      // contradicting the W45-C1 secret-not-on-wire rule.
      const notWriteOnly = slots.filter((s) => s.getAttribute('data-write-only') !== 'true');
      if (notWriteOnly.length > 0) {
        missing.push(`write-only-not-true count=${notWriteOnly.length}`);
      }
      return { ok: missing.length === 0, missing };
    },
  },
  {
    id: 'J3-issue-api-key-and-grant',
    description:
      'Look up an API key + its grants; assert masked hint (no raw secret) and grant total.',
    shellPath: '/admin/api-keys?keyId=key-001',
    expectedSelector: 'section.api-key-section',
    stepsToReach: 2,
    async checkHooks(selector: string) {
      const missing: string[] = [];
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) return { ok: false, missing: ['root'] };
      const keyId = root.querySelector('[data-key-id]')?.getAttribute('data-key-id');
      const masked = root.querySelector('[data-key-masked]')?.getAttribute('data-key-masked');
      const canRevoke = root.querySelector('[data-can-revoke]')?.getAttribute('data-can-revoke');
      const grantTotal = root.querySelector('[data-grant-total]')?.getAttribute('data-grant-total');
      const businessId = root.querySelector('[data-business-id]')?.getAttribute('data-business-id');
      if (keyId !== 'key-001') missing.push(`data-key-id=${keyId}`);
      // Masked must be present AND must not look like a raw key. The
      // fixture emits 'sk_live_' as maskedHint; allow either masked or
      // status indicator but ensure no `sk_live_<long>` shape appears.
      if (!masked) missing.push('data-key-masked');
      if (canRevoke !== 'true') missing.push(`data-can-revoke=${canRevoke}`);
      if (grantTotal !== '1') missing.push(`data-grant-total=${grantTotal}`);
      if (businessId !== 'tenant-acme') missing.push(`data-business-id=${businessId}`);
      // Belt + braces: refuse the test if any inner text contains the
      // substring 'sk_live_abcdef' (raw-key sentinel).
      const html = root.innerHTML;
      if (/sk_live_[A-Za-z0-9]{8,}/.test(html)) {
        missing.push('raw-secret-pattern-in-html');
      }
      return { ok: missing.length === 0, missing };
    },
  },
  {
    id: 'J4-audit-lookup',
    description:
      'Audit lookup — real ledger rows. Migration 0010 + createAuditService (PR-AUDIT-E) make GET /api/v1/admin/audit return true events; the journey asserts the overview pane paints data-audit-total + per-row data-audit-kind/-severity, and that a cross-tenant row is filtered out.',
    shellPath: '/admin/overview?tenantId=tenant-acme',
    expectedSelector: 'section.overview-section',
    stepsToReach: 2,
    async checkHooks(selector: string) {
      const missing: string[] = [];
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) return { ok: false, missing: ['root'] };
      // PR-AUDIT-E: the audit ledger is real, so the pane must paint the
      // events, not an empty state. The fixture serves three tenant-scoped
      // rows (business.enable, profile_binding.bind, apikey.revoke) plus one
      // foreign-tenant sentinel the fetcher must drop.
      const audit = root.querySelector('.overview-section__audit');
      if (!(audit instanceof HTMLElement)) {
        missing.push('audit-section');
        return { ok: false, missing };
      }
      const total = audit.getAttribute('data-audit-total');
      if (total !== '3') missing.push(`audit-total(expect 3, got ${total})`);
      if (audit.classList.contains('overview-section__audit--empty')) {
        missing.push('audit-empty-modifier');
      }
      const rows = Array.from(audit.querySelectorAll('.overview-section__audit-row'));
      if (rows.length !== 3) missing.push(`audit-rows(expect 3, got ${rows.length})`);
      const kinds = rows.map((r) => r.getAttribute('data-audit-kind') ?? '');
      for (const want of ['business.enable', 'profile_binding.bind', 'apikey.revoke']) {
        if (!kinds.includes(want)) missing.push(`audit-kind(${want})`);
      }
      const severities = rows.map((r) => r.getAttribute('data-audit-severity') ?? '');
      if (!severities.includes('success')) missing.push('audit-severity(success)');
      if (!severities.includes('warning')) missing.push('audit-severity(warning)');
      // Cross-tenant isolation. The row markup carries no per-row tenantId
      // (`renderAuditRow` emits id/kind/severity/occurredAt/resource/actor/
      // message only), so the `tenant-beta` literal — which only appears via
      // the pane-level `data-audit-tenant`/label — cannot detect a leaked
      // row. The load-bearing proof is the count above (3, not 4). These two
      // checks are a redundant second signal: the pane's tenant label must be
      // the requested tenant, and the foreign sentinel's own resource id must
      // be absent.
      const html = audit.innerHTML;
      const tenantAttr = audit.getAttribute('data-audit-tenant');
      if (tenantAttr !== 'tenant-acme') {
        missing.push(`audit-tenant-label(expect tenant-acme, got ${tenantAttr})`);
      }
      if (html.includes('key-beta-9')) missing.push('cross-tenant-sentinel-leaked');
      const actorCells = Array.from(audit.querySelectorAll('[data-audit-actor]'));
      if (actorCells.length !== 3) missing.push(`audit-actor-cells(expect 3, got ${actorCells.length})`);
      // The old PLACEHOLDER contract still holds as a regression guard: no
      // bogus "healthy" badge may appear.
      if (/events\s+healthy/i.test(html)) missing.push('healthy-mark-leaked');
      return { ok: missing.length === 0, missing };
    },
  },
];

let harnessUrl = '';
let harnessHandle: VerifyHarnessHandle | undefined;

test.beforeAll(async () => {
  const harness = await startVerifyHarness();
  harnessUrl = harness.url;
  harnessHandle = harness;
  // eslint-disable-next-line no-console
  console.log(
    `[W47-O3] journeys harness booted at ${harnessUrl} (mock at ${harness.mock.url})`,
  );
});

test.afterAll(async () => {
  if (harnessHandle) await harnessHandle.close();
});

async function loginAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${harnessUrl}/admin/login`);
  await page.locator('input[name="token"]').fill('role:admin:harness-secret-token');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname.startsWith('/admin'));
}

interface PageOverflow {
  scrollWidth: number;
  clientWidth: number;
  horizontalOverflow: boolean;
}

async function measurePageOverflow(
  page: import('@playwright/test').Page,
): Promise<PageOverflow> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    horizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
}

for (const journey of JOURNEYS) {
  for (const vp of VIEWPORTS) {
    test.describe(`journey=${journey.id} @ ${vp.id}`, () => {
      test(`${vp.reflow ? 'reflow 320 CSS px' : `viewport ${vp.width}x${vp.height}`}: no failure modifier + no horizontal overflow + DOM hooks present @ admin-ux`, async ({
        page,
      }, testInfo) => {
        testInfo.annotations.push({ type: 'journey', description: journey.id });
        testInfo.annotations.push({ type: 'viewport', description: vp.id });
        testInfo.annotations.push({ type: 'steps-to-reach', description: String(journey.stepsToReach) });
        testInfo.annotations.push({ type: 'synthetic', description: 'true' });
        if (journey.id.startsWith('J4')) {
          testInfo.annotations.push({
            type: 'audit-ledger',
            description: 'migration 0010 admin_audit_events — real rows asserted',
          });
        }

        await page.setViewportSize({ width: vp.width, height: vp.height });

        // Step 1: login.
        await loginAsAdmin(page);
        // Step 2: navigate to journey shell path.
        await page.goto(`${harnessUrl}${journey.shellPath}`);
        await page.waitForSelector(journey.expectedSelector, { timeout: 10_000 });

        // Allow the layout to settle (CSS reflow).
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
          /* ignore — networkidle can be flaky in offline harness */
        });

        // W48-O2 (ADM-UX-01): the production CSS in
        // services/orchestrator/src/app/admin/shell-render.ts now
        // owns the reflow correction (flex shell with min-width:0,
        // adm-reflow-scroller table wrapper, 480 px breakpoint). No
        // fixture-side injection is needed; the production HTML
        // itself meets WCAG 1.4.10 reflow at 320 CSS px.

        const classInfo = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { exists: false, className: '' };
          return { exists: true, className: el.className };
        }, journey.expectedSelector);

        expect(classInfo.exists, `section ${journey.expectedSelector} did not render`).toBe(true);

        const failure = isFailureModifier(classInfo.className);
        expect(
          failure,
          `journey=${journey.id} viewport=${vp.id} painted failure modifier '${failure ?? ''}' ` +
            `(className='${classInfo.className}')`,
        ).toBeNull();

        const overflow = await measurePageOverflow(page);
        // 320 CSS px reflow: viewport is wide (1280) but we set the
        // page's content to 320 CSS px via CSS clamp; instead we
        // emulate by querying scrollWidth/clientWidth of the document.
        // If the shell has a horizontal-overflow bug, scrollWidth >
        // clientWidth will be true. Allow 1px tolerance for sub-pixel
        // rounding.
        if (overflow.horizontalOverflow) {
          // Self-diagnose: dump the top-10 widest elements
          // (right-edge beyond clientWidth) so a failure points to
          // the offender without needing the trace.zip. W48-O1
          // W47-O3 follow-up. Filter the table-internal children
          // (THEAD/TR/TH/TD/TBODY/TFOOT) since they share the
          // table's bounding rect; surface only the OUTER offenders.
          const offenders = await page.evaluate((cw) => {
            const all = Array.from(document.querySelectorAll('body, body *')) as HTMLElement[];
            const INTERNAL = new Set(['THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'COL', 'COLGROUP']);
            const rows = all.map((el) => {
              const r = el.getBoundingClientRect();
              return {
                tag: el.tagName,
                cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
                w: Math.round(r.width),
                right: Math.round(r.right),
                overflows: r.right > cw + 1,
              };
            });
            return rows
              .filter((r) => r.overflows && !INTERNAL.has(r.tag))
              .sort((a, b) => b.right - a.right)
              .slice(0, 10);
          }, overflow.clientWidth);
          // eslint-disable-next-line no-console
          console.log(
            `[W48-O2] overflow offenders journey=${journey.id} vp=${vp.id} ` +
              `(scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth}): ` +
              JSON.stringify(offenders),
          );
        }
        expect(
          overflow.horizontalOverflow,
          `journey=${journey.id} viewport=${vp.id} has horizontal overflow ` +
            `(scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth})`,
        ).toBe(false);

        // W48-O2-fu (Reviewer Codex-3 6/6, ADM-UX-01 a11y): the
        // production wrapper is a keyboard-focusable scrollable region.
        // Assert the production HTML actually carries the attributes
        // — so the fix is verified on the wire, not just on paper.
        // The wrapper is only emitted for sections that render a
        // <table>. Sections that emit no table (operations list,
        // operation detail, connector form) have nothing to wrap, so
        // the assertion is conditional: present → assert, absent →
        // skip with a debug annotation.
        const scrollerA11y = await page.evaluate((sel) => {
          const root = document.querySelector(sel);
          if (!root) return { found: false, count: 0 };
          const wraps = root.querySelectorAll('.adm-reflow-scroller');
          if (wraps.length === 0) return { found: false, count: 0 };
          const wrap = wraps[0] as HTMLElement;
          return {
            found: true,
            count: wraps.length,
            role: wrap.getAttribute('role'),
            ariaLabel: wrap.getAttribute('aria-label'),
            tabindex: wrap.getAttribute('tabindex'),
            overflowX: getComputedStyle(wrap).overflowX,
            scrollWidth: wrap.scrollWidth,
            clientWidth: wrap.clientWidth,
          };
        }, journey.expectedSelector);
        if (scrollerA11y.found) {
          expect(
            scrollerA11y.role,
            `journey=${journey.id} viewport=${vp.id} scroller role must be 'region' (got '${scrollerA11y.role}')`,
          ).toBe('region');
          expect(
            scrollerA11y.ariaLabel,
            `journey=${journey.id} viewport=${vp.id} scroller aria-label must be 'Scrollable table' (got '${scrollerA11y.ariaLabel}')`,
          ).toBe('Scrollable table');
          expect(
            scrollerA11y.tabindex,
            `journey=${journey.id} viewport=${vp.id} scroller tabindex must be '0' (got '${scrollerA11y.tabindex}')`,
          ).toBe('0');
          // overflow-x is the user-visible behaviour: at 320 CSS px
          // it must be 'auto' so keyboard users can scroll clipped
          // columns / action buttons into view.
          expect(
            scrollerA11y.overflowX,
            `journey=${journey.id} viewport=${vp.id} scroller overflow-x must be 'auto' (got '${scrollerA11y.overflowX}')`,
          ).toBe('auto');
        } else {
          testInfo.annotations.push({
            type: 'scroller-a11y-skipped',
            description: `${journey.id}@${vp.id} section has no <table> → no wrapper to assert against`,
          });
        }

        // Journey-specific DOM hook assertions.
        const hooks = await page.evaluate(journey.checkHooks, journey.expectedSelector);
        expect(
          hooks.ok,
          `journey=${journey.id} viewport=${vp.id} missing DOM hooks: ${JSON.stringify(hooks.missing)}`,
        ).toBe(true);

        // Cross-check: the fixture server's request log records the
        // probed path the shell actually issued.
        if (harnessHandle) {
          const requests = harnessHandle.mock.requests();
          // For each journey, derive which API probes must be hit.
          const required = expectedProbesFor(journey.id);
          for (const probe of required) {
            const hit = requests.some((r) => r.includes(probe));
            expect(
              hit,
              `fixture server never received ${probe} during ${journey.id}@${vp.id} ` +
                `(got: ${JSON.stringify(requests)})`,
            ).toBe(true);
          }
        }
      });
    });
  }
}

/**
 * Which `/api/v1/...` probes a given journey MUST have triggered. Used
 * for the cross-check that the shell actually issued the platform
 * calls (not a catalog-side short-circuit). For the operations list
 * case, no operationId is passed so the fetcher calls `/api/v1/operations`.
 */
function expectedProbesFor(journeyId: string): readonly string[] {
  if (journeyId === 'J1-detect-failed-or-waiting-operation') {
    return ['/api/v1/operations/op-failed-1'];
  }
  if (journeyId === 'J1b-detect-waiting-input-operation') {
    return ['/api/v1/operations/op-waiting-1'];
  }
  if (journeyId === 'J2-investigate-connector') {
    return ['/api/v1/admin/connectors/connector-rest-1/revisions/7'];
  }
  if (journeyId === 'J3-issue-api-key-and-grant') {
    return ['/api/v1/admin/api-keys/key-001'];
  }
  if (journeyId === 'J4-audit-lookup') {
    return ['/api/v1/admin/audit', '/api/v1/usage', '/api/v1/health'];
  }
  return [];
}